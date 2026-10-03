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

import { jiraStore } from './jira.js';
import { app, ipcMain } from 'electron';
import http from 'http';
import os from 'os';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { cliChildEnv, commandShell } from './platform.js';
import { promises as fs } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { rgPath } from './ripgrep.js';
import { simpleGit } from 'simple-git';
import { IPC } from '@shared/ipc';
import { workspace, safeWithinRoot } from './workspace.js';
import { listDir, walkAllFiles } from './fs.js';
import { listListeningPorts } from './ports.js';
import { serviceManager } from './services.js';
import { agentManager } from './agents.js';
import { restApi } from './rest.js';
import { listBrowserTokens, scanBrowserStorage } from './browserTokens.js';
import { dbApi } from './db.js';
import { mlxServer } from './localModels.js';
import { listLocalModels } from './aiLocal.js';
import type { RestSavedRequest } from '@shared/types';
import { loadSettings, patchSettings } from './storage.js';
import { onShutdown } from './lifecycle.js';
import { LIMITS, capString, tail } from './limits.js';

// Fixed by default so an editor's MCP config can hard-code the URL. The env
// override exists so a second instance — notably the headless test server in
// src/headless/ — can run alongside the desktop app instead of losing the bind.
const PORT = Number(process.env.OPENDEV_MCP_PORT) || 53825;
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

const REST_AUTH_DOC = 'One of {kind:"none"} | {kind:"bearer", token} | {kind:"basic", username, password} | {kind:"browser", origin?}. '
  + '"browser" borrows the bearer token the IDE browser panel last sent (to the request\'s own origin, else the most recent one) at send time — '
  + 'use it for any endpoint that needs a signed-in user, instead of asking for a token. Pin origin (e.g. "http://localhost:8080") only when several APIs are captured.';

// The saved-request shape, shared by ide_rest_save and each item of ide_rest_save_many.
const REST_SAVED_PROPS = {
  id: { type: 'string', description: 'Existing saved-request id, or omit to create new.' },
  name: { type: 'string', description: 'Short label, e.g. "List users" or "Create order".' },
  folder: { type: 'string', description: 'Group in the REST panel — one per resource/controller, e.g. "Users".' },
  description: { type: 'string', description: 'What the endpoint does, its path/query params, required fields, and what it returns. Shown above the request in the REST tab.' },
  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
  url: { type: 'string', description: 'Full runnable URL including scheme, host and port, with example values filled in for path params.' },
  headers: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } } } },
  params: { type: 'array', description: 'Query-string params.', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' } } } },
  body: { type: 'object', description: 'One of {kind:"none"} | {kind:"json", text:string} | {kind:"text", text:string, contentType?:string} | {kind:"form", fields:[{key,value,enabled?}]}. For json, text is the serialized example payload.' },
  auth: { type: 'object', description: REST_AUTH_DOC }
};

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
    auth: { type: 'object', description: REST_AUTH_DOC }
  }, required: ['method', 'url'] } },
  { name: 'ide_rest_list_saved', description: 'List the saved REST requests in this workspace (the right-panel REST collection).', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_rest_get_saved', description: 'Return one saved REST request by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_rest_save', description: 'Save (create or update) ONE REST request to the workspace collection. Pass an existing id to update, or omit it to create a fresh entry — a new id will be assigned and returned. For more than one request use ide_rest_save_many.', inputSchema: { type: 'object', properties: REST_SAVED_PROPS, required: ['name', 'method', 'url'] } },
  { name: 'ide_rest_save_many', description: 'Save many REST requests to the REST tab in one call. This is the tool for "generate REST calls for the APIs in this repo". '
    + 'Workflow: (1) find every HTTP endpoint the repo defines (route decorators/annotations, router files, OpenAPI specs) — and, if asked, the external APIs it calls; '
    + '(2) work out the base URL from config (ports, env files, launch settings) or ide_browser_tokens / ide_listening_ports; '
    + '(3) emit one request per endpoint+method, folder = the resource/controller, ordered GET, POST, PUT, PATCH, DELETE; '
    + 'each with a description, a runnable URL with example path/query values, and a realistic example JSON body built from the actual DTO/model fields; '
    + '(4) use auth {kind:"browser"} for endpoints behind authentication. '
    + 'Idempotent: an entry with the same folder + method + URL path is updated in place, so re-running refreshes the collection rather than duplicating it. The REST tab is opened automatically.',
    inputSchema: { type: 'object', properties: {
      requests: { type: 'array', items: { type: 'object', properties: REST_SAVED_PROPS, required: ['name', 'method', 'url'] } }
    }, required: ['requests'] } },
  { name: 'ide_browser_tokens', description: 'List the bearer tokens the IDE browser panel has sent (masked — the raw token never leaves the IDE), per API origin, with expiry. Shows which API hosts the signed-in app talks to. Pass scan:true to also read JWTs out of the page\'s local/sessionStorage. If this is empty, tell the user to open their app in the browser panel and sign in before sending requests that use auth {kind:"browser"}.', inputSchema: { type: 'object', properties: { scan: { type: 'boolean' } } } },
  { name: 'ide_rest_delete', description: 'Delete a saved REST request by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_rest_open_saved', description: 'Open a saved REST request in the center workspace, optionally sending it immediately. Use with id from ide_rest_list_saved.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, send: { type: 'boolean', description: 'If true, fire the request as soon as it loads.' } }, required: ['id'] } },

  // IDE panel control — the right column hosts AI/DB/ES/REST/ML/LLM; the bottom application bar hosts LOG/DEBUG. The AI can drive both.
  { name: 'ide_jira_list', description: 'List the Jira tickets currently parked in the IDE\'s JIRA panel, with the state of each one\'s AI run (idle/running/done/failed/stopped).', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_jira_add', description: 'Add one or more Jira tickets to the JIRA panel as tasks to be completed. Pass issue keys (e.g. "BYZ-89"); each is fetched from Atlassian for its real summary, status and description. Use this when the user asks to add tickets to the jira tab.', inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' }, description: 'Issue keys, e.g. ["BYZ-89","BYZ-90"].' } }, required: ['keys'] } },
  { name: 'ide_jira_remove', description: 'Remove a ticket from the JIRA panel by its panel task id (from ide_jira_list). Does not touch the issue in Jira.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_jira_search', description: 'Search real Jira issues by JQL without adding them to the panel. Defaults to the user\'s open assigned issues.', inputSchema: { type: 'object', properties: { jql: { type: 'string' } } } },
  { name: 'ide_jira_start', description: 'Start the AI run for a parked ticket (panel task id from ide_jira_list). The run works the ticket in the workspace and, on success, posts a summary comment back to the Jira issue and transitions it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_jira_stop', description: 'Stop a running ticket\'s AI run (panel task id).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_jira_boards', description: 'List the ticket boards in this workspace (the .opendev/jira*.json files), with the ticket count in each and which one the JIRA panel is currently working in. Every other ide_jira_* tool operates on the active board.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_jira_rename_board', description: 'Rename a ticket board, keeping its tickets, and leave the JIRA panel on it. The name becomes the file name: "underwriting byz85" → .opendev/jira-underwriting-byz85.json. Pass the board to rename as a file name or label from ide_jira_boards; omit it to rename the active one.', inputSchema: { type: 'object', properties: { board: { type: 'string' }, name: { type: 'string', description: 'The new name, without the jira- prefix or .json suffix.' } }, required: ['name'] } },
  { name: 'ide_jira_select_board', description: 'Switch the JIRA panel to another board, so ide_jira_list/add/start all operate on it. Pass the file name ("jira-accounting-byz89.json") or its label ("accounting-byz89"); use ide_jira_boards to discover them.', inputSchema: { type: 'object', properties: { board: { type: 'string' } }, required: ['board'] } },
  { name: 'ide_set_right_tab', description: 'Switch the right-panel tab. Valid values: "ai", "db", "es", "rest", "ml", "llm", "jira".', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['ai', 'db', 'es', 'rest', 'ml', 'llm', 'jira'] } }, required: ['tab'] } },
  { name: 'ide_get_right_tab', description: 'Return which right-panel tab is currently selected.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_set_bottom_tab', description: 'Switch the bottom application-bar tab. Valid values: "log", "debug". Expands the bar if collapsed.', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['log', 'debug'] } }, required: ['tab'] } },
  { name: 'ide_get_bottom_tab', description: 'Return which bottom-bar tab is currently selected and whether the bar is collapsed.', inputSchema: { type: 'object', properties: {} } },

  // Filesystem mutations beyond ide_write_file (which only writes whole files).
  { name: 'ide_mkdir', description: 'Create a directory in the workspace (mkdir -p). No-op if it already exists.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'ide_copy', description: 'Copy a file or directory tree to a new location inside the workspace. Recursive for directories. Errors if the destination exists.', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean', description: 'Allow overwriting an existing destination (default false).' } }, required: ['from', 'to'] } },
  { name: 'ide_move', description: 'Move/rename a file or directory inside the workspace.', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'ide_delete', description: 'Delete a file or directory inside the workspace (recursive for directories).', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },

  // File-tree control (the left sidebar). Lets the AI reveal a path, expand
  // or collapse folders, and read the current expansion set.
  { name: 'ide_reveal_in_tree', description: 'Expand every ancestor folder of the given path in the left file tree and scroll it into view. Optionally select it.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, select: { type: 'boolean', description: 'Also select the revealed row (default true).' } }, required: ['path'] } },
  { name: 'ide_expand_tree', description: 'Expand a folder in the left file tree. With recursive=true, also expand every directory beneath it.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] } },
  { name: 'ide_collapse_tree', description: 'Collapse a folder (and everything beneath it) in the left file tree. Pass {all:true} to collapse the whole tree back to the workspace root.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, all: { type: 'boolean' } } } },
  { name: 'ide_focus_tree', description: 'Move keyboard focus to the left file tree.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_tree_state', description: 'Return which folders are currently expanded and which row(s) are selected in the left file tree.', inputSchema: { type: 'object', properties: {} } },

  // SQL / database connections. The IDE owns the connection pools; the AI
  // talks to them by profile id (use ide_db_list_connections to discover ids).
  { name: 'ide_db_list_connections', description: 'List all saved DB connection profiles in this workspace (SQL + Elasticsearch). Returns id, name, driver, host, port, database.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_db_connect', description: 'Open (or refresh) the connection pool for a saved profile by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_db_disconnect', description: 'Close the connection pool for a saved profile.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_db_list_databases', description: 'List the databases reachable through the given connection (MySQL/Postgres) or the cluster name (ES).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_db_switch_database', description: 'Switch the active database for a SQL connection. Closes and re-opens the pool.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, database: { type: 'string' } }, required: ['id', 'database'] } },
  { name: 'ide_db_schema', description: 'Return the schema (tables + columns) visible through a SQL connection.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'ide_db_query', description: 'Run a SQL statement against a connection and return its result. Read-only profiles refuse DML/DDL.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, sql: { type: 'string' } }, required: ['id', 'sql'] } },

  // Elasticsearch. Send a raw request via a saved ES connection profile.
  { name: 'ide_es_request', description: 'Send a request to Elasticsearch through a saved ES profile. Returns { status, body, durationMs }.', inputSchema: { type: 'object', properties: {
    id: { type: 'string', description: 'ES connection profile id.' },
    method: { type: 'string', description: 'HTTP method, default GET.' },
    path: { type: 'string', description: 'ES path, e.g. /_cat/indices?format=json, /my-index/_search. Defaults to /_search.' },
    body: { description: 'JSON body for the request (omit for GET).' }
  }, required: ['id'] } },

  // Local LLM server (MLX) — the right-panel LLM tab.
  { name: 'ide_llm_status', description: 'Return the current local-LLM server status: running, model, adapter, port, pid, recent log tail.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_llm_start', description: 'Start the local MLX-LM server with a model (and optional LoRA adapter). Replaces any running instance.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, adapter: { type: 'string', description: 'Optional LoRA adapter path.' }, port: { type: 'number' } }, required: ['model'] } },
  { name: 'ide_llm_stop', description: 'Stop the running local MLX-LM server, if any.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ide_llm_list_models', description: 'List the models the configured local LLM endpoint (Ollama / OpenAI-compatible) reports. Pass baseUrl to override the saved setting.', inputSchema: { type: 'object', properties: { baseUrl: { type: 'string' } } } }
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
// Renderer-callable command channel (open file + cursor jump + right-tab + bottom-tab + REST + tree).
type RendererCmd =
  | { kind: 'open-file'; path: string; line?: number; col?: number }
  | { kind: 'set-right-tab'; tab: string }
  | { kind: 'set-bottom-tab'; tab: string }
  | { kind: 'open-rest-saved'; savedId: string; send?: boolean }
  | { kind: 'tree-reveal'; path: string; select?: boolean }
  | { kind: 'tree-expand'; path: string; recursive?: boolean }
  | { kind: 'tree-collapse'; path?: string; all?: boolean }
  | { kind: 'tree-focus' };
const rendererListeners = new Set<(cmd: RendererCmd) => void>();
ipcMain.handle('mcp:subscribe-commands', () => true);
function dispatchToRenderer(cmd: RendererCmd) {
  // Broadcast over a known channel. The renderer side wires App.tsx to listen.
  import('./safeSend.js').then(({ safeSend }) => safeSend('mcp:command', cmd));
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated?: boolean }> {
  return await new Promise((resolveP) => {
    // Same scrubbed env + pinned cmd.exe as every other CLI we spawn. This is
    // the AI's own shell tool: a command it runs here (`claude -p …`, an npm
    // script that shells out to it) has to land on ~/.claude like the rest of
    // the AI stack, and `shell: true` alone would defer to COMSPEC — possibly
    // PowerShell, profile and all. See cliChildEnv / systemCmdExe.
    const proc = spawn(command, { cwd, shell: commandShell(), env: cliChildEnv() });
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

function toSavedRequest(a: any): RestSavedRequest {
  if (!a?.name || !a?.method || !a?.url) throw new Error('each request needs name, method, and url');
  return {
    id: String(a.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name: String(a.name),
    folder: a.folder ? String(a.folder) : undefined,
    description: a.description ? String(a.description) : undefined,
    method: String(a.method).toUpperCase() as RestSavedRequest['method'],
    url: String(a.url),
    headers: Array.isArray(a.headers) ? a.headers : [],
    params: Array.isArray(a.params) ? a.params : [],
    body: a.body ?? { kind: 'none' },
    auth: a.auth ?? { kind: 'none' },
    updatedAt: Date.now()
  };
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
        const record = toSavedRequest(args);
        await restApi.saveRequest(record);
        dispatchToRenderer({ kind: 'set-right-tab', tab: 'rest' });
        return ok({ id: record.id, saved: record });
      }
      case 'ide_rest_save_many': {
        const items = Array.isArray(args?.requests) ? args.requests : [];
        if (!items.length) throw new Error('requests required');
        const r = await restApi.saveMany(items.map(toSavedRequest));
        dispatchToRenderer({ kind: 'set-right-tab', tab: 'rest' });
        const folders = [...new Set(items.map((i: any) => i.folder || '(no folder)'))];
        return ok(`saved ${items.length} request(s): ${r.created} new, ${r.updated} updated, across ${folders.length} folder(s): ${folders.join(', ')}`);
      }
      case 'ide_browser_tokens': {
        if (args?.scan) await scanBrowserStorage();
        const tokens = listBrowserTokens();
        if (!tokens.length) return ok('No bearer tokens captured yet. The user needs to open their app in the IDE browser panel and sign in (or pass scan:true after they have).');
        return ok(tokens.map((t) => ({
          origin: t.origin, lastUrl: t.url, source: t.source, token: t.preview,
          expires: t.expiresAt ? new Date(t.expiresAt).toISOString() : 'unknown',
          expired: t.expiresAt ? t.expiresAt < Date.now() : false
        })));
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
      case 'ide_jira_list': {
        const tasks = await jiraStore.list();
        return ok(JSON.stringify(tasks.map((t) => ({
          id: t.id, key: t.key, title: t.title, jiraStatus: t.status,
          run: t.state, lastLine: t.lastLine, reportedAt: t.reportedAt, reportError: t.reportError
        })), null, 2));
      }
      case 'ide_jira_add': {
        const keys = Array.isArray(args?.keys) ? args.keys.map(String) : [];
        if (!keys.length) throw new Error('keys required');
        const added: string[] = [];
        const errors: string[] = [];
        for (const k of keys) {
          try { const t = await jiraStore.addByKey(k); added.push(`${t.key} (${t.id}) — ${t.title}`); }
          catch (err: any) { errors.push(`${k}: ${err?.message ?? err}`); }
        }
        dispatchToRenderer({ kind: 'set-right-tab', tab: 'jira' });
        return ok([
          added.length ? `Added:\n${added.join('\n')}` : 'Nothing added.',
          errors.length ? `\nFailed:\n${errors.join('\n')}` : ''
        ].join(''));
      }
      case 'ide_jira_remove': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        await jiraStore.remove(id);
        return ok(`removed ${id} from the JIRA panel`);
      }
      case 'ide_jira_boards': {
        const { boards, active } = await jiraStore.boards();
        return ok(JSON.stringify({
          active,
          boards: boards.map((b) => ({ file: b.file, label: b.label, tickets: b.count }))
        }, null, 2));
      }
      case 'ide_jira_rename_board': {
        const name = String(args?.name ?? '').trim();
        if (!name) throw new Error('name required');
        const { boards, active } = await jiraStore.boards();
        const want = String(args?.board ?? '').trim() || active;
        const hit = boards.find((b) => b.file.toLowerCase() === want.toLowerCase())
          ?? boards.find((b) => b.label.toLowerCase() === want.toLowerCase());
        if (!hit) {
          throw new Error(`no such board: ${want} (have: ${boards.map((b) => b.label).join(', ') || 'none'})`);
        }
        const res = await jiraStore.renameBoard(hit.file, name);
        dispatchToRenderer({ kind: 'set-right-tab', tab: 'jira' });
        return ok(`renamed board "${hit.file}" to "${res.file}" — ${res.tasks.length} ticket(s), now active`);
      }
      case 'ide_jira_select_board': {
        const want = String(args?.board ?? '').trim();
        if (!want) throw new Error('board required');
        const { boards } = await jiraStore.boards();
        const hit = boards.find((b) => b.file.toLowerCase() === want.toLowerCase())
          ?? boards.find((b) => b.label.toLowerCase() === want.toLowerCase());
        if (!hit) {
          throw new Error(`no such board: ${want} (have: ${boards.map((b) => b.label).join(', ') || 'none'})`);
        }
        const tasks = await jiraStore.selectBoard(hit.file);
        dispatchToRenderer({ kind: 'set-right-tab', tab: 'jira' });
        return ok(`JIRA panel is now on board "${hit.label}" (${hit.file}) — ${tasks.length} ticket(s)`);
      }
      case 'ide_jira_search': {
        const issues = await jiraStore.search(args?.jql ? String(args.jql) : undefined);
        return ok(JSON.stringify(issues.map((i) => ({ key: i.key, title: i.title, status: i.status })), null, 2));
      }
      case 'ide_jira_start': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        const t = await jiraStore.start(id);
        if (!t) throw new Error(`no such task, or it is already running: ${id}`);
        dispatchToRenderer({ kind: 'set-right-tab', tab: 'jira' });
        return ok(`started run for ${t.key}`);
      }
      case 'ide_jira_stop': {
        const id = String(args?.id ?? '');
        if (!id) throw new Error('id required');
        return ok(await jiraStore.stop(id) ? `stopped ${id}` : `${id} was not running`);
      }
      case 'ide_set_right_tab': {
        const tab = String(args?.tab ?? '');
        if (!['ai', 'db', 'es', 'rest', 'ml', 'llm', 'jira'].includes(tab)) {
          throw new Error('tab must be one of: ai, db, es, rest, ml, llm, jira');
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

      // --- filesystem mutations ---------------------------------------
      case 'ide_mkdir': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        await fs.mkdir(p, { recursive: true });
        return ok(`created ${p}`);
      }
      case 'ide_copy': {
        if (!args?.from || !args?.to) throw new Error('from and to required');
        const from = resolveWorkspacePath(String(args.from));
        const to = resolveWorkspacePath(String(args.to));
        if (!safeWithinRoot(from) || !safeWithinRoot(to)) throw new Error('Path outside workspace');
        await fs.mkdir(join(to, '..'), { recursive: true });
        await fs.cp(from, to, { recursive: true, force: !!args.overwrite, errorOnExist: !args.overwrite });
        return ok(`copied ${from} → ${to}`);
      }
      case 'ide_move': {
        if (!args?.from || !args?.to) throw new Error('from and to required');
        const from = resolveWorkspacePath(String(args.from));
        const to = resolveWorkspacePath(String(args.to));
        if (!safeWithinRoot(from) || !safeWithinRoot(to)) throw new Error('Path outside workspace');
        await fs.mkdir(join(to, '..'), { recursive: true });
        await fs.rename(from, to);
        return ok(`moved ${from} → ${to}`);
      }
      case 'ide_delete': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        if (p === workspace.getRoot()) throw new Error('Refusing to delete the workspace root');
        await fs.rm(p, { recursive: true, force: true });
        return ok(`deleted ${p}`);
      }

      // --- file-tree control -----------------------------------------
      case 'ide_reveal_in_tree': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        dispatchToRenderer({ kind: 'tree-reveal', path: p, select: args?.select !== false });
        return ok(`revealing ${p}`);
      }
      case 'ide_expand_tree': {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        dispatchToRenderer({ kind: 'tree-expand', path: p, recursive: !!args?.recursive });
        return ok(`expanding ${p}${args?.recursive ? ' (recursive)' : ''}`);
      }
      case 'ide_collapse_tree': {
        if (args?.all) { dispatchToRenderer({ kind: 'tree-collapse', all: true }); return ok('collapsed all'); }
        if (!args?.path) throw new Error('path or all=true required');
        const p = resolveWorkspacePath(args.path);
        if (!safeWithinRoot(p)) throw new Error('Path outside workspace');
        dispatchToRenderer({ kind: 'tree-collapse', path: p });
        return ok(`collapsed ${p}`);
      }
      case 'ide_focus_tree': {
        dispatchToRenderer({ kind: 'tree-focus' });
        return ok('focusing file tree');
      }
      case 'ide_tree_state': {
        const snap = editorSnapshot as { treeExpanded?: string[]; treeSelected?: string[] } | null;
        return ok({
          expanded: snap?.treeExpanded ?? [],
          selected: snap?.treeSelected ?? []
        });
      }

      // --- DB tools ---------------------------------------------------
      case 'ide_db_list_connections': {
        const profiles = await dbApi.listProfiles();
        return ok(profiles.map(p => ({ id: p.id, name: p.name, driver: p.driver, host: p.host, port: p.port, database: p.database, readOnly: p.readOnly })));
      }
      case 'ide_db_connect': {
        if (!args?.id) throw new Error('id required');
        await dbApi.connect(String(args.id));
        return ok(`connected ${args.id}`);
      }
      case 'ide_db_disconnect': {
        if (!args?.id) throw new Error('id required');
        await dbApi.disconnect(String(args.id));
        return ok(`disconnected ${args.id}`);
      }
      case 'ide_db_list_databases': {
        if (!args?.id) throw new Error('id required');
        return ok(await dbApi.listDatabases(String(args.id)));
      }
      case 'ide_db_switch_database': {
        if (!args?.id || !args?.database) throw new Error('id and database required');
        await dbApi.switchDatabase(String(args.id), String(args.database));
        return ok(`${args.id} → ${args.database}`);
      }
      case 'ide_db_schema': {
        if (!args?.id) throw new Error('id required');
        return ok(await dbApi.schema(String(args.id)));
      }
      case 'ide_db_query': {
        if (!args?.id || !args?.sql) throw new Error('id and sql required');
        return ok(await dbApi.query(String(args.id), String(args.sql)));
      }

      // --- ES tool ----------------------------------------------------
      case 'ide_es_request': {
        if (!args?.id) throw new Error('id required');
        return ok(await dbApi.esRequest(String(args.id), {
          method: args.method ? String(args.method) : undefined,
          path: args.path ? String(args.path) : undefined,
          body: args.body
        }));
      }

      // --- Local LLM (MLX) -------------------------------------------
      case 'ide_llm_status':
        return ok(mlxServer.getStatus());
      case 'ide_llm_start': {
        if (!args?.model) throw new Error('model required');
        await mlxServer.start({ model: String(args.model), adapter: args?.adapter ? String(args.adapter) : null, port: typeof args?.port === 'number' ? args.port : undefined });
        return ok(mlxServer.getStatus());
      }
      case 'ide_llm_stop':
        await mlxServer.stop();
        return ok(mlxServer.getStatus());
      case 'ide_llm_list_models': {
        const r = await listLocalModels(args?.baseUrl ? String(args.baseUrl) : undefined);
        return ok(r);
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

/**
 * CLI args that hand this server to a Claude CLI the IDE spawns (the AI chat,
 * Jira runs), so the built-in AI gets every ide_* tool without the user wiring
 * ~/.claude.json by hand. Written to a file rather than passed inline: the
 * JSON would have to survive cmd.exe quoting on Windows. Same server name as
 * the Settings snippet, so a user who also configured it by hand does not get
 * the tools twice. Empty when the server is off.
 */
export async function cliMcpConfigArgs(): Promise<string[]> {
  if (!status.running || !status.url || !currentAccessKey) return [];
  try {
    const file = join(app.getPath('userData'), 'opendev-mcp.json');
    const cfg = { mcpServers: { 'opendev-ide': { type: 'http', url: status.url, headers: { Authorization: `Bearer ${currentAccessKey}` } } } };
    await fs.writeFile(file, JSON.stringify(cfg, null, 2), 'utf8');
    return ['--mcp-config', file];
  } catch (e: any) {
    console.error('[mcp] could not write CLI config:', e?.message || e);
    return [];
  }
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
    // Bearer-token gate for ALL clients (loopback included). Tools can
    // read/write files, run shell commands, and execute agents — there
    // is no scenario where we want the gate skipped. External CLIs put
    // the PIN in their ~/.claude.json `headers` block.
    {
      const auth = req.headers['authorization'] || '';
      const expected = currentAccessKey ? `Bearer ${currentAccessKey}` : '';
      if (!expected || auth !== expected) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer realm="opendev-mcp"');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized — set Authorization: Bearer <opendev MCP access PIN from Settings → AI>' } }));
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
