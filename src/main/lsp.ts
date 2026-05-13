import { ipcMain, app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { IPC } from '@shared/ipc';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { onShutdown } from './lifecycle.js';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Server = {
  proc: ChildProcess;
  conn: MessageConnection;
  root: string;
  ready: Promise<void>;
};

let server: Server | null = null;

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

async function ensureServer(): Promise<Server | null> {
  const root = workspace.getRoot();
  if (!root) return null;
  if (server && server.root === root) return server;
  if (server) {
    try { server.proc.kill(); } catch {}
    server = null;
  }
  const spec = tsServerCmd();
  if (!spec) {
    console.error('[ts-ls] typescript-language-server entry not found; LSP features disabled');
    return null;
  }
  const proc = spawn(spec.cmd, spec.args, { cwd: root, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.on('error', (err) => console.error('[ts-ls] spawn error:', err.message));
  proc.on('exit', (code, sig) => console.log('[ts-ls] exited code=' + code + ' sig=' + sig));
  proc.stderr?.on('data', (b: Buffer) => console.error('[ts-ls]', b.toString('utf8')));
  console.log('[ts-ls] started via', spec.cmd, '+', spec.args[0]);
  const reader = new StreamMessageReader(proc.stdout!);
  const writer = new StreamMessageWriter(proc.stdin!);
  const conn = createMessageConnection(reader, writer);
  conn.listen();

  conn.onNotification('textDocument/publishDiagnostics', (params: any) => {
    safeSend(IPC.LspDiagnostics, params);
  });

  const ready = conn.sendRequest('initialize', {
    processId: process.pid,
    rootUri: `file://${root}`,
    workspaceFolders: [{ uri: `file://${root}`, name: 'workspace' }],
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
      workspace: { workspaceFolders: true, symbol: {} }
    }
  }).then(() => conn.sendNotification('initialized', {}));

  server = { proc, conn, root, ready: ready as Promise<void> };
  return server;
}

export function registerLspIpc() {
  ipcMain.handle(IPC.LspRequest, async (_e, method: string, params: unknown) => {
    const s = await ensureServer();
    if (!s) return null;
    await s.ready;
    try {
      return await s.conn.sendRequest(method, params);
    } catch (err) {
      console.error(`[lsp] ${method} failed`, err);
      return null;
    }
  });

  ipcMain.handle(IPC.LspNotify, async (_e, method: string, params: unknown) => {
    const s = await ensureServer();
    if (!s) return false;
    await s.ready;
    s.conn.sendNotification(method, params);
    return true;
  });
}

onShutdown(() => {
  if (server) {
    try { server.proc.kill(); } catch {}
    server = null;
  }
});
