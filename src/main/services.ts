import { ipcMain } from 'electron';
import { spawn, exec, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, resolve, isAbsolute, basename } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { ServiceDef, ServiceRuntime, ServiceStatus } from '@shared/types';
import { workspace } from './workspace.js';
import { onShutdown } from './lifecycle.js';
import { freePort } from './ports.js';
import { safeSend } from './safeSend.js';

const pexec = promisify(exec);

async function listeningPortsForPgid(pgid: number): Promise<number[]> {
  try {
    const { stdout } = await pexec(`lsof -nP -iTCP -sTCP:LISTEN -a -g ${pgid} -F n`, { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue;
      const m = line.match(/:(\d+)$/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

type StoreShape = { items: ServiceDef[] };

const LOG_TAIL = 1000;

class ServiceManager {
  private runtimes = new Map<string, { proc: ChildProcess; runtime: ServiceRuntime; log: string[] }>();

  storePath(): string {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    return join(root, '.opendev', 'services.json');
  }

  legacyPath(): string {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    return join(root, '.idea', 'opendev', 'services.json');
  }

  async list(): Promise<ServiceDef[]> {
    const root = workspace.getRoot();
    if (!root) return [];
    let store: StoreShape | null = null;
    try {
      const raw = await fs.readFile(this.storePath(), 'utf8');
      store = JSON.parse(raw);
    } catch {}
    if (!store) {
      try {
        const raw = await fs.readFile(this.legacyPath(), 'utf8');
        const legacy = JSON.parse(raw) as { items: Array<{ id: string; name: string; command: string; workingDir: string }> };
        store = { items: legacy.items.map(i => ({ id: i.id, name: i.name, command: i.command, cwd: i.workingDir })) };
      } catch {}
    }
    return store?.items ?? [];
  }

  async deriveFromDir(absPath: string): Promise<{ name: string; command: string; cwd: string }> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace');
    const norm = absPath.replace(/\/+$/, '');
    if (norm !== root && !norm.startsWith(root + '/')) throw new Error('Path outside workspace');
    const cwd = norm === root ? '.' : norm.slice(root.length + 1);
    // Always use the folder name — package.json's `name` is often scoped/internal
    // and doesn't match what you'd recognize in the services list.
    const name = cwd === '.' ? root.split('/').pop() || 'service' : cwd.split('/').pop() || cwd;
    let command = 'npm run dev';
    try {
      const pkg = JSON.parse(await fs.readFile(join(norm, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.dev) command = 'npm run dev';
      else if (scripts.start) command = 'npm run start';
      else if (scripts.serve) command = 'npm run serve';
    } catch {
      // No package.json — leave the placeholder command for the user to edit later
    }
    return { name, command, cwd };
  }

  async save(def: ServiceDef): Promise<ServiceDef> {
    const list = await this.readUserList();
    const out: ServiceDef = { ...def, id: def.id || randomUUID() };
    const idx = list.findIndex(s => s.id === out.id);
    if (idx >= 0) list[idx] = out; else list.push(out);
    await this.writeUserList(list);
    safeSend(IPC.ServicesChanged);
    return out;
  }

  async delete(id: string): Promise<void> {
    const list = (await this.readUserList()).filter(s => s.id !== id);
    await this.writeUserList(list);
    safeSend(IPC.ServicesChanged);
  }

  private async readUserList(): Promise<ServiceDef[]> {
    try {
      const raw = await fs.readFile(this.storePath(), 'utf8');
      return (JSON.parse(raw) as StoreShape).items ?? [];
    } catch { return []; }
  }

  private async writeUserList(items: ServiceDef[]): Promise<void> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace');
    await fs.mkdir(join(root, '.opendev'), { recursive: true });
    await fs.writeFile(this.storePath(), JSON.stringify({ items }, null, 2), 'utf8');
  }

  async start(id: string): Promise<ServiceRuntime> {
    const list = await this.list();
    const def = list.find(s => s.id === id);
    if (!def) throw new Error(`Service ${id} not found`);
    if (this.runtimes.has(id)) {
      const existing = this.runtimes.get(id)!;
      if (existing.runtime.status === 'running' || existing.runtime.status === 'starting') {
        return existing.runtime;
      }
    }
    const root = workspace.getRoot()!;
    const cwd = isAbsolute(def.cwd) ? def.cwd : resolve(root, def.cwd);
    const log: string[] = [];
    const runtime: ServiceRuntime = { id, status: 'starting', startedAt: Date.now() };
    const broadcast = () => safeSend(IPC.ServicesStatus, runtime);

    // Pre-flight: if this service has a known port (def.port), free it
    // before spawning. Otherwise the new process will EADDRINUSE-fail
    // immediately. This is the "always make the port available" behavior
    // the user wanted.
    if (def.port) {
      try {
        const r = await freePort(def.port);
        if (r.killed.length > 0) {
          const msg = `[opendev] freed port ${def.port} (killed PID${r.killed.length === 1 ? '' : 's'} ${r.killed.join(', ')})\n`;
          log.push(msg);
          safeSend(IPC.ServicesLog, { id, chunk: msg });
        }
      } catch { /* keep going — start() may still succeed on a different port */ }
    }

    log.push(`[opendev] $ ${def.command}\n[opendev] cwd: ${cwd}\n[opendev] PATH=${(process.env.PATH || '').split(':').slice(0, 6).join(':')}…\n`);
    // detached:true puts the shell + children into a new process group so we
    // can signal the whole tree on shutdown. Without this, killing the wrapping
    // shell leaves npm/tsx/node orphans bound to dev ports.
    const proc = spawn(def.command, {
      cwd,
      shell: true,
      detached: true,
      env: { ...process.env, FORCE_COLOR: '1', ...def.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    runtime.pid = proc.pid;
    this.runtimes.set(id, { proc, runtime, log });

    // Recovery state — guards against thrashing if the conflicting
    // process keeps respawning (we only attempt recovery once per start).
    let attemptedRecovery = false;
    const tryRecoverEaddrInUse = async (text: string) => {
      if (attemptedRecovery) return;
      const m = text.match(/EADDRINUSE[^\d]*:?(\d{2,5})\b/);
      if (!m) return;
      const conflictPort = Number(m[1]);
      if (!Number.isFinite(conflictPort) || conflictPort < 1) return;
      attemptedRecovery = true;
      const msg = `\n[opendev] detected EADDRINUSE on :${conflictPort} — killing holder and restarting…\n`;
      log.push(msg);
      safeSend(IPC.ServicesLog, { id, chunk: msg });
      try {
        const r = await freePort(conflictPort);
        const done = `[opendev] freed :${conflictPort} (killed PID${r.killed.length === 1 ? '' : 's'} ${r.killed.join(', ') || 'none'})\n`;
        log.push(done);
        safeSend(IPC.ServicesLog, { id, chunk: done });
      } catch { /* fall through to restart anyway */ }
      // Kill current shell (it already failed). The exit handler will
      // mark status=stopped; we then kick off a fresh start.
      const pid = proc.pid;
      try { if (pid) process.kill(-pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      // Defer restart to next tick so the exit handler runs first.
      setTimeout(() => {
        this.start(id).catch((err) => {
          const errMsg = `\n[opendev] auto-restart failed: ${err?.message || err}\n`;
          log.push(errMsg);
          safeSend(IPC.ServicesLog, { id, chunk: errMsg });
        });
      }, 250);
    };

    const pushLog = (chunk: Buffer) => {
      try {
        const s = chunk.toString('utf8');
        log.push(s);
        while (log.length > LOG_TAIL) log.shift();
        safeSend(IPC.ServicesLog, { id, chunk: s });
        if (runtime.status === 'starting') {
          runtime.status = 'running';
          broadcast();
        }
        // Detect "address in use" failures and auto-recover.
        if (/EADDRINUSE/i.test(s)) void tryRecoverEaddrInUse(s);
      } catch { /* logging mustn't crash the process */ }
    };
    proc.stdout?.on('data', pushLog);
    proc.stderr?.on('data', pushLog);

    proc.on('exit', (code, signal) => {
      try {
        const r = this.runtimes.get(id);
        if (!r) return;
        r.runtime.status = (code === 0 || signal === 'SIGTERM') ? 'stopped' : 'error';
        r.runtime.lastError = code !== 0 && signal !== 'SIGTERM' ? `exit code ${code}` : undefined;
        broadcast();
      } catch { /* window torn down mid-exit */ }
    });
    proc.on('error', (err) => {
      try {
        runtime.status = 'error';
        runtime.lastError = err.message;
        log.push(`\n[spawn error] ${err.message}\n`);
        broadcast();
      } catch { /* window torn down mid-error */ }
    });
    broadcast();
    return runtime;
  }

  async stop(id: string, opts: { waitMs?: number } = {}): Promise<void> {
    const r = this.runtimes.get(id);
    if (!r) return;
    const pid = r.proc.pid;
    const killGroup = (sig: NodeJS.Signals) => {
      try { if (pid) process.kill(-pid, sig); }
      catch { try { r.proc.kill(sig); } catch {} }
    };
    if (r.proc.exitCode == null) killGroup('SIGTERM');

    const waitMs = opts.waitMs ?? 4000;
    await new Promise<void>((resolve) => {
      if (r.proc.exitCode != null) return resolve();
      const t = setTimeout(() => { killGroup('SIGKILL'); resolve(); }, waitMs);
      r.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  async restart(id: string): Promise<ServiceRuntime> {
    const existing = this.runtimes.get(id);
    if (existing) {
      await this.stop(id);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4500);
        existing.proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    return this.start(id);
  }

  status(id: string): ServiceRuntime {
    const r = this.runtimes.get(id);
    return r?.runtime ?? { id, status: 'stopped' as ServiceStatus };
  }

  allStatuses(): ServiceRuntime[] {
    return [...this.runtimes.values()].map(r => r.runtime);
  }

  async allPorts(): Promise<Record<string, number[]>> {
    const out: Record<string, number[]> = {};
    await Promise.all([...this.runtimes.entries()].map(async ([id, r]) => {
      if (r.runtime.status !== 'running' && r.runtime.status !== 'starting') return;
      if (!r.proc.pid) return;
      const ports = await listeningPortsForPgid(r.proc.pid);
      if (ports.length) out[id] = ports;
    }));
    return out;
  }

  log(id: string): string {
    const r = this.runtimes.get(id);
    if (!r) return '';
    return r.log.join('');
  }

  async stopAll(waitMs = 3500): Promise<void> {
    const ids = [...this.runtimes.keys()];
    if (ids.length === 0) return;
    console.log(`[services] stopping ${ids.length} on shutdown`);
    await Promise.all(ids.map(id => this.stop(id, { waitMs })));
  }

  // Shutdown-path variant: skip graceful SIGTERM entirely and ALSO kill
  // whatever's still listening on the ports each service was using. With
  // shell:true + node/npm child trees, some processes escape the group
  // kill (vite cluster workers, npm respawn-on-crash, etc) and keep the
  // dev port held even after the parent shell exits — which is exactly
  // what the user is seeing. Targeting the port directly is the only
  // reliable cleanup.
  async stopAllImmediate(): Promise<void> {
    const entries = [...this.runtimes.entries()];
    if (entries.length === 0) return;
    console.log(`[services] hard-killing ${entries.length} on quit`);

    // 1) Snapshot the ports each service was holding BEFORE we kill —
    //    once the shell exits the lsof query loses the group context.
    const portsByService: number[][] = await Promise.all(entries.map(async ([, r]) => {
      if (!r.proc.pid) return [];
      try { return await listeningPortsForPgid(r.proc.pid); }
      catch { return []; }
    }));

    // 2) SIGKILL each process group immediately. No grace period.
    for (const [, r] of entries) {
      const pid = r.proc.pid;
      try { if (pid) process.kill(-pid, 'SIGKILL'); }
      catch { try { r.proc.kill('SIGKILL'); } catch {} }
    }

    // 3) Belt-and-suspenders: any process still listening on those ports
    //    after the group kill is an orphan. `lsof -ti:PORT` lists PIDs;
    //    pipe through xargs kill -9. We bound each call to 1.5s.
    const allPorts = new Set<number>();
    for (const ports of portsByService) for (const p of ports) allPorts.add(p);
    if (allPorts.size > 0) {
      console.log(`[services] freeing ports ${[...allPorts].join(', ')}`);
      await Promise.all([...allPorts].map(async (port) => {
        try {
          // BSD xargs (macOS) doesn't have GNU's `-r`, so empty input
          // would still try to run kill -9. Use a subshell instead so an
          // empty PID list is a no-op.
          await pexec(`PIDS=$(lsof -ti:${port} 2>/dev/null); [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null; true`, {
            timeout: 1500,
            shell: '/bin/sh'
          });
        } catch { /* port may already be free */ }
      }));
    }
  }
}

export const serviceManager = new ServiceManager();
// Use the aggressive path on shutdown — the graceful one was leaking
// child processes that kept ports bound after the app exited.
onShutdown(() => serviceManager.stopAllImmediate());

export function registerServicesIpc() {
  ipcMain.handle(IPC.ServicesList, () => serviceManager.list());
  ipcMain.handle(IPC.ServicesSave, (_e, def: ServiceDef) => serviceManager.save(def));
  ipcMain.handle(IPC.ServicesDelete, (_e, id: string) => serviceManager.delete(id));
  ipcMain.handle(IPC.ServicesStart, (_e, id: string) => serviceManager.start(id));
  ipcMain.handle(IPC.ServicesStop, (_e, id: string) => serviceManager.stop(id));
  ipcMain.handle(IPC.ServicesRestart, (_e, id: string) => serviceManager.restart(id));
  ipcMain.handle(IPC.ServicesDeriveFromDir, (_e, absPath: string) => serviceManager.deriveFromDir(absPath));
  ipcMain.handle(IPC.ServicesStatus, () => serviceManager.allStatuses());
  ipcMain.handle(IPC.ServicesLog, (_e, id: string) => serviceManager.log(id));
  ipcMain.handle(IPC.ServicesPorts, () => serviceManager.allPorts());
}

export function describeAutoService(name: string): string {
  return basename(name);
}
