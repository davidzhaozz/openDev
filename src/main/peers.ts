import { ipcMain } from 'electron';
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createSocket, type Socket } from 'dgram';
import { spawn, type ChildProcess } from 'child_process';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join, relative, sep } from 'path';
import { tmpdir } from 'os';
import { IPC } from '@shared/ipc';
import type { AgentManifest, AgentRun, AgentRunStatus, AgentRunTarget, PeerInfo, PeersStatus } from '@shared/types';
import { loadSettings, patchSettings, getMachineId, getMachineName } from './storage.js';
import { safeSend } from './safeSend.js';
import { onShutdown } from './lifecycle.js';
import { workspace } from './workspace.js';
import { bundleRepo, applyBundle, peerRepoDir } from './git.js';
import { resolveBinPath } from './ai.js';

// LAN machine-linking. Two OpenDev IDE instances that share a link key discover
// each other over UDP broadcast and trust each other via HMAC — the raw key
// is never sent on the wire. Once linked, one can push its repo to the other
// and dispatch agent runs ("jobs") to it.

const DISCOVERY_PORT = 53826;          // fixed UDP port for announce packets
const ANNOUNCE_INTERVAL_MS = 3000;
const PRUNE_INTERVAL_MS = 4000;
const PEER_STALE_MS = 10_000;          // drop a peer not heard from in 10s
const AUTH_SKEW_MS = 30_000;           // reject requests with stale timestamps
const MAX_AGENT_BUNDLE = 25 * 1024 * 1024;  // cap on a packaged agent folder

type Announce = {
  t: 'opendev-announce';
  machineId: string;
  name: string;
  httpPort: number;
  keyHash: string;                     // HMAC(linkKey, machineId)
};

// One file inside a packaged agent folder, base64-encoded for JSON transport.
type PackedFile = { path: string; data: string };

function bodyHashOf(body: Buffer): string {
  return createHmac('sha256', 'opendev-body').update(body).digest('hex');
}

// Recursively collect a folder's files into PackedFile[], skipping .git and
// enforcing a total-size cap so a giant node_modules can't be shipped blindly.
async function packDir(dir: string): Promise<PackedFile[]> {
  const out: PackedFile[] = [];
  let total = 0;
  async function walk(cur: string): Promise<void> {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.git') continue;
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const data = await fs.readFile(abs);
        total += data.length;
        if (total > MAX_AGENT_BUNDLE) {
          throw new Error(`Agent folder exceeds ${MAX_AGENT_BUNDLE / 1024 / 1024}MB — too large to dispatch.`);
        }
        out.push({ path: relative(dir, abs).split(sep).join('/'), data: data.toString('base64') });
      }
    }
  }
  await walk(dir);
  return out;
}

async function unpackTo(files: PackedFile[], destDir: string): Promise<void> {
  for (const f of files) {
    // Guard against path traversal in a received payload.
    const rel = f.path.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) continue;
    const abs = join(destDir, rel);
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, Buffer.from(f.data, 'base64'));
  }
}

class PeerManager {
  private machineId = '';
  private machineName = getMachineName();
  private linkKey: string | undefined;
  private enabled = false;
  private httpServer: Server | null = null;
  private httpPort = 0;
  private udp: Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private peers = new Map<string, PeerInfo>();
  // runId -> in-flight remote run (the originating side: the streaming
  // response we're relaying to the renderer).
  private remoteRuns = new Map<string, { res: IncomingMessage }>();
  // runId -> child process spawned for an inbound dispatch (the executing
  // side), so a client disconnect can kill it.
  private inboundRuns = new Map<string, ChildProcess>();

  async init(): Promise<void> {
    this.machineId = await getMachineId();
    const s = await loadSettings();
    this.linkKey = s.linkKey;
    this.enabled = !!s.linkingEnabled;
    if (this.enabled && this.linkKey) {
      try { await this.startNetworking(); }
      catch (err) { console.error('[peers] start failed', err); }
    }
    onShutdown(() => this.stopNetworking());
  }

  private hmac(data: string): string {
    if (!this.linkKey) return '';
    return createHmac('sha256', this.linkKey).update(data).digest('hex');
  }

  private eq(a: string, b: string): boolean {
    if (a.length !== b.length || a.length === 0) return false;
    try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
  }

  status(): PeersStatus {
    return {
      machineId: this.machineId,
      machineName: this.machineName,
      linkingEnabled: this.enabled,
      hasLinkKey: !!this.linkKey,
      httpPort: this.httpPort || undefined
    };
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getPeer(machineId: string): PeerInfo | undefined {
    return this.peers.get(machineId);
  }

  private authHeaders(bodyHash: string): Record<string, string> {
    const ts = Date.now().toString();
    return {
      'X-OpenDev-Machine': this.machineId,
      'X-OpenDev-Ts': ts,
      'X-OpenDev-Auth': this.hmac(`${ts}.${bodyHash}`)
    };
  }

  async setLinkKey(key: string): Promise<boolean> {
    this.linkKey = key.trim() || undefined;
    await patchSettings({ linkKey: this.linkKey });
    await this.restartNetworking();
    return true;
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    this.enabled = enabled;
    await patchSettings({ linkingEnabled: enabled });
    await this.restartNetworking();
    return true;
  }

  private async restartNetworking(): Promise<void> {
    this.stopNetworking();
    if (this.enabled && this.linkKey) {
      try { await this.startNetworking(); }
      catch (err) { console.error('[peers] restart failed', err); }
    }
    safeSend(IPC.PeersChanged);
  }

  private async startNetworking(): Promise<void> {
    this.httpServer = createServer((req, res) => { void this.handleHttp(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(0, '0.0.0.0', () => {
        const addr = this.httpServer!.address();
        this.httpPort = (typeof addr === 'object' && addr) ? addr.port : 0;
        resolve();
      });
    });

    this.udp = createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('message', (msg, rinfo) => this.handleAnnounce(msg, rinfo.address));
    this.udp.on('error', (err) => console.error('[peers] udp error', err.message));
    await new Promise<void>((resolve) => {
      this.udp!.bind(DISCOVERY_PORT, () => {
        try { this.udp!.setBroadcast(true); } catch {}
        resolve();
      });
    });

    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.announce();
    console.log(`[peers] linking on — http :${this.httpPort}, discovery udp :${DISCOVERY_PORT}`);
  }

  private stopNetworking(): void {
    if (this.announceTimer) { clearInterval(this.announceTimer); this.announceTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.udp) { try { this.udp.close(); } catch {} this.udp = null; }
    if (this.httpServer) { try { this.httpServer.close(); } catch {} this.httpServer = null; }
    for (const proc of this.inboundRuns.values()) { try { proc.kill('SIGTERM'); } catch {} }
    this.inboundRuns.clear();
    this.httpPort = 0;
    if (this.peers.size > 0) { this.peers.clear(); safeSend(IPC.PeersChanged); }
  }

  private announce(): void {
    if (!this.udp || !this.linkKey) return;
    const payload: Announce = {
      t: 'opendev-announce',
      machineId: this.machineId,
      name: this.machineName,
      httpPort: this.httpPort,
      keyHash: this.hmac(this.machineId)
    };
    const buf = Buffer.from(JSON.stringify(payload));
    try { this.udp.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255'); } catch {}
  }

  private handleAnnounce(msg: Buffer, address: string): void {
    let data: Announce;
    try { data = JSON.parse(msg.toString('utf8')); } catch { return; }
    if (data?.t !== 'opendev-announce') return;
    if (typeof data.machineId !== 'string' || data.machineId === this.machineId) return;
    if (!this.eq(this.hmac(data.machineId), data.keyHash || '')) return;

    const existed = this.peers.has(data.machineId);
    this.peers.set(data.machineId, {
      machineId: data.machineId,
      name: typeof data.name === 'string' ? data.name : data.machineId,
      address,
      httpPort: typeof data.httpPort === 'number' ? data.httpPort : 0,
      lastSeen: Date.now(),
      online: true
    });
    if (!existed) safeSend(IPC.PeersChanged);
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_STALE_MS) { this.peers.delete(id); changed = true; }
    }
    if (changed) safeSend(IPC.PeersChanged);
  }

  private verifyRequest(req: IncomingMessage, bodyHash: string): boolean {
    const ts = String(req.headers['x-opendev-ts'] || '');
    const auth = String(req.headers['x-opendev-auth'] || '');
    if (!ts || !auth) return false;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > AUTH_SKEW_MS) return false;
    return this.eq(this.hmac(`${ts}.${bodyHash}`), auth);
  }

  // ── HTTP server (the executing side of a link) ───────────────────────
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);

    if (!this.linkKey || !this.verifyRequest(req, bodyHashOf(body))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const url = req.url || '/';
    try {
      if (req.method === 'POST' && url === '/link/hello') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ machineId: this.machineId, name: this.machineName, httpPort: this.httpPort }));
        return;
      }
      if (req.method === 'POST' && url === '/repo/push') {
        await this.handleRepoPush(req, res, body);
        return;
      }
      if (req.method === 'POST' && url === '/agent/dispatch') {
        await this.handleAgentDispatch(req, res, body);
        return;
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      } else {
        try { res.end(); } catch {}
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  // Receive a git bundle and clone/update it into our peer-repos area.
  private async handleRepoPush(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    const wsName = String(req.headers['x-opendev-workspace'] || '').trim();
    if (!wsName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing workspace name' }));
      return;
    }
    const bundlePath = join(tmpdir(), `opendev-recv-${randomUUID()}.bundle`);
    await fs.writeFile(bundlePath, body);
    const dest = peerRepoDir(wsName);
    try {
      await applyBundle(bundlePath, dest);
    } finally {
      try { await fs.unlink(bundlePath); } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dir: dest }));
  }

  // Receive a packaged agent, run it against a previously-pushed repo, and
  // stream its stdout/stderr back as the chunked response body.
  private async handleAgentDispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    const payload = JSON.parse(body.toString('utf8')) as {
      runId: string;
      manifest: AgentManifest;
      files: PackedFile[];
      workspaceName: string;
    };
    const repoDir = peerRepoDir(payload.workspaceName);
    try {
      await fs.access(repoDir);
    } catch {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No repo "${payload.workspaceName}" here — push the repo first.` }));
      return;
    }

    // Unpack the agent into a temp dir on this machine.
    const agentDir = join(tmpdir(), `opendev-agent-${payload.runId}`);
    await fs.mkdir(agentDir, { recursive: true });
    await unpackTo(payload.files, agentDir);
    const entryAbs = join(agentDir, payload.manifest.entry);

    let cmd: string;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENDEV_WORKSPACE_ROOT: repoDir,
      OPENDEV_AGENT_DIR: agentDir,
      FORCE_COLOR: '1'
    };
    if (payload.manifest.runtime === 'tsx') {
      const tsx = resolveBinPath('tsx');
      if (!tsx) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'This agent needs tsx, which is not installed on the target machine.' }));
        return;
      }
      cmd = tsx;
    } else {
      const node = resolveBinPath('node');
      if (node) { cmd = node; }
      else { cmd = process.execPath; env.ELECTRON_RUN_AS_NODE = '1'; }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });
    const proc = spawn(cmd, [entryAbs], { cwd: repoDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    this.inboundRuns.set(payload.runId, proc);

    const onData = (b: Buffer) => { try { res.write(b); } catch {} };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    // If the originating machine disconnects (Stop / closed tab), kill the job.
    req.on('close', () => {
      const pid = proc.pid;
      try { if (pid) process.kill(-pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
    });
    proc.on('exit', () => {
      this.inboundRuns.delete(payload.runId);
      try { res.end(); } catch {}
      fs.rm(agentDir, { recursive: true, force: true }).catch(() => {});
    });
    proc.on('error', (err) => {
      try { res.write(`\n[agent spawn error] ${err.message}\n`); res.end(); } catch {}
      this.inboundRuns.delete(payload.runId);
    });
  }

  // ── HTTP client (the originating side of a link) ─────────────────────

  // POST a buffer to a peer endpoint; resolves with the response stream.
  private peerRequest(peer: PeerInfo, path: string, body: Buffer, extraHeaders: Record<string, string> = {}): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        ...this.authHeaders(bodyHashOf(body)),
        ...extraHeaders
      };
      const r = httpRequest(
        { host: peer.address, port: peer.httpPort, path, method: 'POST', headers },
        (resp) => resolve(resp)
      );
      r.on('error', reject);
      r.end(body);
    });
  }

  // Bundle the current workspace and push it to a peer.
  async pushRepo(peerId: string): Promise<boolean> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer is not online.');
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open.');
    const wsName = root.split('/').filter(Boolean).pop() || 'repo';
    const bundlePath = await bundleRepo(root);
    try {
      const body = await fs.readFile(bundlePath);
      const resp = await this.peerRequest(peer, '/repo/push', body, { 'X-OpenDev-Workspace': wsName });
      const text = await readAll(resp);
      if (resp.statusCode !== 200) {
        throw new Error(`Peer rejected the push (${resp.statusCode}): ${text}`);
      }
      return true;
    } finally {
      try { await fs.unlink(bundlePath); } catch {}
    }
  }

  // Package the agent folder and dispatch it to a peer. Returns the AgentRun
  // immediately; output is relayed to the renderer over IPC.AgentStream as
  // the peer's chunked response arrives.
  async dispatchAgentRun(slug: string, peerId: string): Promise<AgentRun> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer is not online.');
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open.');
    const wsName = root.split('/').filter(Boolean).pop() || 'repo';
    const agentDir = join(root, '.opendev', 'agents', slug);
    const manifest = JSON.parse(await fs.readFile(join(agentDir, 'agent.json'), 'utf8')) as AgentManifest;
    const files = await packDir(agentDir);

    const runId = `ar-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const run: AgentRun = {
      runId, agentSlug: slug, streamId: runId,
      status: 'running', startedAt: Date.now(), target: peerId
    };
    const body = Buffer.from(JSON.stringify({ runId, manifest, files, workspaceName: wsName }));

    // Fire the request and relay its streamed body; don't await it here so
    // run() can return the AgentRun to the renderer right away.
    this.peerRequest(peer, '/agent/dispatch', body)
      .then((resp) => {
        if (resp.statusCode !== 200) {
          readAll(resp).then((t) => {
            safeSend(IPC.AgentStream, { streamId: runId, chunk: `\n[dispatch failed] ${t}\n` });
            safeSend(IPC.AgentStream, { streamId: runId, done: true, status: 'error' as AgentRunStatus });
          });
          return;
        }
        this.remoteRuns.set(runId, { res: resp });
        resp.on('data', (b: Buffer) => safeSend(IPC.AgentStream, { streamId: runId, chunk: b.toString('utf8') }));
        resp.on('end', () => {
          this.remoteRuns.delete(runId);
          safeSend(IPC.AgentStream, { streamId: runId, done: true, status: 'stopped' as AgentRunStatus });
        });
        resp.on('error', () => {
          this.remoteRuns.delete(runId);
          safeSend(IPC.AgentStream, { streamId: runId, done: true, status: 'error' as AgentRunStatus });
        });
      })
      .catch((err) => {
        safeSend(IPC.AgentStream, { streamId: runId, chunk: `\n[dispatch error] ${err.message}\n` });
        safeSend(IPC.AgentStream, { streamId: runId, done: true, status: 'error' as AgentRunStatus });
      });

    return run;
  }

  // Stop a remote run by tearing down its streaming response — the peer
  // sees the socket close (req 'close') and kills the child.
  stopRemoteRun(runId: string): boolean {
    const r = this.remoteRuns.get(runId);
    if (!r) return false;
    try { r.res.destroy(); } catch {}
    this.remoteRuns.delete(runId);
    safeSend(IPC.AgentStream, { streamId: runId, done: true, status: 'stopped' as AgentRunStatus });
    return true;
  }
}

// Read an HTTP response stream fully into a string.
function readAll(resp: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    resp.on('data', (c: Buffer) => chunks.push(c));
    resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    resp.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export const peerManager = new PeerManager();

// Called by AgentManager.run() when the target is a peer.
export async function dispatchAgentRun(slug: string, target: AgentRunTarget): Promise<AgentRun> {
  return peerManager.dispatchAgentRun(slug, target);
}

// Called by AgentManager.stop() when the runId isn't a local run.
export function stopRemoteRun(runId: string): boolean {
  return peerManager.stopRemoteRun(runId);
}

export function registerPeersIpc(): void {
  void peerManager.init();
  ipcMain.handle(IPC.PeersList, () => peerManager.list());
  ipcMain.handle(IPC.PeersStatus, () => peerManager.status());
  ipcMain.handle(IPC.PeersSetLinkKey, (_e, key: string) => peerManager.setLinkKey(key));
  ipcMain.handle(IPC.PeersSetEnabled, (_e, enabled: boolean) => peerManager.setEnabled(enabled));
  ipcMain.handle(IPC.PeersPushRepo, (_e, peerId: string) => peerManager.pushRepo(peerId));
}
