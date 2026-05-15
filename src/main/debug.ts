import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
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
