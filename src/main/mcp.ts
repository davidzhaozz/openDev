// MCP server. Exposes IDE state and operations as MCP tools so an external
// Claude Code or Codex CLI can read what the user is working on and act on
// it without bouncing through stdout copy-paste.
//
// We host a streamable-HTTP MCP endpoint on 127.0.0.1:<port>. The wire
// protocol is straight JSON-RPC 2.0 with three methods the IDE has to
// support: `initialize`, `tools/list`, `tools/call`.
//
// Pointing a CLI at it:
//   ~/.claude.json (or .mcp.json in a project root):
//   {
//     "mcpServers": {
//       "opendev-ide": { "type": "http", "url": "http://127.0.0.1:53825/" }
//     }
//   }

import { ipcMain } from 'electron';
import http from 'http';
import os from 'os';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { rgPath } from '@vscode/ripgrep';
import { simpleGit } from 'simple-git';
import { IPC } from '@shared/ipc';
import { workspace, safeWithinRoot } from './workspace.js';
import { listDir, walkAllFiles } from './fs.js';
import { listListeningPorts } from './ports.js';
import { serviceManager } from './services.js';
import { agentManager } from './agents.js';
import { restApi } from './rest.js';
import type { RestSavedRequest } from '@shared/types';
import { loadSettings, patchSettings } from './storage.js';
import { onShutdown } from './lifecycle.js';
import { LIMITS, capString, tail } from './limits.js';

const PORT = 53825;
const HOST_LOOPBACK = '127.0.0.1';
const HOST_ALL = '0.0.0.0';

type McpStatus = {
  running: boolean;
  url?: string;          // loopback URL — always works locally
  lanUrl?: string;       // LAN-reachable URL when bound on 0.0.0.0
  port?: number;
  host?: string;         // actual bind address
  exposedOnLan?: boolean;
  accessKey?: string;    // bearer token remote clients must present
  error?: string;
};

let status: McpStatus = { running: false };
let server: http.Server | null = null;
let ipcRegistered = false;
// Mutable so a `regenerate` call takes effect on the running server's
// next request without needing to recreate the http.Server instance.
let currentAccessKey: string | null = null;

function firstLanIPv4(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function generateAccessKey(): string {
  // 6-digit PIN — easy to read off the screen and type into another
  // machine's config. Drawn from crypto.randomBytes (not Math.random) so
  // it's still unguessable; 10^6 = 1M codes is enough given the server
  // is only reachable on the local network when LAN exposure is on.
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

async function ensureAccessKey(): Promise<string> {
  const s = await loadSettings();
  // Only accept keys that match the new 6-digit format; any legacy
  // longer key gets replaced so the UI and Settings stay consistent.
  if (s.mcpAccessKey && /^\d{6}$/.test(s.mcpAccessKey)) return s.mcpAccessKey;
  const fresh = generateAccessKey();
  await patchSettings({ mcpAccessKey: fresh });
  return fresh;
}

function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  // Node reports IPv4-mapped IPv6 for IPv4 loopback when listening on
  // a dual-stack socket; cover all three forms.
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
};

function ok(msg: string | unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2) }] };
}
function err(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

const TOOLS: ToolDef[] = [
  { name: 'ide_workspace_root', description: 'Return the currently open workspace root path.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_list_dir', description: 'List entries in a directory of the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative path. Defaults to the workspace root.' } } } },
  { name: 'ide_walk_files', description: 'Recursively list every file in the workspace (excluding node_modules, .git, dist, out). Returns up to `limit` paths.', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max files to return (default 5000).' } } } },
  { name: 'ide_read_file', description: 'Read the UTF-8 contents of a file in the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'ide_write_file', description: 'Write UTF-8 contents to a file in the workspace. Creates parent directories if needed.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'ide_grep', description: 'Run ripgrep over the workspace and return the matching lines (file:line:col preview).', inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, caseSensitive: { type: 'boolean' } }, required: ['query'] } },
  { name: 'ide_listening_ports', description: 'List local TCP ports currently in LISTEN state (port, pid, command).', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_services_list', description: 'List the services registered in this workspace.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_services_start', description: 'Start a registered service by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_services_stop', description: 'Stop a running service by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_services_log', description: 'Return the tail of the captured stdout/stderr log for a service.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_run', description: 'Spawn a one-shot shell command in the workspace and capture its output. Use for build/test invocations, not long-running processes.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Optional working directory; defaults to workspace root.' }, timeoutMs: { type: 'number', description: 'Default 60000.' } }, required: ['command'] } },
  { name: 'ide_git_status', description: 'Run git status against a directory (defaults to the workspace root).', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'ide_git_diff', description: 'Run git diff against a directory.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, file: { type: 'string', description: 'Optional path to diff one file.' } } } },
  { name: 'ide_editor_state', description: 'Return the renderer-side editor state: active tab, all open tabs, optional selected text. May be stale by up to a few hundred milliseconds.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_open_file', description: 'Open a file in the editor (creating a tab) and optionally place the cursor at a position.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, col: { type: 'number' } }, required: ['path'] } },
  { name: 'ide_list_agents', description: 'List the AI agents available in this workspace — built-in agents (security-scan, code-quality, todo-collector, design-gallery) plus any the user created or imported. Returns each agent\'s slug, name, description, and runtime.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_run_agent', description: 'Run an AI agent by slug against the current workspace and return its full output once it finishes. Agents are self-contained Node.js apps; output is plain text or a complete HTML document. Use ide_list_agents first to see available slugs.', inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'The agent slug from ide_list_agents.' }, timeoutMs: { type: 'number', description: 'Max run time in ms (default 120000, max 600000).' } }, required: ['slug'] } },

  // REST client — let the AI hit any HTTP endpoint and manage the user's saved-request collection.
  { name: 'ide_rest_send', description: 'Send an arbitrary HTTP request from the IDE\'s REST client. Returns status, headers, and body. Supports JSON / raw / form bodies and bearer/basic auth.', inputSchema: { type: 'object', properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
    url: { type: 'string' },
    headers: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key', 'value'] } },
    params: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['key', 'value'] } },
    body: { type: 'object', description: 'One of {kind:"none"} | {kind:"json", text:string} | {kind:"text", text:string, contentType?:string} | {kind:"form", fields:[{key,value,enabled?}]}.' },
    auth: { type: 'object', description: 'One of {kind:"none"} | {kind:"bearer", token} | {kind:"basic", username, password}.' }
  }, required: ['method', 'url'] } },
  { name: 'ide_rest_list_saved', description: 'List the saved REST requests in this workspace (the right-panel REST collection).', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_rest_get_saved', description: 'Return one saved REST request by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_rest_save', description: 'Save (create or update) a REST request to the workspace collection. Pass an existing id to update, or omit it to create a fresh entry — a new id will be assigned and returned.', inputSchema: { type: 'object', properties: {
    id: { type: 'string', description: 'Existing saved-request id, or omit to create new.' },
    name: { type: 'string' },
    folder: { type: 'string' },
    method: { type: 'string' },
    url: { type: 'string' },
    headers: { type: 'array' },
    params: { type: 'array' },
    body: { type: 'object' },
    auth: { type: 'object' }
  }, required: ['name', 'method', 'url'] } },
  { name: 'ide_rest_delete', description: 'Delete a saved REST request by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_rest_open_saved', description: 'Open a saved REST request in the center workspace, optionally sending it immediately. Use with id from ide_rest_list_saved.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, send: { type: 'boolean', description: 'If true, fire the request as soon as it loads.' } }, required: ['id'] } },

  // IDE panel control — the right column hosts AI/DB/ES/REST; the bottom application bar hosts LOG/DEBUG. The AI can drive both.
  { name: 'ide_set_right_tab', description: 'Switch the right-panel tab. Valid values: "ai", "db", "es", "rest".', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['ai', 'db', 'es', 'rest'] } }, required: ['tab'] } },
  { name: 'ide_get_right_tab', description: 'Return which right-panel tab is currently selected.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_set_bottom_tab', description: 'Switch the bottom application-bar tab. Valid values: "log", "debug". Expands the bar if collapsed.', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['log', 'debug'] } }, required: ['tab'] } },
  { name: 'ide_get_bottom_tab', description: 'Return which bottom-bar tab is currently selected and whether the bar is collapsed.', inputSchema: { type: 'object', properties: {} } }
];

function resolveWorkspacePath(p: string | undefined): string {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open in the IDE.');
  if (!p) return root;
  return isAbsolute(p) ? p : resolve(root, p);
}

// --- Renderer-state pulls -------------------------------------------------
// Editor / open-tabs live in the renderer. We keep a cached snapshot pushed
// up from the renderer on change so MCP can answer instantly.
let editorSnapshot: unknown = null;
ipcMain.handle('mcp:editor-snapshot', (_e, snap) => { editorSnapshot = snap; return true; });
// Renderer-callable command channel (open file + cursor jump + right-tab + bottom-tab + REST).
type RendererCmd =
  | { kind: 'open-file'; path: string; line?: number; col?: number }
  | { kind: 'set-right-tab'; tab: string }
  | { kind: 'set-bottom-tab'; tab: string }
  | { kind: 'open-rest-saved'; savedId: string; send?: boolean };
const rendererListeners = new Set<(cmd: RendererCmd) => void>();
ipcMain.handle('mcp:subscribe-commands', () => true);
function dispatchToRenderer(cmd: RendererCmd) {
  // Broadcast over a known channel. The renderer side wires App.tsx to listen.
  import('./safeSend.js').then(({ safeSend }) => safeSend('mcp:command', cmd));
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated?: boolean }> {
  return await new Promise((resolveP) => {
    const proc = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    const cap = LIMITS.subprocessBytes;
    const enforceCap = () => {
      if (truncated) return;
      if (stdout.length + stderr.length > cap) {
        truncated = true;
        try { proc.kill('SIGTERM'); } catch {}
      }
    };
    const t = setTimeout(() => { timedOut = true; try { proc.kill('SIGTERM'); } catch {} }, timeoutMs);
    proc.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      stdout += b.toString('utf8');
      enforceCap();
    });
    proc.stderr.on('data', (b: Buffer) => {
      if (truncated) return;
      stderr += b.toString('utf8');
      enforceCap();
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      const tag = truncated ? `\n[output truncated — exceeded ${cap} bytes]` : '';
      resolveP({ stdout: stdout + tag, stderr, exitCode: code, timedOut, truncated });
    });
    proc.on('error', (e) => { clearTimeout(t); resolveP({ stdout, stderr: stderr + (e.message), exitCode: -1, timedOut, truncated }); });
  });
}

async function callTool(name: string, args: any): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  try {
    switch (name) {
      case 'ide_workspace_root':
        return ok(workspace.getRoot() ?? '(no workspace open)');

      case 'ide_list_dir': {
        const target = resolveWorkspacePath(args?.path);
        const items = await listDir(target);
        return ok(items.map(n => `${n.isDir ? 'd' : 'f'} ${n.path}`).join('\n'));
      }
      case 'ide_walk_files': {
        const root = workspace.getRoot();
        if (!root) throw new Error('No workspace open');
        const limit = Math.min(Math.max(1, Number(args?.limit) || 5000), 50_000);
        const files = await walkAllFiles(root, limit);
        return ok(files.join('\n'));
      }
      case 'ide_read_file': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        const st = await fs.stat(p);
        if (st.size > LIMITS.fileReadBytes) {
          const mb = (st.size / (1024 * 1024)).toFixed(1);
          const capMb = (LIMITS.fileReadBytes / (1024 * 1024)).toFixed(0);
          throw new Error(`File too large to read (${mb} MB; cap is ${capMb} MB): ${p}`);
        }
        const text = await fs.readFile(p, 'utf8');
        return ok(text);
      }
      case 'ide_write_file': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        const content = String(args?.content ?? '');
        await fs.mkdir(join(p, '..'), { recursive: true });
        await fs.writeFile(p, content, 'utf8');
        return ok(`wrote ${content.length} bytes to ${p}`);
      }
      case 'ide_grep': {
        const root = workspace.getRoot();
        if (!root) throw new Error('No workspace open');
        const query = String(args?.query ?? '');
        if (!query) throw new Error('query required');
        const cli = [rgPath, '--json', '--max-count', '500', ...(args?.caseSensitive ? [] : ['-i']),
          ...(args?.glob ? ['-g', String(args.glob)] : []), '--', query];
        const result = await runShell(cli.map(s => `'${String(s).replace(/'/g, `'\\''`)}'`).join(' '), root, 30_000);
        const hits: string[] = [];
        for (const line of result.stdout.split('\n')) {
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === 'match') {
              const p = j.data.path?.text ?? '';
              const ln = j.data.line_number ?? 0;
              const txt = (j.data.lines?.text ?? '').replace(/\n$/, '');
              hits.push(`${p}:${ln}: ${txt}`);
            }
          } catch {}
        }
        return ok(hits.join('\n') || '(no matches)');
      }
      case 'ide_listening_ports': {
        const ports = await listListeningPorts();
        return ok(ports.map(p => `${p.port} ${p.protocol} pid=${p.pid} ${p.command}`).join('\n') || '(none)');
      }
      case 'ide_services_list': {
        const list = await serviceManager.list();
        const statuses = serviceManager.allStatuses();
        const byId = new Map(statuses.map(r => [r.id, r]));
        return ok(list.map(s => ({
          id: s.id,
          name: s.name,
          command: s.command,
          cwd: s.cwd,
          status: byId.get(s.id)?.status ?? 'stopped',
          pid: byId.get(s.id)?.pid
        })));
      }
      case 'ide_services_start': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        const r = await serviceManager.start(id);
        return ok(r);
      }
      case 'ide_services_stop': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        await serviceManager.stop(id);
        return ok(`stopped ${id}`);
      }
      case 'ide_services_log': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        const log = serviceManager.log(id);
        return ok(log || '(empty)');
      }
      case 'ide_run': {
        const root = workspace.getRoot();
        if (!root) throw new Error('No workspace open');
        const cmd = String(args?.command ?? '');
        if (!cmd) throw new Error('command required');
        const cwd = args?.cwd ? resolveWorkspacePath(args.cwd) : root;
        const timeoutMs = Math.min(Math.max(1000, Number(args?.timeoutMs) || 60_000), 300_000);
        const r = await runShell(cmd, cwd, timeoutMs);
        return ok(`exit=${r.exitCode}${r.timedOut ? ' (TIMEOUT)' : ''}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
      }
      case 'ide_git_status': {
        const p = resolveWorkspacePath(args?.path);
        const g = simpleGit(p);
        const r = await g.status();
        return ok(r);
      }
      case 'ide_git_diff': {
        const p = resolveWorkspacePath(args?.path);
        const g = simpleGit(p);
        const r = args?.file ? await g.diff(['--', String(args.file)]) : await g.diff();
        return ok(r);
      }
      case 'ide_editor_state':
        return ok(editorSnapshot ?? '(not yet captured — open a file first)');
      case 'ide_open_file': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        dispatchToRenderer({ kind: 'open-file', path: p, line: args?.line, col: args?.col });
        return ok(`opening ${p}`);
      }
      case 'ide_list_agents': {
        const agents = await agentManager.list();
        return ok(agents.map(a => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          runtime: a.runtime,
          builtIn: a.createdBy === 'builtin'
        })));
      }
      case 'ide_run_agent': {
        const slug = String(args?.slug ?? '');
        if (!slug) throw new Error('slug required');
        const r = await agentManager.runAndCollect(slug, { timeoutMs: Number(args?.timeoutMs) || undefined });
        const header = `agent=${slug} exit=${r.exitCode}${r.timedOut ? ' (TIMEOUT)' : ''}`;
        return ok(`${header}\n--- output ---\n${r.output || '(no output)'}`);
      }

      case 'ide_rest_send': {
        if (!args?.method || !args?.url) throw new Error('method and url required');
        const r = await restApi.send({
          method: args.method,
          url: args.url,
          headers: args.headers ?? [],
          params: args.params ?? [],
          body: args.body ?? { kind: 'none' },
          auth: args.auth ?? { kind: 'none' }
        });
        return ok(r);
      }
      case 'ide_rest_list_saved': {
        const list = await restApi.readCollection();
        return ok(list.map(r => ({ id: r.id, name: r.name, folder: r.folder, method: r.method, url: r.url })));
      }
      case 'ide_rest_get_saved': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        const list = await restApi.readCollection();
        const r = list.find(x => x.id === id);
        if (!r) return err(`No saved request with id ${id}`);
        return ok(r);
      }
      case 'ide_rest_save': {
        if (!args?.name || !args?.method || !args?.url) throw new Error('name, method, and url required');
        const id = String(args.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const record: RestSavedRequest = {
          id,
          name: String(args.name),
          folder: args.folder ? String(args.folder) : undefined,
          method: args.method,
          url: String(args.url),
          headers: args.headers ?? [],
          params: args.params ?? [],
          body: args.body ?? { kind: 'none' },
          auth: args.auth ?? { kind: 'none' },
          updatedAt: Date.now()
        };
        await restApi.saveRequest(record);
        return ok({ id, saved: record });
      }
      case 'ide_rest_delete': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        await restApi.deleteRequest(id);
        return ok(`deleted ${id}`);
      }
      case 'ide_rest_open_saved': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        dispatchToRenderer({ kind: 'open-rest-saved', savedId: id, send: !!args?.send });
        return ok(`opening saved request ${id}${args?.send ? ' (and sending)' : ''}`);
      }
      case 'ide_set_right_tab': {
        const tab = String(args?.tab ?? '');
        if (!['ai', 'db', 'es', 'rest'].includes(tab)) {
          throw new Error('tab must be one of: ai, db, es, rest');
        }
        dispatchToRenderer({ kind: 'set-right-tab', tab });
        return ok(`right-tab set to ${tab}`);
      }
      case 'ide_get_right_tab': {
        const snap = editorSnapshot as { rightTab?: string } | null;
        return ok(snap?.rightTab ?? '(unknown — open the IDE)');
      }
      case 'ide_set_bottom_tab': {
        const tab = String(args?.tab ?? '');
        if (!['log', 'debug'].includes(tab)) {
          throw new Error('tab must be one of: log, debug');
        }
        dispatchToRenderer({ kind: 'set-bottom-tab', tab });
        return ok(`bottom-tab set to ${tab}`);
      }
      case 'ide_get_bottom_tab': {
        const snap = editorSnapshot as { bottomTab?: string; bottomCollapsed?: boolean } | null;
        return ok({ tab: snap?.bottomTab ?? '(unknown)', collapsed: snap?.bottomCollapsed ?? false });
      }
    }
    return err(`Unknown tool: ${name}`);
  } catch (e: any) {
    return err(e?.message || String(e));
  }
}

async function handleJsonRpc(req: any): Promise<any> {
  const id = req?.id;
  const method = req?.method;
  const params = req?.params ?? {};
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'opendev-ide', version: '0.3.0' }
    } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return null; // no response expected for notification
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const r = await callTool(params?.name, params?.arguments ?? {});
    return { jsonrpc: '2.0', id, result: r };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function registerMcpIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle(IPC.McpStatus, async () => {
    // Surface the key even when the server is off so the UI can still
    // show / copy it. Lazy-generate if it's never existed.
    if (!status.accessKey) {
      const s = await loadSettings();
      status = { ...status, accessKey: s.mcpAccessKey };
    }
    return status;
  });
  ipcMain.handle(IPC.McpRestart, async () => {
    await stopIdeMcpServer();
    const s = await loadSettings();
    if (s.mcpEnabled === false) return status;
    await startIdeMcpServer();
    return status;
  });
  ipcMain.handle(IPC.McpRegenerateKey, async () => {
    const fresh = generateAccessKey();
    await patchSettings({ mcpAccessKey: fresh });
    currentAccessKey = fresh;
    status = { ...status, accessKey: fresh };
    return status;
  });
}

export async function stopIdeMcpServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((res) => s.close(() => res()));
  status = { running: false };
}

export async function startIdeMcpServer(): Promise<void> {
  registerMcpIpc();
  if (server) return;
  const settings = await loadSettings();
  const exposeOnLan = settings.mcpExposeOnLan === true;
  const HOST = exposeOnLan ? HOST_ALL : HOST_LOOPBACK;
  // Ensure a stable bearer token exists so remote clients have something
  // to authenticate with. Loopback never sees the gate, but we generate
  // unconditionally so the Settings UI always has a key to display.
  currentAccessKey = await ensureAccessKey();
  server = http.createServer((req, res) => {
    // CORS so Claude / Codex desktop clients can also hit us if they run web
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method === 'GET') {
      // Discovery + health: return a tiny JSON banner
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'opendev-ide', version: '0.3.0', tools: TOOLS.length }));
      return;
    }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    // Bearer-token gate for non-loopback clients. The local IDE always
    // talks to itself over loopback and never needs to present a key;
    // any other origin (LAN, tunnel) must match the configured key.
    const remote = req.socket.remoteAddress || '';
    if (!isLoopbackAddress(remote)) {
      const auth = req.headers['authorization'] || '';
      const expected = currentAccessKey ? `Bearer ${currentAccessKey}` : '';
      if (!expected || auth !== expected) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer realm="opendev-mcp"');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized — set Authorization: Bearer <opendev MCP access key>' } }));
        return;
      }
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 10_000_000) { req.destroy(); } });
    req.on('end', async () => {
      let parsed: any;
      try { parsed = JSON.parse(body); }
      catch (e: any) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: ' + e.message } }));
        return;
      }
      try {
        const replies = await (Array.isArray(parsed)
          ? Promise.all(parsed.map(handleJsonRpc))
          : handleJsonRpc(parsed));
        res.setHeader('Content-Type', 'application/json');
        if (replies === null || (Array.isArray(replies) && replies.every(r => r == null))) {
          res.statusCode = 202; res.end(); return;
        }
        res.end(JSON.stringify(replies));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e?.message || String(e) } }));
      }
    });
  });
  await new Promise<void>((resolveP, rejectP) => {
    server!.once('error', (e: any) => {
      if (e?.code === 'EADDRINUSE') {
        status = { running: false, error: `Port ${PORT} already in use — close any other OpenDev IDE instance.` };
        rejectP(e);
      } else rejectP(e);
    });
    server!.listen(PORT, HOST, () => resolveP());
  }).catch((e) => { console.error('[mcp]', e?.message || e); });
  if (server && server.listening) {
    const loopback = `http://${HOST_LOOPBACK}:${PORT}/`;
    const lanIp = exposeOnLan ? firstLanIPv4() : null;
    status = {
      running: true,
      url: loopback,
      lanUrl: lanIp ? `http://${lanIp}:${PORT}/` : undefined,
      port: PORT,
      host: HOST,
      exposedOnLan: exposeOnLan,
      accessKey: currentAccessKey ?? undefined,
    };
    console.log(`[mcp] listening on ${HOST}:${PORT}${exposeOnLan ? ` (LAN: ${status.lanUrl ?? '<no LAN IP>'})` : ''}`);
  }
}

onShutdown(() => {
  if (server) { try { server.close(); } catch {} server = null; }
});
