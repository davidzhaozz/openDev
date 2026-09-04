import { ipcMain, app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { fileURLToPath } from 'url';
import { IPC } from '@shared/ipc';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { onShutdown } from './lifecycle.js';
import { pathToFileUri } from '@shared/paths';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type ServerKind = 'ts' | 'py';

type Server = {
  kind: ServerKind;
  proc: ChildProcess;
  conn: MessageConnection;
  root: string;
  ready: Promise<void>;
  // Wall-clock time of the most recent request/notify on this server.
  // Used by the idle reaper to kill servers nobody's touched in a while —
  // they hold ~150-300 MB each and can be respawned lazily on next use.
  lastUsedAt: number;
};

const servers = new Map<ServerKind, Server>();

// Reap LSP servers that haven't been touched in this long. 5 minutes is
// long enough that ordinary task-switching (read email, check a chat,
// answer a Slack ping) doesn't kill the server out from under you, but
// short enough that leaving the IDE idle overnight reclaims the memory.
const IDLE_KILL_MS = 5 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
let reapTimer: NodeJS.Timeout | null = null;

function startIdleReaper(): void {
  if (reapTimer) return;
  reapTimer = setInterval(() => {
    const now = Date.now();
    for (const [kind, s] of servers) {
      if (now - s.lastUsedAt < IDLE_KILL_MS) continue;
      console.log(`[lsp:${kind}] idle ${Math.round((now - s.lastUsedAt) / 1000)}s — shutting down to free memory`);
      try { s.proc.kill(); } catch {}
      servers.delete(kind);
    }
  }, REAP_INTERVAL_MS);
  if (typeof reapTimer.unref === 'function') reapTimer.unref();
}

// Tiny inference of which language server should handle a given LSP request.
// LSP requests carry a textDocument URI; we pick the server by file extension.
function serverKindForUri(uri: string | undefined): ServerKind {
  if (!uri) return 'ts';
  const ext = uri.split('.').pop()?.toLowerCase();
  if (ext === 'py' || ext === 'pyi') return 'py';
  return 'ts';
}

function serverKindForRequestParams(params: unknown): ServerKind {
  const uri = (params as { textDocument?: { uri?: string } } | null | undefined)?.textDocument?.uri;
  return serverKindForUri(uri);
}

function findTsServerEntry(): string | null {
  // Candidate locations, in order of preference:
  //   - packaged: <resourcesPath>/app.asar.unpacked/node_modules/typescript-language-server/lib/cli.mjs
  //   - dev: <appPath>/node_modules/typescript-language-server/lib/cli.mjs
  //   - relative to main bundle
  const subPath = ['node_modules', 'typescript-language-server', 'lib', 'cli.mjs'];
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked', ...subPath) : null,
    app.isPackaged ? join(app.getAppPath(), '..', 'app.asar.unpacked', ...subPath) : null,
    join(app.getAppPath(), ...subPath),
    join(__dirname, '..', '..', ...subPath)
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function tsServerCmd(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  const entry = findTsServerEntry();
  if (!entry) return null;
  // Use Electron's own binary as a Node interpreter — no user-side Node
  // dependency required.
  return {
    cmd: process.execPath,
    args: [entry, '--stdio'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  };
}

// Pyright entry resolution. We try (in order):
//   1. node_modules/pyright/langserver.index.js bundled with the app
//   2. `pyright-langserver` on PATH (the most common install — `npm i -g
//      pyright`, `brew install pyright`, or via pip)
// If neither exists, Python LSP requests are no-ops; .py files still
// highlight and open. Adding `pyright` as a dep auto-resolves (1).
function findPyrightEntry(): string | null {
  const subPath = ['node_modules', 'pyright', 'langserver.index.js'];
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked', ...subPath) : null,
    app.isPackaged ? join(app.getAppPath(), '..', 'app.asar.unpacked', ...subPath) : null,
    join(app.getAppPath(), ...subPath),
    join(__dirname, '..', '..', ...subPath)
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function findOnPath(bin: string): string | null {
  const path = process.env.PATH || '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}

function pyrightServerCmd(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  const entry = findPyrightEntry();
  if (entry) {
    return {
      cmd: process.execPath,
      args: [entry, '--stdio'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    };
  }
  const onPath = findOnPath('pyright-langserver');
  if (onPath) {
    return { cmd: onPath, args: ['--stdio'], env: { ...process.env } };
  }
  return null;
}

// Per-server initialize capability set. Pyright accepts the same shape as
// the TS server; we send a slightly trimmed one to keep noise down. For
// Pyright we also include initializationOptions so the user's selected
// interpreter feeds its analysis (otherwise it falls back to system Python).
async function initParams(root: string, kind: ServerKind) {
  const base: Record<string, unknown> = {
    processId: process.pid,
    rootUri: pathToFileUri(root),
    workspaceFolders: [{ uri: pathToFileUri(root), name: 'workspace' }],
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
        signatureHelp: {},
        definition: { linkSupport: false },
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: { relatedInformation: true }
      },
      workspace: { workspaceFolders: true, symbol: {}, configuration: true }
    }
  };
  if (kind === 'py') {
    try {
      const { getSelectedInterpreter } = await import('./python.js');
      const sel = await getSelectedInterpreter();
      if (sel) {
        // Pyright reads pythonPath from initializationOptions (root) and
        // also via workspace/configuration with section 'python'. Set both
        // to maximize compatibility across pyright versions.
        base.initializationOptions = {
          pythonPath: sel.path
        };
      }
    } catch (e) {
      console.warn('[pyright] could not resolve selected interpreter:', (e as Error).message);
    }
  }
  return base;
}

async function ensureServer(kind: ServerKind): Promise<Server | null> {
  const root = workspace.getRoot();
  if (!root) return null;
  const existing = servers.get(kind);
  if (existing && existing.root === root) return existing;
  if (existing) {
    try { existing.proc.kill(); } catch {}
    servers.delete(kind);
  }
  const spec = kind === 'ts' ? tsServerCmd() : pyrightServerCmd();
  const tag = kind === 'ts' ? 'ts-ls' : 'pyright';
  if (!spec) {
    // No-op for missing language server — log once, but quietly. Common case
    // for Python: pyright not installed. The renderer still opens .py files.
    console.warn(`[${tag}] not found on disk or PATH; LSP features disabled for ${kind}`);
    return null;
  }
  const proc = spawn(spec.cmd, spec.args, { cwd: root, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.on('error', (err) => console.error(`[${tag}] spawn error:`, err.message));
  proc.on('exit', (code, sig) => console.log(`[${tag}] exited code=${code} sig=${sig}`));
  proc.stderr?.on('data', (b: Buffer) => console.error(`[${tag}]`, b.toString('utf8')));
  console.log(`[${tag}] started via`, spec.cmd, '+', spec.args[0]);
  const reader = new StreamMessageReader(proc.stdout!);
  const writer = new StreamMessageWriter(proc.stdin!);
  const conn = createMessageConnection(reader, writer);
  conn.listen();

  conn.onNotification('textDocument/publishDiagnostics', (params: any) => {
    safeSend(IPC.LspDiagnostics, params);
  });

  // Pyright pulls configuration via workspace/configuration. Return the
  // selected interpreter so type analysis matches the user's env.
  if (kind === 'py') {
    conn.onRequest('workspace/configuration', async (params: { items: Array<{ section?: string }> }) => {
      const items = params?.items || [];
      const out: unknown[] = [];
      let selected: { path: string } | null = null;
      try {
        const { getSelectedInterpreter } = await import('./python.js');
        selected = await getSelectedInterpreter();
      } catch { /* fall through with null */ }
      for (const it of items) {
        if (it.section === 'python' && selected) {
          out.push({ pythonPath: selected.path });
        } else {
          out.push({});
        }
      }
      return out;
    });
  }

  const params = await initParams(root, kind);
  const ready = conn.sendRequest('initialize', params)
    .then(() => conn.sendNotification('initialized', {}));

  const server: Server = { kind, proc, conn, root, ready: ready as Promise<void>, lastUsedAt: Date.now() };
  servers.set(kind, server);
  startIdleReaper();
  return server;
}

function touch(s: Server | null): void {
  if (s) s.lastUsedAt = Date.now();
}

// Kill + lazy-respawn the Pyright server. Called when the user picks a new
// interpreter — Pyright caches site-packages resolution per-init, so we
// can't just push didChangeConfiguration; we need a fresh process.
export function restartPyright(): void {
  const s = servers.get('py');
  if (!s) return;
  try { s.proc.kill(); } catch {}
  servers.delete('py');
  // Re-init lazily on next request — no need to eagerly respawn.
}

// Manual "free memory" entry point — wipes both LSP servers immediately
// without waiting for the idle reaper. Returns how many were killed so
// the UI can give a meaningful toast.
export function killAllLspServers(): number {
  let count = 0;
  for (const [kind, s] of servers) {
    try { s.proc.kill(); count++; }
    catch (e) { console.warn(`[lsp:${kind}] kill failed`, (e as Error).message); }
  }
  servers.clear();
  return count;
}

export function registerLspIpc() {
  ipcMain.handle(IPC.LspRequest, async (_e, method: string, params: unknown) => {
    const kind = serverKindForRequestParams(params);
    const s = await ensureServer(kind);
    if (!s) return null;
    touch(s);
    await s.ready;
    try {
      return await s.conn.sendRequest(method, params);
    } catch (err) {
      console.error(`[lsp:${kind}] ${method} failed`, err);
      return null;
    }
  });

  ipcMain.handle(IPC.LspNotify, async (_e, method: string, params: unknown) => {
    const kind = serverKindForRequestParams(params);
    const s = await ensureServer(kind);
    if (!s) return false;
    touch(s);
    await s.ready;
    s.conn.sendNotification(method, params);
    return true;
  });
}

onShutdown(() => {
  for (const [, s] of servers) {
    try { s.proc.kill(); } catch {}
  }
  servers.clear();
});
