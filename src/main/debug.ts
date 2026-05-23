import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer, type Socket, connect as netConnect } from 'net';
import { dirname, isAbsolute, resolve as resolvePath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import WebSocket, { type RawData } from 'ws';
import { IPC } from '@shared/ipc';
import type { DebugEventMsg, DebugStartConfig, DebugVar, Scope, StackFrame } from '@shared/types';
import { safeSend } from './safeSend.js';
import { resolveBinPath } from './ai.js';
import { workspace } from './workspace.js';

// Debugger. A protocol-agnostic vocabulary the renderer talks to via
// window.opendev.debug.*; behind it sits one DebugSession at a time.
//
// Milestone 1: NodeDebugSession — spawns `node --inspect-brk`, talks CDP
// (Chrome DevTools Protocol) over a WebSocket to the V8 inspector. Plain
// JS/MJS only; TypeScript source-map debugging is a Phase-2 follow-up.
// Milestone 2: JavaDebugSession (JDWP) lands later.

interface DebugSession {
  readonly sessionId: string;
  start(): Promise<void>;
  request(command: string, args: any): Promise<any>;
  stop(): Promise<void>;
}

class NodeDebugSession implements DebugSession {
  readonly sessionId = `dbg-${randomUUID().slice(0, 8)}`;
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  // CDP scriptId -> file path, populated by Debugger.scriptParsed.
  private scriptToPath = new Map<string, string>();
  // Breakpoint tracking: `${path}:${line}` -> CDP breakpointId(s).
  private bpIdsByLocation = new Map<string, string[]>();
  // Snapshot of frames at the current pause, keyed by callFrameId — used by
  // getScopes / evaluate to find the right scopeChain.
  private currentFrames = new Map<string, any>();
  private terminated = false;

  constructor(private file: string, private emit: (e: DebugEventMsg) => void) {}

  async start(): Promise<void> {
    // Resolve `node`. Fall back to running the bundled Electron binary as
    // plain Node — same trick the LSP server uses (lsp.ts).
    const node = resolveBinPath('node') ?? process.execPath;
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (node === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';

    this.proc = spawn(node, ['--inspect-brk=0', this.file], {
      cwd: workspace.getRoot() ?? dirname(this.file),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc.stdout?.on('data', (b: Buffer) => {
      this.emit({ kind: 'output', category: 'stdout', text: b.toString('utf8') });
    });

    // The V8 inspector prints `Debugging listening on ws://127.0.0.1:<port>/<uuid>`
    // to stderr on startup. We sniff for it, then forward subsequent stderr to
    // the renderer as output events.
    let stderrBuf = '';
    let urlFound = false;
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!urlFound) reject(new Error('Timed out waiting for V8 inspector to start'));
      }, 8000);
      this.proc!.stderr?.on('data', (b: Buffer) => {
        const t = b.toString('utf8');
        if (!urlFound) {
          stderrBuf += t;
          const m = stderrBuf.match(/ws:\/\/[^\s]+/);
          if (m) {
            urlFound = true;
            clearTimeout(timer);
            resolve(m[0]);
            return;
          }
        }
        if (urlFound) this.emit({ kind: 'output', category: 'stderr', text: t });
      });
      this.proc!.on('error', (e) => { if (!urlFound) { clearTimeout(timer); reject(e); } });
      this.proc!.on('exit', (code) => {
        this.terminated = true;
        if (!urlFound) {
          clearTimeout(timer);
          reject(new Error(`Node exited before inspector started (code=${code}). stderr: ${stderrBuf.slice(0, 600)}`));
        }
        try { this.ws?.close(); } catch {}
        this.emit({ kind: 'terminated', exitCode: code });
      });
    });

    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', (e) => reject(e));
    });
    this.ws.on('message', (data: RawData) => this.handleMessage(data.toString()));
    this.ws.on('close', () => {
      // Reject any in-flight requests so they don't hang forever.
      for (const [, p] of this.pending) p.reject(new Error('Debug socket closed'));
      this.pending.clear();
    });

    // CDP handshake. Order matters: enable domains before runIfWaitingForDebugger
    // so we receive Debugger.scriptParsed and can map breakpoints.
    await this.cdp('Debugger.enable');
    await this.cdp('Runtime.enable');
    this.emit({ kind: 'session-started', sessionId: this.sessionId, lang: 'node' });
    // Release the --inspect-brk gate. The renderer will have sent
    // setBreakpoints already (it reacts to 'session-started').
    await this.cdp('Runtime.runIfWaitingForDebugger');
  }

  private cdp(method: string, params: any = {}): Promise<any> {
    if (!this.ws || this.terminated) return Promise.reject(new Error('Debug session not connected'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `CDP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') this.handleEvent(msg.method, msg.params);
  }

  private handleEvent(method: string, params: any): void {
    switch (method) {
      case 'Debugger.scriptParsed': {
        if (typeof params.url === 'string' && params.url.startsWith('file://')) {
          try { this.scriptToPath.set(params.scriptId, fileURLToPath(params.url)); } catch {}
        }
        break;
      }
      case 'Debugger.paused': {
        this.currentFrames.clear();
        const frames: StackFrame[] = (params.callFrames || []).map((f: any) => {
          this.currentFrames.set(f.callFrameId, f);
          const path = this.scriptToPath.get(f.location?.scriptId);
          return {
            id: f.callFrameId,
            name: f.functionName || '(anonymous)',
            path,
            line: (f.location?.lineNumber ?? 0) + 1,
            col: (f.location?.columnNumber ?? 0) + 1
          };
        });
        // CDP reports `other` for breakpoint hits — translate to the more useful word.
        const reason = params.reason === 'other' ? 'breakpoint' : (params.reason || 'paused');
        this.emit({ kind: 'paused', reason, threadId: 1, frames });
        break;
      }
      case 'Debugger.resumed': {
        this.currentFrames.clear();
        this.emit({ kind: 'resumed' });
        break;
      }
      case 'Debugger.breakpointResolved': {
        const path = this.scriptToPath.get(params.location?.scriptId);
        if (path) {
          this.emit({
            kind: 'breakpoint-resolved',
            path,
            line: (params.location.lineNumber ?? 0) + 1,
            verified: true
          });
        }
        break;
      }
    }
  }

  async request(command: string, args: any): Promise<any> {
    if (this.terminated) throw new Error('Debug session terminated');
    switch (command) {
      case 'setBreakpoints': {
        const path = String(args.path);
        const lines: number[] = Array.isArray(args.lines) ? args.lines : [];
        // Remove existing breakpoints for this path before re-applying.
        for (const key of [...this.bpIdsByLocation.keys()]) {
          if (!key.startsWith(path + ':')) continue;
          for (const id of this.bpIdsByLocation.get(key) || []) {
            try { await this.cdp('Debugger.removeBreakpoint', { breakpointId: id }); } catch {}
          }
          this.bpIdsByLocation.delete(key);
        }
        const url = pathToFileURL(path).toString();
        for (const line of lines) {
          try {
            const r = await this.cdp('Debugger.setBreakpointByUrl', { url, lineNumber: line - 1 });
            if (r?.breakpointId) this.bpIdsByLocation.set(`${path}:${line}`, [r.breakpointId]);
          } catch { /* unresolved breakpoint — code may not be loaded yet */ }
        }
        return { applied: lines.length };
      }
      case 'continue': await this.cdp('Debugger.resume'); return {};
      case 'pause': await this.cdp('Debugger.pause'); return {};
      case 'stepOver': await this.cdp('Debugger.stepOver'); return {};
      case 'stepInto': await this.cdp('Debugger.stepInto'); return {};
      case 'stepOut': await this.cdp('Debugger.stepOut'); return {};
      case 'getScopes': {
        const frame = this.currentFrames.get(args.frameId);
        if (!frame) return { scopes: [] };
        const scopes: Scope[] = (frame.scopeChain || [])
          .map((s: any) => ({
            name: capitalize(s.type),
            varsRef: s.object?.objectId || '',
            expensive: s.type === 'global'
          }))
          .filter((s: Scope) => s.varsRef);
        return { scopes };
      }
      case 'getVariables': {
        const r = await this.cdp('Runtime.getProperties', {
          objectId: String(args.varsRef),
          ownProperties: true,
          generatePreview: true
        });
        const vars: DebugVar[] = (r.result || []).map((p: any) => ({
          name: p.name,
          value: previewValue(p.value),
          type: p.value?.type,
          varsRef: p.value?.objectId
        }));
        return { variables: vars };
      }
      case 'evaluate': {
        const r = await this.cdp('Debugger.evaluateOnCallFrame', {
          callFrameId: String(args.frameId),
          expression: String(args.expression)
        });
        if (r.exceptionDetails) {
          return {
            value: 'error: ' + (r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'eval failed'),
            type: 'error'
          };
        }
        return { value: previewValue(r.result), type: r.result?.type, varsRef: r.result?.objectId };
      }
    }
    throw new Error(`Unknown debug command: ${command}`);
  }

  async stop(): Promise<void> {
    this.terminated = true;
    try { this.ws?.close(); } catch {}
    if (this.proc && this.proc.exitCode == null) {
      try { this.proc.kill('SIGTERM'); } catch {}
      // Belt-and-braces SIGKILL after 2s if it didn't exit gracefully.
      const proc = this.proc;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// Minimal DAP (Debug Adapter Protocol) client
// ---------------------------------------------------------------------------
// DAP frames are JSON bodies prefixed with `Content-Length: N\r\n\r\n`. We
// keep this client transport-agnostic so it can be reused for any future
// DAP-based language (Go, Rust, etc.) — `connect()` is the only debugpy
// specific piece, and even that just dials a TCP socket the adapter opens.

type DapHandlers = {
  onEvent: (event: string, body: any) => void;
  onClose: (reason: string) => void;
};

class DapClient {
  private socket: Socket | null = null;
  private seq = 1;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private closed = false;

  constructor(private handlers: DapHandlers) {}

  async connect(host: string, port: number, timeoutMs = 8000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = netConnect({ host, port });
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Timed out connecting to debugpy at ${host}:${port}`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(t);
        this.socket = sock;
        sock.on('data', (chunk) => this.onData(chunk));
        sock.on('close', () => {
          if (this.closed) return;
          this.closed = true;
          for (const [, p] of this.pending) p.reject(new Error('DAP socket closed'));
          this.pending.clear();
          this.handlers.onClose('socket closed');
        });
        sock.on('error', () => { /* close handler will fire */ });
        resolve();
      });
      sock.once('error', (err) => { clearTimeout(t); reject(err); });
    });
  }

  request<T = any>(command: string, args: any = {}): Promise<T> {
    if (this.closed || !this.socket) return Promise.reject(new Error('DAP not connected'));
    const seq = this.seq++;
    const message = { seq, type: 'request', command, arguments: args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      const json = JSON.stringify(message);
      const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
      this.socket!.write(frame);
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Multiple messages may arrive in a single TCP read; drain in a loop.
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // Malformed header — discard up to the separator and resync.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;             // need more bytes
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body);
      else p.reject(new Error(msg.message || `DAP ${msg.command} failed`));
    } else if (msg.type === 'event') {
      try { this.handlers.onEvent(msg.event, msg.body); }
      catch (e) { console.error('[dap] event handler threw', e); }
    }
  }

  close(): void {
    this.closed = true;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }
}

// ---------------------------------------------------------------------------
// Python (debugpy) session
// ---------------------------------------------------------------------------

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class PythonDebugSession implements DebugSession {
  readonly sessionId = `dbg-${randomUUID().slice(0, 8)}`;
  private proc: ChildProcess | null = null;
  private dap: DapClient | null = null;
  private terminated = false;
  // DAP threadId of the currently-paused thread (debugpy reports per-thread
  // stops). Step commands need this; we capture it on each stopped event.
  private pausedThreadId: number | null = null;
  // Frame metadata for the current pause — frameId is numeric in DAP, but our
  // renderer treats it as a string id. Keep a mapping for getScopes/evaluate.
  private currentFrames = new Map<string, number>();
  private varsRefCounter = 1;
  private numericVarsRefs = new Map<string, number>();

  constructor(
    private file: string,
    private interpreterOverride: string | undefined,
    private args: string[],
    private emit: (e: DebugEventMsg) => void
  ) {}

  async start(): Promise<void> {
    const interpreter = await this.resolveInterpreter();
    const port = await pickFreePort();
    const root = workspace.getRoot() ?? dirname(this.file);

    // Spawn debugpy in --listen mode. `--wait-for-client` makes the script
    // block until we connect and send `configurationDone`, which gives us a
    // window to push the user's saved breakpoints before any user code runs.
    this.proc = spawn(interpreter, [
      '-m', 'debugpy',
      '--listen', `127.0.0.1:${port}`,
      '--wait-for-client',
      this.file,
      ...this.args
    ], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.proc.stdout?.on('data', (b: Buffer) => {
      this.emit({ kind: 'output', category: 'stdout', text: b.toString('utf8') });
    });
    // Watch stderr for the "module 'debugpy' not found" case so we can give
    // the user something actionable rather than a generic exit error.
    let stderrBuf = '';
    this.proc.stderr?.on('data', (b: Buffer) => {
      const t = b.toString('utf8');
      stderrBuf += t;
      this.emit({ kind: 'output', category: 'stderr', text: t });
    });
    this.proc.on('exit', (code) => {
      this.terminated = true;
      try { this.dap?.close(); } catch {}
      if (code !== 0 && /No module named ['"]debugpy['"]/i.test(stderrBuf)) {
        this.emit({
          kind: 'output',
          category: 'stderr',
          text: `\n[opendev] debugpy is not installed in this interpreter. Install via the Packages tab (pip: 'debugpy') or run: ${interpreter} -m pip install debugpy\n`
        });
      }
      this.emit({ kind: 'terminated', exitCode: code });
    });

    // Wait for the adapter to accept connections. debugpy doesn't print a
    // ready line we can sniff for (--log-dir aside), so we just poll with a
    // short retry — pickFreePort gave us a port that's currently free and
    // about to be re-bound by debugpy, so the first attempt usually wins
    // within a few hundred ms after the python interpreter starts.
    this.dap = new DapClient({
      onEvent: (event, body) => this.handleEvent(event, body),
      onClose: () => { /* exit handler does the work */ }
    });
    await this.connectWithRetry('127.0.0.1', port);

    // DAP handshake.
    await this.dap.request('initialize', {
      adapterID: 'opendev-python',
      clientID: 'opendev-ide',
      clientName: 'OpenDev IDE',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false
    });
    // 'attach' rather than 'launch' — debugpy is already running the script
    // and waiting for us.
    await this.dap.request('attach', {
      // debugpy reads the local stop-on-entry preference; we don't want it
      // pausing at module top — let it run until a real breakpoint.
      justMyCode: false
    });
    this.emit({ kind: 'session-started', sessionId: this.sessionId, lang: 'python' });
    // configurationDone is what frees debugpy from --wait-for-client; the
    // renderer listens for session-started and pushes saved breakpoints, so
    // we delay configurationDone by one tick to let those land first.
    await new Promise<void>((res) => setTimeout(res, 60));
    try {
      await this.dap.request('configurationDone', {});
    } catch (e) {
      // Older debugpy versions advertised supportsConfigurationDone via the
      // initialize response; if the adapter rejects this request, treat it
      // as a no-op rather than failing the whole start sequence.
      console.warn('[python-debug] configurationDone failed (likely benign):', (e as Error).message);
    }
  }

  private async resolveInterpreter(): Promise<string> {
    if (this.interpreterOverride) return this.interpreterOverride;
    try {
      const { getSelectedInterpreter } = await import('./python.js');
      const sel = await getSelectedInterpreter();
      if (sel) return sel.path;
    } catch { /* fall through */ }
    return 'python3';
  }

  private async connectWithRetry(host: string, port: number, attempts = 25): Promise<void> {
    let lastErr: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      if (this.terminated) throw new Error('debugpy exited before client could connect');
      try {
        await this.dap!.connect(host, port, 1500);
        return;
      } catch (e) {
        lastErr = e as Error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`Could not connect to debugpy at ${host}:${port}: ${lastErr?.message || 'unknown error'}`);
  }

  // Convert a numeric DAP variablesReference into a stable string key the
  // renderer can pass back via getVariables. The mapping is per-session and
  // gets rebuilt on each pause (DAP refs aren't stable across stops).
  private refToKey(ref: number): string {
    if (!ref) return '';
    const key = String(ref);
    this.numericVarsRefs.set(key, ref);
    return key;
  }

  private keyToRef(key: string): number {
    return this.numericVarsRefs.get(key) ?? Number(key) ?? 0;
  }

  private handleEvent(event: string, body: any): void {
    switch (event) {
      case 'initialized':
        // We don't act on this directly — saved breakpoints land via the
        // renderer pushing setBreakpoints after session-started.
        break;
      case 'stopped': {
        this.pausedThreadId = body?.threadId ?? null;
        // Frame info comes via a follow-up stackTrace request — we issue it
        // synchronously and emit `paused` once the frames are in hand.
        void this.fetchStack(body?.reason || 'paused');
        break;
      }
      case 'continued':
        this.currentFrames.clear();
        this.numericVarsRefs.clear();
        this.emit({ kind: 'resumed' });
        break;
      case 'thread':
        // ignore — we infer the active thread from `stopped`
        break;
      case 'output': {
        // debugpy uses category 'stdout' | 'stderr' | 'console' | 'telemetry'.
        // Drop telemetry; map 'console' to stderr (it's adapter chatter).
        const cat = body?.category;
        if (cat === 'telemetry') break;
        const target: 'stdout' | 'stderr' = cat === 'stdout' ? 'stdout' : 'stderr';
        this.emit({ kind: 'output', category: target, text: String(body?.output ?? '') });
        break;
      }
      case 'terminated':
      case 'exited':
        this.terminated = true;
        this.emit({ kind: 'terminated', exitCode: typeof body?.exitCode === 'number' ? body.exitCode : null });
        break;
      case 'breakpoint': {
        const bp = body?.breakpoint;
        if (bp?.verified && bp.source?.path && typeof bp.line === 'number') {
          this.emit({ kind: 'breakpoint-resolved', path: bp.source.path, line: bp.line, verified: true });
        }
        break;
      }
    }
  }

  private async fetchStack(reason: string): Promise<void> {
    if (!this.dap || this.pausedThreadId == null) return;
    try {
      const r = await this.dap.request('stackTrace', { threadId: this.pausedThreadId, startFrame: 0, levels: 20 });
      this.currentFrames.clear();
      this.numericVarsRefs.clear();
      const frames: StackFrame[] = (r?.stackFrames || []).map((f: any) => {
        const id = String(f.id);
        this.currentFrames.set(id, f.id);
        return {
          id,
          name: f.name || '(anonymous)',
          path: f.source?.path,
          line: f.line ?? 0,
          col: f.column ?? 0
        };
      });
      this.emit({ kind: 'paused', reason, threadId: this.pausedThreadId, frames });
    } catch (e) {
      console.error('[python-debug] stackTrace failed', e);
      this.emit({ kind: 'paused', reason, threadId: this.pausedThreadId, frames: [] });
    }
  }

  async request(command: string, args: any): Promise<any> {
    if (this.terminated || !this.dap) throw new Error('Debug session terminated');
    switch (command) {
      case 'setBreakpoints': {
        const path: string = String(args.path);
        if (!isAbsolute(path)) {
          // The renderer normally hands us absolute paths; if not, resolve
          // relative to the workspace root.
          const root = workspace.getRoot();
          if (root) args.path = resolvePath(root, path);
        }
        const lines: number[] = Array.isArray(args.lines) ? args.lines : [];
        const r = await this.dap.request('setBreakpoints', {
          source: { path: args.path || path, name: (args.path || path).split('/').pop() },
          breakpoints: lines.map((line) => ({ line })),
          lines
        });
        return { applied: (r?.breakpoints || []).filter((b: any) => b.verified).length };
      }
      case 'continue':
        if (this.pausedThreadId != null) await this.dap.request('continue', { threadId: this.pausedThreadId });
        return {};
      case 'pause':
        if (this.pausedThreadId != null) await this.dap.request('pause', { threadId: this.pausedThreadId });
        else {
          // No thread known yet — debugpy usually only assigns ids after the
          // first stop. Best-effort: ask for thread list and pause the first.
          const t = await this.dap.request('threads');
          const tid = t?.threads?.[0]?.id;
          if (tid != null) await this.dap.request('pause', { threadId: tid });
        }
        return {};
      case 'stepOver':
        if (this.pausedThreadId != null) await this.dap.request('next', { threadId: this.pausedThreadId });
        return {};
      case 'stepInto':
        if (this.pausedThreadId != null) await this.dap.request('stepIn', { threadId: this.pausedThreadId });
        return {};
      case 'stepOut':
        if (this.pausedThreadId != null) await this.dap.request('stepOut', { threadId: this.pausedThreadId });
        return {};
      case 'getScopes': {
        const frameNum = this.currentFrames.get(String(args.frameId));
        if (frameNum == null) return { scopes: [] };
        const r = await this.dap.request('scopes', { frameId: frameNum });
        const scopes: Scope[] = (r?.scopes || []).map((s: any) => ({
          name: capitalize(s.name || 'scope'),
          varsRef: this.refToKey(s.variablesReference),
          expensive: !!s.expensive
        })).filter((s: Scope) => s.varsRef);
        return { scopes };
      }
      case 'getVariables': {
        const ref = this.keyToRef(String(args.varsRef));
        if (!ref) return { variables: [] };
        const r = await this.dap.request('variables', { variablesReference: ref });
        const vars: DebugVar[] = (r?.variables || []).map((v: any) => ({
          name: v.name,
          value: String(v.value ?? ''),
          type: v.type,
          varsRef: v.variablesReference ? this.refToKey(v.variablesReference) : undefined
        }));
        return { variables: vars };
      }
      case 'evaluate': {
        const frameNum = this.currentFrames.get(String(args.frameId));
        try {
          const r = await this.dap.request('evaluate', {
            expression: String(args.expression),
            frameId: frameNum,
            context: 'repl'
          });
          return {
            value: String(r?.result ?? ''),
            type: r?.type,
            varsRef: r?.variablesReference ? this.refToKey(r.variablesReference) : undefined
          };
        } catch (err) {
          return { value: 'error: ' + (err as Error).message, type: 'error' };
        }
      }
    }
    // Unknown command — silently ignore so the renderer can probe new
    // capabilities without crashing the session.
    void this.varsRefCounter;
    return {};
  }

  async stop(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    try { await this.dap?.request('disconnect', { terminateDebuggee: true }); }
    catch { /* socket may already be closed */ }
    try { this.dap?.close(); } catch {}
    if (this.proc && this.proc.exitCode == null) {
      try { this.proc.kill('SIGTERM'); } catch {}
      const proc = this.proc;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }
  }
}

function previewValue(v: any): string {
  if (!v) return 'undefined';
  if (v.unserializableValue) return String(v.unserializableValue);
  if ('value' in v) {
    if (typeof v.value === 'string') return JSON.stringify(v.value);
    return String(v.value);
  }
  if (v.description) return String(v.description);
  return v.type || '?';
}

class DebugManager {
  private session: DebugSession | null = null;

  private emit = (e: DebugEventMsg) => {
    safeSend(IPC.DebugEvent, e);
    if (e.kind === 'terminated') this.session = null;
  };

  async start(config: DebugStartConfig): Promise<{ sessionId: string }> {
    // Single session for M1 — terminate any existing one first.
    if (this.session) {
      try { await this.session.stop(); } catch {}
      this.session = null;
    }
    if (config.lang === 'node') {
      const s = new NodeDebugSession(config.file, this.emit);
      this.session = s;
      try {
        await s.start();
      } catch (err) {
        this.session = null;
        const msg = `[debug start failed] ${(err as Error).message}\n`;
        this.emit({ kind: 'output', category: 'stderr', text: msg });
        this.emit({ kind: 'terminated', exitCode: -1 });
        throw err;
      }
      return { sessionId: s.sessionId };
    }
    if (config.lang === 'python') {
      const s = new PythonDebugSession(config.file, config.interpreter, config.args ?? [], this.emit);
      this.session = s;
      try {
        await s.start();
      } catch (err) {
        this.session = null;
        const msg = `[debug start failed] ${(err as Error).message}\n`;
        this.emit({ kind: 'output', category: 'stderr', text: msg });
        this.emit({ kind: 'terminated', exitCode: -1 });
        throw err;
      }
      return { sessionId: s.sessionId };
    }
    throw new Error('Java debugging is Milestone 2 — not implemented yet.');
  }

  async request(command: string, args: any): Promise<any> {
    if (!this.session) throw new Error('No active debug session');
    return this.session.request(command, args);
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    await s.stop();
  }
}

export const debugManager = new DebugManager();

export function registerDebugIpc(): void {
  ipcMain.handle(IPC.DebugStart, (_e, config: DebugStartConfig) => debugManager.start(config));
  ipcMain.handle(IPC.DebugRequest, (_e, command: string, args: unknown) =>
    debugManager.request(command, args as any));
  ipcMain.handle(IPC.DebugStop, () => debugManager.stop());
}
