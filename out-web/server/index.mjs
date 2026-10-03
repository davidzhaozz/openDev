import http, { createServer as createServer$1, request } from "http";
import { readFileSync, existsSync, promises, watch, watchFile, unwatchFile, mkdirSync, createWriteStream, readdirSync, statSync, createReadStream } from "fs";
import { join, dirname, delimiter, isAbsolute, resolve, basename, extname, relative, sep, normalize } from "path";
import { randomUUID, randomBytes, createHmac, timingSafeEqual as timingSafeEqual$1 } from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import os, { homedir, tmpdir, hostname, platform, cpus, totalmem, freemem, loadavg } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn, execFileSync, exec, execSync, spawnSync, execFile } from "child_process";
import { rgPath } from "@vscode/ripgrep";
import fuzzysort from "fuzzysort";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node.js";
import { promisify } from "util";
import net, { createServer, connect } from "net";
import { simpleGit } from "simple-git";
import { createSocket } from "dgram";
const invokeHandlers = /* @__PURE__ */ new Map();
const syncHandlers = /* @__PURE__ */ new Map();
const ipcMain = {
  handle(channel, fn) {
    invokeHandlers.set(channel, fn);
  },
  handleOnce(channel, fn) {
    invokeHandlers.set(channel, (...a) => {
      invokeHandlers.delete(channel);
      return fn(...a);
    });
  },
  removeHandler(channel) {
    invokeHandlers.delete(channel);
  },
  on(channel, fn) {
    syncHandlers.set(channel, fn);
    return ipcMain;
  },
  removeAllListeners(channel) {
    if (channel) syncHandlers.delete(channel);
    else syncHandlers.clear();
    return ipcMain;
  }
};
async function dispatchInvoke(channel, args) {
  const fn = invokeHandlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for "${channel}"`);
  return await fn({ sender: null }, ...args);
}
function dispatchSync(channel, args) {
  const fn = syncHandlers.get(channel);
  if (!fn) return void 0;
  const event = { sender: null };
  fn(event, ...args);
  return event.returnValue;
}
let broadcast = () => {
};
function setBroadcaster(fn) {
  broadcast = fn;
}
const pseudoWebContents = {
  isDestroyed: () => false,
  send: (channel, ...args) => broadcast(channel, args)
};
class BrowserWindow {
  static getAllWindows() {
    return [{ isDestroyed: () => false, webContents: pseudoWebContents }];
  }
  static getFocusedWindow() {
    return null;
  }
  constructor() {
    throw new Error("BrowserWindow is not available in the OpenDev web server");
  }
}
function findAppRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "node_modules"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
const appRoot = process.env.OPENDEV_APP_ROOT || findAppRoot();
const appVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
function appDataRoot() {
  if (process.env.OPENDEV_DATA_DIR) return process.env.OPENDEV_DATA_DIR;
  return join(homedir(), "Library", "Application Support");
}
function logsRoot() {
  if (process.env.OPENDEV_DATA_DIR) return join(process.env.OPENDEV_DATA_DIR, "logs");
  return join(homedir(), "Library", "Logs", "OpenDev IDE");
}
let appName = "OpenDev IDE";
const app = {
  getName: () => appName,
  setName: (n) => {
    appName = n;
  },
  getVersion: () => appVersion,
  getAppPath: () => appRoot,
  isPackaged: false,
  getPath(name) {
    switch (name) {
      case "appData":
        return appDataRoot();
      case "userData":
        return join(appDataRoot(), appName);
      case "logs":
        return logsRoot();
      case "home":
        return homedir();
      case "temp":
        return tmpdir();
      case "downloads":
        return join(homedir(), "Downloads");
      case "documents":
        return join(homedir(), "Documents");
      case "desktop":
        return join(homedir(), "Desktop");
      case "exe":
        return process.execPath;
      default:
        return join(appDataRoot(), appName, name);
    }
  },
  // Lifecycle is owned by src/server/index.ts; these keep main-process code
  // that reaches for them from crashing.
  whenReady: () => Promise.resolve(),
  on: () => app,
  once: () => app,
  quit: () => {
    process.emit("SIGTERM");
  },
  exit: (code = 0) => process.exit(code),
  relaunch: () => {
  },
  commandLine: { appendSwitch: () => {
  }, appendArgument: () => {
  } }
};
const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: void 0 }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (title, content) => console.error(`[dialog] ${title}: ${content}`)
};
const shell = {
  // Hand the URL to the browser that asked for it rather than opening a
  // window on the server's desktop.
  openExternal: async (url) => {
    broadcast("web:open-external", [url]);
  },
  showItemInFolder: (p) => {
    broadcast("web:reveal-unsupported", [p]);
  },
  openPath: async () => ""
};
const IPC = {
  // workspace
  WorkspaceOpen: "workspace:open",
  WorkspacePick: "workspace:pick",
  WorkspaceCurrent: "workspace:current",
  WorkspaceChanged: "workspace:changed",
  WorkspaceClose: "workspace:close",
  MenuEvent: "menu:event",
  // fs
  FsList: "fs:list",
  FsRead: "fs:read",
  FsWrite: "fs:write",
  FsRename: "fs:rename",
  FsDelete: "fs:delete",
  FsCreate: "fs:create",
  FsReveal: "fs:reveal",
  FsWatchEvent: "fs:watch-event",
  FsWatch: "fs:watch",
  FsUnwatch: "fs:unwatch",
  // Per-open-file change detection (editor reload-on-disk-change).
  FsWatchFile: "fs:watch-file",
  FsUnwatchFile: "fs:unwatch-file",
  FsFileChanged: "fs:file-changed",
  // search
  SearchFuzzy: "search:fuzzy",
  SearchGrep: "search:grep",
  SearchGrepHit: "search:grep-hit",
  SearchGrepDone: "search:grep-done",
  // lsp
  LspRequest: "lsp:request",
  LspNotify: "lsp:notify",
  LspDiagnostics: "lsp:diagnostics",
  // ai
  AiSend: "ai:send",
  AiStream: "ai:stream",
  AiConversations: "ai:conversations",
  AiConversationGet: "ai:conversation-get",
  AiConversationDelete: "ai:conversation-delete",
  AiCancel: "ai:cancel",
  AiLocalListModels: "ai-local:list-models",
  AiLocalPickBinary: "ai-local:pick-binary",
  // mcp
  McpStatus: "mcp:status",
  McpRestart: "mcp:restart",
  McpRegenerateKey: "mcp:regenerate-key",
  // app lifecycle
  AppRelaunch: "app:relaunch",
  // browser
  BrowserScreenshotRect: "browser:screenshot-rect",
  BrowserPicked: "browser:picked",
  // services
  ServicesList: "services:list",
  ServicesSave: "services:save",
  ServicesDelete: "services:delete",
  ServicesStart: "services:start",
  ServicesStop: "services:stop",
  ServicesRestart: "services:restart",
  ServicesDeriveFromDir: "services:derive-from-dir",
  ServicesStatus: "services:status",
  ServicesLog: "services:log",
  ServicesPorts: "services:ports",
  ServicesChanged: "services:changed",
  // ports
  PortsList: "ports:list",
  PortsFree: "ports:free",
  // tasks
  TasksList: "tasks:list",
  TasksSave: "tasks:save",
  TasksDelete: "tasks:delete",
  // db
  DbConnectionsList: "db:connections-list",
  DbConnectionsSave: "db:connections-save",
  DbConnectionsDelete: "db:connections-delete",
  DbConnect: "db:connect",
  DbTest: "db:test",
  DbListDatabases: "db:list-databases",
  DbSwitchDatabase: "db:switch-database",
  DbEsRequest: "db:es-request",
  DbDisconnect: "db:disconnect",
  DbSchema: "db:schema",
  DbQuery: "db:query",
  DbUpdateRows: "db:update-rows",
  // git
  GitStatus: "git:status",
  GitDiff: "git:diff",
  GitStage: "git:stage",
  GitUnstage: "git:unstage",
  GitCommit: "git:commit",
  GitPush: "git:push",
  GitPull: "git:pull",
  GitBranch: "git:branch",
  GitCheckout: "git:checkout",
  GitBranchesAt: "git:branches-at",
  GitCheckoutAt: "git:checkout-at",
  GitLog: "git:log",
  GitBlame: "git:blame",
  GitFileLog: "git:file-log",
  GitShow: "git:show",
  SessionSave: "session:save",
  SessionLoad: "session:load",
  WindowPopoutFile: "window:popout-file",
  WindowPopoutAi: "window:popout-ai",
  GitWorktreeCreate: "git:worktree-create",
  GitWorktreeList: "git:worktree-list",
  GitWorktreeRemove: "git:worktree-remove",
  GitWorktreeMerge: "git:worktree-merge",
  // terminal
  TermCreate: "term:create",
  TermWrite: "term:write",
  TermResize: "term:resize",
  TermKill: "term:kill",
  TermData: "term:data",
  TermExit: "term:exit",
  // settings
  SettingsGet: "settings:get",
  SettingsSet: "settings:set",
  // ai agents
  AgentsList: "agents:list",
  AgentsCreate: "agents:create",
  AgentsImport: "agents:import",
  AgentsImportPick: "agents:import-pick",
  AgentsRun: "agents:run",
  AgentsStop: "agents:stop",
  AgentsDelete: "agents:delete",
  AgentStream: "agents:stream",
  // main → renderer
  AgentsChanged: "agents:changed",
  // main → renderer
  // lan peers
  PeersList: "peers:list",
  PeersStatus: "peers:status",
  PeersSetLinkKey: "peers:set-link-key",
  PeersSetEnabled: "peers:set-enabled",
  PeersPushRepo: "peers:push-repo",
  PeersChanged: "peers:changed",
  // main → renderer
  // debugger
  DebugStart: "debug:start",
  DebugRequest: "debug:request",
  DebugStop: "debug:stop",
  DebugEvent: "debug:event",
  // main → renderer
  // new-project wizard
  ProjectsList: "projects:list",
  ProjectsCreate: "projects:create",
  ProjectsCreateLog: "projects:create-log",
  // main → renderer (progress)
  ProjectsPickDir: "projects:pick-dir",
  // add-package wizard
  PackagesDetect: "packages:detect",
  PackagesAdd: "packages:add",
  PackagesAddLog: "packages:add-log",
  // main → renderer (progress)
  // query history (sql + es + rest)
  HistoryRead: "history:read",
  HistoryAppend: "history:append",
  HistoryClear: "history:clear",
  // rest client
  RestSend: "rest:send",
  RestListSaved: "rest:list-saved",
  RestSave: "rest:save",
  RestDelete: "rest:delete",
  // run configurations (PyCharm-style)
  RunConfigsList: "run-configs:list",
  RunConfigsSave: "run-configs:save",
  RunConfigsDelete: "run-configs:delete",
  RunsStart: "runs:start",
  RunsStartAdHoc: "runs:start-adhoc",
  RunsStop: "runs:stop",
  RunsList: "runs:list",
  RunsLog: "runs:log",
  // main → renderer (stdout/stderr chunk)
  RunsStatus: "runs:status",
  // main → renderer (state change)
  RunsChanged: "runs:changed",
  // main → renderer (config list mutated)
  // local LLM models (mlx_lm.server). Ollama support was removed in
  // v0.6.22 — users who run ollama can point any OpenAI-compat client at
  // it directly; the IDE focuses on what it can drive end-to-end.
  LlmMlxStart: "llm:mlx-start",
  LlmMlxStop: "llm:mlx-stop",
  LlmMlxStatus: "llm:mlx-status",
  LlmMlxStatusChanged: "llm:mlx-status-changed",
  // main → renderer
  LlmMlxLog: "llm:mlx-log",
  // main → renderer
  // pip / python packages
  PipList: "pip:list",
  PipOutdated: "pip:outdated",
  PipInstall: "pip:install",
  PipUninstall: "pip:uninstall",
  PipUpgrade: "pip:upgrade",
  PipReadRequirements: "pip:read-requirements",
  PipInstallRequirements: "pip:install-requirements",
  PipLog: "pip:log",
  // main → renderer (streaming pip output)
  PipBusy: "pip:busy",
  // main → renderer (true while an operation runs)
  // python interpreter
  PythonList: "python:list",
  PythonGet: "python:get",
  PythonSet: "python:set",
  PythonCreateVenv: "python:create-venv",
  PythonVenvLog: "python:venv-log",
  // main → renderer (venv creation log lines)
  PythonChanged: "python:changed",
  // main → renderer (selected interpreter changed)
  // mlx / ml project
  MlxDetect: "mlx:detect",
  MlxListAdapters: "mlx:list-adapters",
  MlxReadLog: "mlx:read-log",
  MlxStart: "mlx:start",
  MlxStop: "mlx:stop",
  MlxStatus: "mlx:status",
  MlxEvent: "mlx:event",
  // main → renderer (parsed training events)
  // memory watchdog (main → renderer)
  MemoryWarning: "memory:warning",
  // system stats (main → renderer, broadcast every ~2s)
  SystemStats: "system:stats",
  // explicit memory-reclaim trigger from the UI
  SystemFreeMemory: "system:free-memory"
};
let baseDir = "";
const DEFAULT_SETTINGS = {
  recentWorkspaces: [],
  theme: "dark"
};
function getStorageDir() {
  return baseDir;
}
async function initStorage() {
  baseDir = join(app.getPath("appData"), "openDev");
  await promises.mkdir(baseDir, { recursive: true });
  await promises.mkdir(join(baseDir, "conversations"), { recursive: true });
  await promises.mkdir(join(baseDir, "services"), { recursive: true });
  await promises.mkdir(join(baseDir, "tasks"), { recursive: true });
}
async function readJson(path, fallback) {
  try {
    const raw = await promises.readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err2) {
    if (err2?.code === "ENOENT") return fallback;
    throw err2;
  }
}
async function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  await promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await promises.rename(tmp, path);
}
const settingsPath = () => join(baseDir, "settings.json");
async function loadSettings() {
  return readJson(settingsPath(), DEFAULT_SETTINGS);
}
async function saveSettings(settings) {
  await writeJson(settingsPath(), settings);
}
async function patchSettings(patch) {
  const s = await loadSettings();
  const next = { ...s, ...patch };
  await saveSettings(next);
  return next;
}
let cachedMachineId = null;
async function getMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const idFile = join(baseDir, "machine-id");
  try {
    cachedMachineId = (await promises.readFile(idFile, "utf8")).trim();
    if (cachedMachineId) return cachedMachineId;
  } catch {
  }
  cachedMachineId = randomUUID();
  await promises.writeFile(idFile, cachedMachineId, "utf8");
  return cachedMachineId;
}
function getMachineName() {
  return hostname();
}
function safeSend(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.send(channel, ...args);
    } catch {
    }
  }
}
const safeSend$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  safeSend
}, Symbol.toStringTag, { value: "Module" }));
function splitPath(p) {
  return p.split("/").filter(Boolean);
}
function baseName(p) {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : p;
}
function dirName(p) {
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  return p.slice(0, i);
}
function isAbsolutePath(p) {
  return p.startsWith("/");
}
function toPosix(p) {
  return p;
}
function isWithin(child, parent) {
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  return c === p || c.startsWith(`${p}/`);
}
function pathToFileUri(p) {
  const rooted = p.startsWith("/") ? p : `/${p}`;
  return "file://" + rooted.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}
class Workspace {
  root;
  watchers = /* @__PURE__ */ new Map();
  getRoot() {
    return this.root;
  }
  async restoreLast() {
    const s = await loadSettings();
    if (s.workspaceRoot) {
      try {
        await this.open(s.workspaceRoot, false);
      } catch (err2) {
        console.error("Failed to restore workspace", err2);
      }
    }
  }
  async close() {
    if (!this.root) return;
    await this.stopWatchers();
    this.root = void 0;
    await patchSettings({ workspaceRoot: void 0 });
    safeSend(IPC.WorkspaceChanged, void 0);
  }
  async open(path, persist = true) {
    if (this.root === path) return;
    await this.stopWatchers();
    this.root = path;
    if (persist) {
      const s = await loadSettings();
      const recent = [path, ...s.recentWorkspaces.filter((p) => p !== path)].slice(0, 10);
      await patchSettings({ workspaceRoot: path, recentWorkspaces: recent });
    }
    try {
      const py = await Promise.resolve().then(() => python);
      py.invalidatePythonCache();
    } catch {
    }
    this.watchDir(path);
    safeSend(IPC.WorkspaceChanged, path);
  }
  watchDir(dir) {
    if (this.watchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: true, recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const full = join(dir, filename.toString());
        const type = eventType === "rename" ? "add" : "change";
        safeSend(IPC.FsWatchEvent, { type, path: full });
        Promise.resolve().then(() => search).then((s) => s.invalidateFileIndex()).catch(() => {
        });
      });
      w.on("error", () => this.watchers.delete(dir));
      this.watchers.set(dir, w);
    } catch (err2) {
      console.warn(`[watch] failed to watch ${dir}:`, err2.message);
    }
  }
  unwatchDir(dir) {
    const w = this.watchers.get(dir);
    if (w) {
      try {
        w.close();
      } catch {
      }
      this.watchers.delete(dir);
    }
  }
  async stopWatchers() {
    for (const [, w] of this.watchers) {
      try {
        w.close();
      } catch {
      }
    }
    this.watchers.clear();
  }
}
const workspace = new Workspace();
const requireRoot = () => {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  return root;
};
function safeWithinRoot(p) {
  const root = workspace.getRoot();
  if (!root) return false;
  return isWithin(join(p), root);
}
let fileIndex = null;
let indexing = null;
const STALE_MS = 3e4;
async function ensureIndex() {
  const root = workspace.getRoot();
  if (!root) return;
  const fresh = fileIndex && fileIndex.root === root && Date.now() - fileIndex.builtAt < STALE_MS;
  if (fresh) return;
  if (indexing) return indexing;
  indexing = (async () => {
    const files = await walkAllFiles(root);
    fileIndex = { root, files, builtAt: Date.now() };
    indexing = null;
  })();
  return indexing;
}
function invalidateFileIndex() {
  fileIndex = null;
}
let activeGrep = null;
function registerSearchIpc() {
  ipcMain.handle(IPC.SearchFuzzy, async (_e, query, limit = 40) => {
    await ensureIndex();
    if (!fileIndex) return [];
    if (!query) return fileIndex.files.slice(0, limit).map((path) => ({ path, score: 0 }));
    const root = fileIndex.root;
    const results = fuzzysort.go(query, fileIndex.files, {
      limit,
      threshold: -1e4
    });
    return results.map((r) => ({
      path: r.target,
      score: r.score,
      relative: isWithin(r.target, root) && r.target.length > root.length ? toPosix(r.target.slice(root.length + 1)) : r.target
    }));
  });
  ipcMain.handle(IPC.SearchGrep, async (_e, query, opts) => {
    const root = workspace.getRoot();
    if (!root || !query) return false;
    if (activeGrep) {
      activeGrep.kill();
      activeGrep = null;
    }
    const args = ["--json", "--max-count", "200"];
    if (!opts?.caseSensitive) args.push("-i");
    if (opts?.glob) args.push("-g", opts.glob);
    args.push("--", query);
    const proc = spawn(rgPath, args, { cwd: root });
    activeGrep = proc;
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.type === "match") {
            const path = j.data.path?.text ?? j.data.path?.bytes;
            const lineNo = j.data.line_number;
            const text = j.data.lines?.text ?? "";
            const submatch = j.data.submatches?.[0];
            const col = submatch ? submatch.start : 0;
            const hit = { path, line: lineNo, col, preview: text.replace(/\n$/, "") };
            safeSend(IPC.SearchGrepHit, hit);
          }
        } catch {
        }
      }
    });
    proc.on("close", () => {
      activeGrep = null;
      safeSend(IPC.SearchGrepDone);
    });
    return true;
  });
}
const search = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  invalidateFileIndex,
  registerSearchIpc
}, Symbol.toStringTag, { value: "Module" }));
const LIMITS = {
  // Largest file we'll load into the editor or hand to the AI. Files past
  // this throw — Monaco struggles past a few MB anyway, and the renderer
  // would freeze pushing a huge string through IPC.
  fileReadBytes: 10 * 1024 * 1024,
  // DB result rows held in memory and shipped to the renderer. The grid
  // can scroll millions of rows visually but every cell is still a JS
  // value here; 5k is enough to feel "all of it" while staying bounded.
  dbResultRows: 5e3,
  // Single subprocess stdout/stderr accumulator (mcp ide_run, brew install,
  // codex/claude CLI capture). Past this the proc is killed and the
  // captured text is marked truncated.
  subprocessBytes: 5 * 1024 * 1024,
  // Stream-json buffer for the Claude CLI before we find a newline. A
  // pathological single line past this means the CLI is misbehaving — we
  // drop the buffer rather than letting it grow without bound.
  aiLineBufferBytes: 16 * 1024 * 1024,
  // Tail of stderr we keep around for diagnostic display.
  aiStderrTailBytes: 256 * 1024,
  // Final concatenated assistant text we ship back to the renderer + save
  // to disk. Anything past this is replaced with a truncation marker.
  aiResponseBytes: 8 * 1024 * 1024,
  // Renderer-side caps (also enforced in the store).
  rendererStreamingTextBytes: 4 * 1024 * 1024,
  rendererConversationMessages: 500,
  // PTY → renderer batching window and per-flush ceiling.
  ptyFlushMs: 16,
  ptyFlushBytes: 256 * 1024,
  // If a terminal is producing data faster than the renderer can absorb
  // we'll keep at most this much in the pending buffer before dropping
  // the oldest chunks (with a marker).
  ptyBacklogBytes: 4 * 1024 * 1024,
  // RSS watchdog thresholds for the main process (bytes).
  rssWarnBytes: 2 * 1024 * 1024 * 1024,
  // 2 GB → toast
  rssCriticalBytes: 3 * 1024 * 1024 * 1024
  // 3 GB → toast + log
};
function tail(s, max) {
  return s.length <= max ? s : s.slice(s.length - max);
}
const fileWatchers = /* @__PURE__ */ new Set();
function watchFileForEditor(path) {
  if (fileWatchers.has(path)) return;
  watchFile(path, { interval: 1e3 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
      safeSend(IPC.FsFileChanged, path);
    }
  });
  fileWatchers.add(path);
}
function unwatchFileForEditor(path) {
  if (!fileWatchers.has(path)) return;
  try {
    unwatchFile(path);
  } catch {
  }
  fileWatchers.delete(path);
}
const IGNORE = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "out", ".next", ".turbo", ".vite"]);
async function gitInfoForDir(absPath) {
  const gitPath = join(absPath, ".git");
  let isRepo = false;
  try {
    const st = await promises.stat(gitPath);
    if (st.isDirectory()) isRepo = true;
    else if (st.isFile()) {
      const txt = await promises.readFile(gitPath, "utf8");
      if (txt.startsWith("gitdir:")) isRepo = true;
    }
  } catch {
    return void 0;
  }
  if (!isRepo) return void 0;
  let repoName;
  let branch;
  try {
    const cfg = await promises.readFile(join(absPath, ".git", "config"), "utf8");
    const m = cfg.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*([^\n\r]+)/);
    if (m) {
      const url = m[1].trim();
      const tail2 = url.split(/[/:]/).pop() || "";
      repoName = tail2.replace(/\.git$/, "");
    }
  } catch {
  }
  try {
    const head = await promises.readFile(join(absPath, ".git", "HEAD"), "utf8");
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/m);
    if (m) branch = m[1].trim();
    else branch = head.trim().slice(0, 7);
  } catch {
  }
  return repoName || branch ? { repoName, branch } : { repoName: void 0, branch: void 0 };
}
async function listDir(dir) {
  const entries = await promises.readdir(dir, { withFileTypes: true });
  const dirEntries = [];
  const fileEntries = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    (e.isDirectory() ? dirEntries : fileEntries).push(e);
  }
  const dirNodes = await Promise.all(dirEntries.map(async (e) => {
    const path = join(dir, e.name);
    const gitInfo = await gitInfoForDir(path);
    return { name: e.name, path, isDir: true, gitInfo };
  }));
  const fileNodes = fileEntries.map((e) => ({ name: e.name, path: join(dir, e.name), isDir: false }));
  const nodes = [...dirNodes, ...fileNodes];
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}
async function readFileSafe(path) {
  if (!safeWithinRoot(path)) throw new Error(`Path outside workspace: ${path}`);
  const st = await promises.stat(path);
  if (st.size > LIMITS.fileReadBytes) {
    const mb = (st.size / (1024 * 1024)).toFixed(1);
    const capMb = (LIMITS.fileReadBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`File too large to open (${mb} MB; cap is ${capMb} MB): ${path}`);
  }
  return promises.readFile(path, "utf8");
}
async function writeFileSafe(path, content) {
  if (!safeWithinRoot(path)) throw new Error(`Path outside workspace: ${path}`);
  await promises.mkdir(dirname(path), { recursive: true });
  await promises.writeFile(path, content, "utf8");
}
async function walkAllFiles(root, max = 5e4) {
  const out = [];
  async function walk(dir) {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        out.push(full);
        if (out.length >= max) return;
      }
    }
  }
  await walk(root);
  return out;
}
function registerFsIpc() {
  ipcMain.handle(IPC.FsList, async (_e, dir) => {
    const target = dir || workspace.getRoot();
    if (!target) return [];
    return listDir(target);
  });
  ipcMain.handle(IPC.FsRead, async (_e, path) => readFileSafe(path));
  ipcMain.handle(IPC.FsWrite, async (_e, path, content) => {
    await writeFileSafe(path, content);
    return true;
  });
  ipcMain.handle(IPC.FsRename, async (_e, from, to) => {
    if (!safeWithinRoot(from) || !safeWithinRoot(to)) throw new Error("Path outside workspace");
    await promises.rename(from, to);
    invalidateFileIndex();
    return true;
  });
  ipcMain.handle(IPC.FsDelete, async (_e, path) => {
    if (!safeWithinRoot(path)) throw new Error("Path outside workspace");
    await promises.rm(path, { recursive: true, force: true });
    invalidateFileIndex();
    return true;
  });
  ipcMain.handle(IPC.FsCreate, async (_e, path, isDir) => {
    if (!safeWithinRoot(path)) throw new Error("Path outside workspace");
    if (isDir) {
      await promises.mkdir(path, { recursive: true });
    } else {
      await promises.mkdir(dirname(path), { recursive: true });
      await promises.writeFile(path, "", { flag: "wx" });
    }
    invalidateFileIndex();
    return true;
  });
  ipcMain.handle(IPC.FsWatch, (_e, path) => {
    if (!safeWithinRoot(path)) return false;
    workspace.watchDir(path);
    return true;
  });
  ipcMain.handle(IPC.FsUnwatch, (_e, path) => {
    workspace.unwatchDir(path);
    return true;
  });
  ipcMain.handle(IPC.FsWatchFile, (_e, path) => {
    if (!safeWithinRoot(path)) return false;
    watchFileForEditor(path);
    return true;
  });
  ipcMain.handle(IPC.FsUnwatchFile, (_e, path) => {
    unwatchFileForEditor(path);
    return true;
  });
}
const shutdowns = [];
function onShutdown(fn) {
  shutdowns.push(fn);
}
async function shutdownAll() {
  for (const fn of shutdowns) {
    try {
      await fn();
    } catch (err2) {
      console.error("shutdown error", err2);
    }
  }
}
const __dirname$1 = dirname(fileURLToPath(import.meta.url));
const servers = /* @__PURE__ */ new Map();
const IDLE_KILL_MS = 5 * 60 * 1e3;
const REAP_INTERVAL_MS = 60 * 1e3;
let reapTimer = null;
function startIdleReaper() {
  if (reapTimer) return;
  reapTimer = setInterval(() => {
    const now = Date.now();
    for (const [kind, s] of servers) {
      if (now - s.lastUsedAt < IDLE_KILL_MS) continue;
      console.log(`[lsp:${kind}] idle ${Math.round((now - s.lastUsedAt) / 1e3)}s — shutting down to free memory`);
      try {
        s.proc.kill();
      } catch {
      }
      servers.delete(kind);
    }
  }, REAP_INTERVAL_MS);
  if (typeof reapTimer.unref === "function") reapTimer.unref();
}
function serverKindForUri(uri) {
  if (!uri) return "ts";
  const ext = uri.split(".").pop()?.toLowerCase();
  if (ext === "py" || ext === "pyi") return "py";
  return "ts";
}
function serverKindForRequestParams(params) {
  const uri = params?.textDocument?.uri;
  return serverKindForUri(uri);
}
function findTsServerEntry() {
  const subPath = ["node_modules", "typescript-language-server", "lib", "cli.mjs"];
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "app.asar.unpacked", ...subPath) : null,
    null,
    join(app.getAppPath(), ...subPath),
    join(__dirname$1, "..", "..", ...subPath)
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
function tsServerCmd() {
  const entry = findTsServerEntry();
  if (!entry) return null;
  return {
    cmd: process.execPath,
    args: [entry, "--stdio"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  };
}
function findPyrightEntry() {
  const subPath = ["node_modules", "pyright", "langserver.index.js"];
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "app.asar.unpacked", ...subPath) : null,
    null,
    join(app.getAppPath(), ...subPath),
    join(__dirname$1, "..", "..", ...subPath)
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
function findOnPath(bin) {
  const path = process.env.PATH || "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}
function pyrightServerCmd() {
  const entry = findPyrightEntry();
  if (entry) {
    return {
      cmd: process.execPath,
      args: [entry, "--stdio"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    };
  }
  const onPath = findOnPath("pyright-langserver");
  if (onPath) {
    return { cmd: onPath, args: ["--stdio"], env: { ...process.env } };
  }
  return null;
}
async function initParams(root, kind) {
  const base = {
    processId: process.pid,
    rootUri: pathToFileUri(root),
    workspaceFolders: [{ uri: pathToFileUri(root), name: "workspace" }],
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
        hover: { contentFormat: ["markdown", "plaintext"] },
        completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] } },
        signatureHelp: {},
        definition: { linkSupport: false },
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: { relatedInformation: true }
      },
      workspace: { workspaceFolders: true, symbol: {}, configuration: true }
    }
  };
  if (kind === "py") {
    try {
      const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
      const sel = await getSelectedInterpreter2();
      if (sel) {
        base.initializationOptions = {
          pythonPath: sel.path
        };
      }
    } catch (e) {
      console.warn("[pyright] could not resolve selected interpreter:", e.message);
    }
  }
  return base;
}
async function ensureServer(kind) {
  const root = workspace.getRoot();
  if (!root) return null;
  const existing = servers.get(kind);
  if (existing && existing.root === root) return existing;
  if (existing) {
    try {
      existing.proc.kill();
    } catch {
    }
    servers.delete(kind);
  }
  const spec = kind === "ts" ? tsServerCmd() : pyrightServerCmd();
  const tag = kind === "ts" ? "ts-ls" : "pyright";
  if (!spec) {
    console.warn(`[${tag}] not found on disk or PATH; LSP features disabled for ${kind}`);
    return null;
  }
  const proc = spawn(spec.cmd, spec.args, { cwd: root, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
  proc.on("error", (err2) => console.error(`[${tag}] spawn error:`, err2.message));
  proc.on("exit", (code, sig) => console.log(`[${tag}] exited code=${code} sig=${sig}`));
  proc.stderr?.on("data", (b) => console.error(`[${tag}]`, b.toString("utf8")));
  console.log(`[${tag}] started via`, spec.cmd, "+", spec.args[0]);
  const reader = new StreamMessageReader(proc.stdout);
  const writer = new StreamMessageWriter(proc.stdin);
  const conn = createMessageConnection(reader, writer);
  conn.listen();
  conn.onNotification("textDocument/publishDiagnostics", (params2) => {
    safeSend(IPC.LspDiagnostics, params2);
  });
  if (kind === "py") {
    conn.onRequest("workspace/configuration", async (params2) => {
      const items = params2?.items || [];
      const out = [];
      let selected = null;
      try {
        const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
        selected = await getSelectedInterpreter2();
      } catch {
      }
      for (const it of items) {
        if (it.section === "python" && selected) {
          out.push({ pythonPath: selected.path });
        } else {
          out.push({});
        }
      }
      return out;
    });
  }
  const params = await initParams(root, kind);
  const ready = conn.sendRequest("initialize", params).then(() => conn.sendNotification("initialized", {}));
  const server2 = { kind, proc, conn, root, ready, lastUsedAt: Date.now() };
  servers.set(kind, server2);
  startIdleReaper();
  return server2;
}
function touch(s) {
  if (s) s.lastUsedAt = Date.now();
}
function restartPyright() {
  const s = servers.get("py");
  if (!s) return;
  try {
    s.proc.kill();
  } catch {
  }
  servers.delete("py");
}
function killAllLspServers() {
  let count = 0;
  for (const [kind, s] of servers) {
    try {
      s.proc.kill();
      count++;
    } catch (e) {
      console.warn(`[lsp:${kind}] kill failed`, e.message);
    }
  }
  servers.clear();
  return count;
}
function registerLspIpc() {
  ipcMain.handle(IPC.LspRequest, async (_e, method, params) => {
    const kind = serverKindForRequestParams(params);
    const s = await ensureServer(kind);
    if (!s) return null;
    touch(s);
    await s.ready;
    try {
      return await s.conn.sendRequest(method, params);
    } catch (err2) {
      console.error(`[lsp:${kind}] ${method} failed`, err2);
      return null;
    }
  });
  ipcMain.handle(IPC.LspNotify, async (_e, method, params) => {
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
    try {
      s.proc.kill();
    } catch {
    }
  }
  servers.clear();
});
const lsp = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  killAllLspServers,
  registerLspIpc,
  restartPyright
}, Symbol.toStringTag, { value: "Module" }));
function terminalShell() {
  return { file: process.env.SHELL || "/bin/zsh", args: [] };
}
function commandShell() {
  return true;
}
function resolveBinPath(nameOrPath) {
  if (isAbsolute(nameOrPath)) return existsSync(nameOrPath) ? nameOrPath : null;
  for (const dir of searchDirs()) {
    const candidate = join(dir, nameOrPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function searchDirs() {
  const home = homedir();
  const extras = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".cargo", "bin")
  ];
  return [...(process.env.PATH || "").split(delimiter), ...extras].filter(Boolean);
}
function hasBin(cmd) {
  if (resolveBinPath(cmd)) return true;
  try {
    const out = execFileSync("/usr/bin/which", [cmd], { encoding: "utf8", timeout: 2e3 });
    return Boolean(out && out.trim());
  } catch {
    return false;
  }
}
function spawnBin(file, args, options = {}) {
  return spawn(file, args, options);
}
function detachedSpawnOptions() {
  return { detached: true };
}
async function killTree(pid, force) {
  if (!pid) return;
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
    }
  }
}
async function killPids(pids) {
  if (pids.length === 0) return;
  await new Promise((resolve2) => {
    const p = spawn("kill", ["-9", ...pids.map(String)], { stdio: "ignore" });
    p.on("exit", () => resolve2());
    p.on("error", () => resolve2());
  });
}
function makeResponseAcc() {
  let buf = "";
  let cut = false;
  const cap = LIMITS.aiResponseBytes;
  return {
    append: (s) => {
      if (cut) return;
      if (buf.length + s.length > cap) {
        buf = buf.slice(0, cap) + `

[response truncated — exceeded ${cap} bytes]`;
        cut = true;
      } else {
        buf += s;
      }
    },
    value: () => buf,
    truncated: () => cut
  };
}
function trimConversation(c) {
  const cap = LIMITS.rendererConversationMessages;
  if (c.messages.length > cap) {
    c.messages = c.messages.slice(c.messages.length - cap);
  }
}
const activeStreams = /* @__PURE__ */ new Map();
function convDir() {
  const root = workspace.getRoot();
  if (!root) return null;
  return join(root, ".opendev", "conversations");
}
function convPath(id) {
  const dir = convDir();
  return dir ? join(dir, `${id}.json`) : null;
}
async function listConversations() {
  const dir = convDir();
  if (!dir) return [];
  try {
    const entries = await promises.readdir(dir);
    const out = [];
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      try {
        const c = JSON.parse(await promises.readFile(join(dir, e), "utf8"));
        out.push(c);
      } catch {
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch {
    return [];
  }
}
async function loadConversation(id) {
  const p = convPath(id);
  if (!p) return null;
  try {
    return JSON.parse(await promises.readFile(p, "utf8"));
  } catch {
    return null;
  }
}
async function saveConversation(c) {
  const p = convPath(c.id);
  if (!p) return;
  c.updatedAt = Date.now();
  await promises.mkdir(join(p, ".."), { recursive: true });
  await promises.writeFile(p, JSON.stringify(c, null, 2), "utf8");
}
function buildIdeContextBlock(ctx) {
  if (!ctx) return "";
  const lines = ["<ide-context>"];
  if (ctx.workspaceRoot) lines.push(`workspace: ${ctx.workspaceRoot}`);
  if (ctx.openTabs && ctx.openTabs.length) {
    lines.push("open tabs:");
    for (const t of ctx.openTabs) {
      const marker = t.active ? "*" : " ";
      const ref = t.path ? t.path : `[${t.kind}] ${t.name}`;
      lines.push(`  ${marker} ${ref}`);
    }
  }
  if (ctx.activeTab) {
    if (ctx.activeTab.path) lines.push(`active file: ${ctx.activeTab.path}`);
    else lines.push(`active tab: [${ctx.activeTab.kind}] ${ctx.activeTab.name}`);
    if (ctx.activeTab.contentPreview) {
      lines.push("active file contents:");
      lines.push("```");
      lines.push(ctx.activeTab.contentPreview);
      lines.push("```");
    }
  }
  lines.push("</ide-context>");
  return lines.join("\n");
}
const IDE_SYSTEM_INSTRUCTIONS = `<ide-instructions>
You are running inside OpenDev IDE. A few IDE-specific conventions:

1. ASKING THE USER QUESTIONS
   ⚠️ DO NOT use the AskUserQuestion tool — it is disallowed in this
   environment and will fail. Instead, when you need information from the
   user before continuing, just WRITE THE QUESTION AS PLAIN TEXT in your
   reply and stop. The IDE will wait for the user's reply and resume the
   same Claude session on the next turn — full conversation context (file
   reads, tool results, this question) is preserved across turns, so the
   user can answer naturally and you'll know exactly what was asked.

   Example: instead of calling AskUserQuestion, just write:
       "Before I proceed I need to know: should the realtime/sdp proxy
       stream the response, or is one-shot fine? Please reply with 'stream'
       or 'one-shot'."
   Then stop. The user types their reply, you receive it as the next user
   turn (with all your prior tool calls and reasoning still in context).

2. ADDING APPLICATION-WIDE LOGGING
   If the user asks for app-wide / cross-cutting logging (phrases like
   "log what's happening across the app", "add logging everywhere",
   "trace what's going on", "instrument all services"), DO NOT just add
   logging to one file or one app. Instead:

   a) First, list the top-level apps under \`apps/*\` (or wherever the
      monorepo's services live) so you have a full picture.
   b) Add logging to EVERY relevant app — backend services, frontends,
      gateways, workers, ETL jobs, etc. Each should log its own key
      events with a clear prefix identifying which service produced
      the message (e.g. \`[my-service-backend] auth.login user=…\`).
   c) Cover the critical lifecycle points in each: incoming requests,
      outbound API calls, DB queries, queue events, errors,
      configuration loaded, listeners bound to ports. Skip noisy debug
      lines unless the user asked for them.
   d) Use the project's existing logger if one exists (NestJS Logger,
      pino, winston, console.log — match the convention already in
      that file). Do NOT introduce a new logger dependency.

   The user sees all this output unified in the IDE's "LOG" tab on the
   right — every line each service writes to stdout/stderr becomes a
   bubble there. So be specific, prefix lines by service name, and
   make events distinguishable.

3. PROPOSING MULTIPLE DESIGNS
   When the user asks you to "show", "propose", "mock up", "redesign", or
   otherwise compare multiple design options (UI / layout / styling), DO NOT
   write the files yet. Instead, emit 2–3 self-contained HTML previews, each
   in its own fenced block tagged with the language id
   \`html-proposal:NAME\` (replace NAME with a short label like "Minimal",
   "Bold", "Cards"). The IDE will pop these open side-by-side in the center
   tab area so the user can pick one. Wait for the user to choose before
   writing any files.

   Each preview must be a complete standalone HTML document with inline
   styles (no external scripts/stylesheets — they will be rendered in a
   sandboxed iframe with no network access). Use the SAME content the user
   referenced so the only difference between proposals is the design.

   Example:
   \`\`\`html-proposal:Minimal
   <!doctype html><html><body style="font:14px system-ui;padding:24px">
   ... minimal version ...
   </body></html>
   \`\`\`

   \`\`\`html-proposal:Bold
   <!doctype html><html><body style="font:14px system-ui;padding:24px;background:#111;color:#fff">
   ... bold version ...
   </body></html>
   \`\`\`

   After the user picks, you will receive a follow-up message like
   "I chose Bold. Please apply it to <path>." — then write the real files.

4. AUTHORING AI AGENTS
   An "AI Agent" is a self-contained Node.js application that runs against
   the workspace codebase (e.g. a test runner, a code-graph analyzer). When
   the user asks you to "create an agent" / "make a <kind> agent", just WRITE
   THE FILES — there is no registration step; the IDE watches the agents
   folder and the new agent appears in the bottom-right "AI Agents" panel
   automatically.

   Layout — create a folder at \`.opendev/agents/<slug>/\` (slug = kebab-case)
   containing:
   a) \`agent.json\` — the manifest:
      {
        "slug": "<slug>",
        "name": "<human label>",
        "description": "<one line>",
        "entry": "index.js",        // path relative to this folder
        "runtime": "node",          // "node" for .js/.mjs, "tsx" for .ts
        "createdBy": "ai",
        "createdAt": <Date.now()>
      }
   b) the entry file (and any other source / bundled npm deps).

   Runtime contract for the entry file:
   - It runs with cwd = the workspace root (the codebase under analysis).
   - \`process.env.OPENDEV_WORKSPACE_ROOT\` = absolute path to the codebase.
   - \`process.env.OPENDEV_AGENT_DIR\` = absolute path to the agent's own folder
     (use it to locate bundled files / node_modules).
   - Write results to stdout. If the FIRST thing printed is a complete HTML
     document (starts with \`<!doctype html>\` or \`<html>\`), the IDE renders it
     in a sandboxed iframe in a center tab — good for a graph/visualization.
     Otherwise stdout streams as a plain text log. stderr is also streamed.
   - Prefer \`runtime: "node"\` with plain \`.js\`/\`.mjs\`; only use \`runtime: "tsx"\`
     if the user explicitly wants TypeScript (it requires \`tsx\` installed).
   - Bundle npm dependencies inside the agent folder; do not assume a later
     \`npm install\` step.
</ide-instructions>`;
function buildPrompt(messages, attachments, userText, ideCtx, includeSystemInstructions) {
  const ctx = [];
  if (includeSystemInstructions) ctx.push(IDE_SYSTEM_INSTRUCTIONS);
  const ctxBlock = buildIdeContextBlock(ideCtx);
  if (ctxBlock) ctx.push(ctxBlock);
  for (const a of attachments || []) {
    if (a.kind === "selection") {
      ctx.push(`[Selected from ${a.path}]
${a.text}`);
    } else if (a.kind === "picked-element") {
      ctx.push(`[Picked element: ${a.cssPath}]
${a.outerHTML}`);
    } else if (a.kind === "file" && a.text) {
      ctx.push(`[File: ${a.name}]
\`\`\`
${a.text}
\`\`\``);
    } else if (a.kind === "file" && a.dataUrl) {
      ctx.push(`[Image attached: ${a.name}]`);
    }
  }
  const body = [...ctx, userText].join("\n\n");
  return body;
}
function buildSdkContent(attachments, userText) {
  const images = (attachments || []).filter((a) => a.kind === "file" && a.dataUrl);
  if (images.length === 0) return userText;
  const blocks = [];
  for (const img of images) {
    if (!img.dataUrl) continue;
    const m = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: m[1], data: m[2] }
    });
  }
  blocks.push({ type: "text", text: userText });
  return blocks;
}
async function streamViaClaudeSdk(streamId, text, conv, attachments) {
  const settings = await loadSettings();
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No ANTHROPIC_API_KEY set (Settings → Anthropic API key)");
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  const abort = new AbortController();
  activeStreams.set(streamId, abort);
  const sysPrompt = `You are the assistant inside OpenDev IDE. Project root: ${workspace.getRoot() ?? "(none)"}. Be concise.`;
  const messages = conv.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.text }));
  const lastContent = buildSdkContent(attachments, text);
  messages.push({ role: "user", content: lastContent });
  const acc = makeResponseAcc();
  try {
    const stream2 = await client.messages.stream({
      model: settings.anthropicModel || "claude-sonnet-4-6",
      max_tokens: 4096,
      system: sysPrompt,
      messages
    }, { signal: abort.signal });
    for await (const event of stream2) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const t = event.delta.text;
        acc.append(t);
        if (!acc.truncated()) safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
      }
    }
    safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  } finally {
    activeStreams.delete(streamId);
  }
  conv.messages.push({ id: randomUUID(), role: "assistant", text: acc.value(), createdAt: Date.now(), provider: "claude" });
  trimConversation(conv);
  await saveConversation(conv);
}
async function streamViaClaudeCli(streamId, text, conv) {
  const settings = await loadSettings();
  const configuredBin = settings.claudeCliPath || "claude";
  const claudeBin = resolveBinPath(configuredBin);
  if (!claudeBin) {
    const pathDisp = (process.env.PATH || "").split(":").filter(Boolean).join("\n  ");
    const msg = `
[claude cli not found]
Looked for '${configuredBin}' on PATH:
  ${pathDisp}

Set Settings → AI CLI paths → Claude CLI path to an absolute path, e.g. ${process.env.HOME || "~"}/.local/bin/claude.
`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    conv.messages.push({ id: randomUUID(), role: "assistant", text: msg, createdAt: Date.now(), provider: "claude" });
    trimConversation(conv);
    await saveConversation(conv);
    return;
  }
  const cwd = workspace.getRoot() || process.env.HOME || "/";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // bypassPermissions = no per-tool approval prompts. The IDE chat is
    // already an opted-in surface, so we trust the model to write/edit
    // and surface the diff after.
    "--permission-mode",
    "bypassPermissions",
    // Disallow the interactive question/permission tools — in headless
    // `-p` mode they have nowhere to surface and would hang the run.
    // The system prompt tells the model to ask via plain text instead.
    "--disallowedTools",
    "AskUserQuestion"
  ];
  if (conv.claudeSessionId) {
    args.push("--resume", conv.claudeSessionId);
  }
  console.log(`[claude cli] spawn ${claudeBin} ${args.slice(0, 4).join(" ")}… in ${cwd} (prompt: ${text.length} chars)`);
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (k.startsWith("ELECTRON_")) continue;
    if (k === "NODE_OPTIONS") continue;
    childEnv[k] = v;
  }
  const proc = spawnBin(claudeBin, args, {
    cwd,
    env: childEnv,
    // Always pipe stdin so we can stream the prompt in — see the comment
    // on `args` above about why we don't pass it as a positional arg.
    stdio: ["pipe", "pipe", "pipe"]
  });
  activeStreams.set(streamId, proc);
  let acc = "";
  let accTruncated = false;
  let stderr = "";
  let firstChunkAt = null;
  let stdoutBuf = "";
  let usedStreamJson = true;
  let killReason = null;
  const noteFirstChunk = () => {
    if (firstChunkAt == null) firstChunkAt = Date.now();
  };
  const emit = (chunk) => {
    noteFirstChunk();
    if (accTruncated) return;
    if (acc.length + chunk.length > LIMITS.aiResponseBytes) {
      const marker = `

[response truncated — exceeded ${LIMITS.aiResponseBytes} bytes; killing CLI]
`;
      acc = acc.slice(0, LIMITS.aiResponseBytes) + marker;
      accTruncated = true;
      safeSend(IPC.AiStream, { streamId, chunk: marker, done: false });
      killReason = "response-cap";
      try {
        proc.kill("SIGTERM");
      } catch {
      }
      return;
    }
    acc += chunk;
    safeSend(IPC.AiStream, { streamId, chunk, done: false });
  };
  const handleEvent = (ev) => {
    if (!ev || typeof ev !== "object") return;
    const t = ev.type;
    if (t === "assistant") {
      const content = ev.message?.content || [];
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") {
          emit(c.text);
        } else if (c?.type === "tool_use" && c.name) {
          emit(`
› using tool: ${c.name}
`);
        }
      }
    } else if (t === "user") {
      const content = ev.message?.content || [];
      for (const c of content) {
        if (c?.type === "tool_result" && typeof c.content === "string") {
          const preview = c.content.slice(0, 80).replace(/\n/g, " ");
          emit(`  ↳ ${preview}${c.content.length > 80 ? "…" : ""}
`);
        }
      }
    } else if (t === "result") {
      if (typeof ev.result === "string" && acc.length === 0) emit(ev.result);
      if (typeof ev.session_id === "string") {
        conv.claudeSessionId = ev.session_id;
      }
    } else if (t === "system") {
      if (ev.subtype === "init" && typeof ev.session_id === "string") {
        const wasNew = !conv.claudeSessionId;
        conv.claudeSessionId = ev.session_id;
        if (wasNew) console.log(`[claude cli] captured session_id=${ev.session_id} for conv=${conv.id}`);
      }
    }
  };
  proc.on("error", (err2) => {
    const msg = `
[claude cli failed to spawn] ${err2.message}
Binary: ${claudeBin}
Make sure the file exists and is executable, and that you've run \`claude login\` at least once.
`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
    console.error("[claude cli] spawn error", err2.message);
  });
  proc.stdout?.on("data", (b) => {
    stdoutBuf += b.toString("utf8");
    if (stdoutBuf.length > LIMITS.aiLineBufferBytes) {
      console.error(`[claude cli] stdout buffer exceeded ${LIMITS.aiLineBufferBytes} bytes without newline — dropping`);
      stdoutBuf = "";
      emit(`
[stream parse error — dropped ${LIMITS.aiLineBufferBytes} bytes with no newline]
`);
      return;
    }
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        handleEvent(ev);
      } catch {
        usedStreamJson = false;
        emit(line + "\n");
      }
    }
  });
  proc.stderr?.on("data", (b) => {
    const t = b.toString("utf8");
    stderr = tail(stderr + t, LIMITS.aiStderrTailBytes);
    console.error("[claude cli stderr]", t.trimEnd());
    safeSend(IPC.AiStream, { streamId, chunk: `[stderr] ${t}`, done: false });
  });
  if (proc.stdin) {
    proc.stdin.write(text);
    proc.stdin.end();
  }
  let waitedSec = 0;
  let lastChunkAt = Date.now();
  const heartbeat = setInterval(() => {
    if (firstChunkAt == null) {
      waitedSec += 10;
      safeSend(IPC.AiStream, {
        streamId,
        chunk: `
[still waiting on ${claudeBin} (${waitedSec}s)… Press Stop to cancel.]
`,
        done: false
      });
    }
  }, 1e4);
  const IDLE_KILL_MS2 = 6e4;
  const idleWatchdog = setInterval(() => {
    if (Date.now() - lastChunkAt > IDLE_KILL_MS2) {
      console.warn(`[claude cli] idle for ${IDLE_KILL_MS2}ms — killing subprocess`);
      safeSend(IPC.AiStream, {
        streamId,
        chunk: `
[no output for ${Math.round(IDLE_KILL_MS2 / 1e3)}s — killing subprocess so you can try again]
`,
        done: false
      });
      killReason = "idle-watchdog";
      try {
        proc.kill("SIGTERM");
      } catch {
      }
    }
  }, 15e3);
  proc.stdout?.on("data", () => {
    lastChunkAt = Date.now();
  });
  proc.stderr?.on("data", () => {
    lastChunkAt = Date.now();
  });
  await new Promise((resolve2) => {
    proc.on("close", (code, signal) => {
      clearInterval(heartbeat);
      clearInterval(idleWatchdog);
      if (stdoutBuf.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuf));
        } catch {
          emit(stdoutBuf);
        }
        stdoutBuf = "";
      }
      console.log(`[claude cli] exit code=${code} signal=${signal} kill=${killReason ?? "none"} acc=${acc.length} stderr=${stderr.length} streamJson=${usedStreamJson}`);
      const wasKilled = signal != null || code === 143;
      if (acc.length === 0 && (code !== 0 || signal)) {
        let cause;
        if (killReason === "idle-watchdog") {
          cause = `claude produced no output for 60s; the IDE killed it. The CLI may be hanging on auth or a slow tool call.
Try \`${claudeBin} -p "hello"\` in Terminal to confirm the CLI is working.`;
        } else if (killReason === "response-cap") {
          cause = `Response exceeded the ${LIMITS.aiResponseBytes}-byte cap and was truncated.`;
        } else if (wasKilled) {
          cause = `claude was killed externally (Stop button, IDE quitting, or OS). The IDE didn't initiate this kill — if you didn't press Stop, check Console.app for the parent app being terminated.`;
        } else {
          cause = `claude exited on its own with code=${code}. Try \`${claudeBin} -p "hello"\` in Terminal — if that errors, the CLI isn't configured (run \`claude login\`).`;
        }
        const msg = `
[claude cli error: exit code=${code} signal=${signal ?? "none"}${killReason ? ` kill=${killReason}` : ""}]
Binary: ${claudeBin}
` + (stderr ? `stderr:
${stderr}
` : "") + cause + "\n";
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc = msg;
      }
      resolve2();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: "assistant", text: acc, createdAt: Date.now(), provider: "claude" });
  trimConversation(conv);
  await saveConversation(conv);
}
async function streamViaOpenAiSdk(streamId, text, conv, attachments) {
  const settings = await loadSettings();
  const apiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("No OPENAI_API_KEY set (Settings → OpenAI API key)");
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });
  const abort = new AbortController();
  activeStreams.set(streamId, abort);
  const sysPrompt = `You are the assistant inside OpenDev IDE. Project root: ${workspace.getRoot() ?? "(none)"}. Be concise.`;
  const messages = [{ role: "system", content: sysPrompt }];
  for (const m of conv.messages) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
  }
  const imgs = (attachments || []).filter((a) => a.kind === "file" && a.dataUrl);
  if (imgs.length > 0) {
    const parts = [{ type: "text", text }];
    for (const img of imgs) parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: text });
  }
  const acc = makeResponseAcc();
  try {
    const stream2 = await client.chat.completions.create({
      model: settings.openaiModel || "gpt-4o-mini",
      messages,
      stream: true
    }, { signal: abort.signal });
    for await (const chunk of stream2) {
      const t = chunk.choices?.[0]?.delta?.content;
      if (typeof t === "string" && t.length) {
        acc.append(t);
        if (!acc.truncated()) safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
      }
    }
    safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  } finally {
    activeStreams.delete(streamId);
  }
  conv.messages.push({ id: randomUUID(), role: "assistant", text: acc.value(), createdAt: Date.now(), provider: "codex" });
  trimConversation(conv);
  await saveConversation(conv);
}
async function streamViaCodexCli(streamId, text, conv) {
  const settings = await loadSettings();
  const codexBin = settings.codexCliPath || "codex";
  const cwd = workspace.getRoot() || process.env.HOME || "/";
  console.log(`[codex cli] spawn ${codexBin} exec --skip-git-repo-check  in ${cwd} (prompt: ${text.length} chars)`);
  const proc = spawnBin(codexBin, ["exec", "--skip-git-repo-check", text], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeStreams.set(streamId, proc);
  const acc = makeResponseAcc();
  let stderrBuf = "";
  const emit = (chunk) => {
    acc.append(chunk);
    if (acc.truncated()) {
      try {
        proc.kill("SIGTERM");
      } catch {
      }
      return;
    }
    safeSend(IPC.AiStream, { streamId, chunk, done: false });
  };
  proc.on("error", (err2) => {
    const msg = `
[codex cli failed to spawn] ${err2.message}
Binary: ${codexBin}
Make sure the file exists and is executable, and that you've signed in to codex.
`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
    console.error("[codex cli] spawn error", err2.message);
  });
  proc.stdout?.on("data", (b) => emit(b.toString("utf8")));
  proc.stderr?.on("data", (b) => {
    const t = b.toString("utf8");
    stderrBuf = tail(stderrBuf + t, LIMITS.aiStderrTailBytes);
    console.error("[codex cli stderr]", t.trimEnd());
  });
  await new Promise((resolve2) => {
    proc.on("close", (code) => {
      console.log(`[codex cli] exit code=${code} acc=${acc.value().length} stderr=${stderrBuf.length}`);
      if (acc.value().length === 0 && code !== 0) {
        const msg = `
[codex cli exited ${code} with no output]
` + (stderrBuf ? `stderr:
${stderrBuf}
` : "") + `Try in Terminal: \`${codexBin} exec --skip-git-repo-check "hello"\`. If that errors, the CLI isn't configured — run codex's login flow first.
`;
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc.append(msg);
      }
      resolve2();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: "assistant", text: acc.value(), createdAt: Date.now(), provider: "codex" });
  trimConversation(conv);
  await saveConversation(conv);
}
async function streamViaOpenCodeCli(streamId, text, conv) {
  const settings = await loadSettings();
  if (!settings.aiLocalEnabled) {
    const msg = "\n[opencode] Local AI is not enabled — turn it on in Settings → Local AI.\n";
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    return;
  }
  const configured = (settings.aiLocalBinPath || "opencode").trim() || "opencode";
  const bin = resolveBinPath(configured) || configured;
  const cwd = workspace.getRoot() || process.env.HOME || "/";
  if (isAbsolutePath(configured) && !existsSync(configured)) {
    const msg = `
[opencode] No file at "${configured}".
Update Settings → Local AI → OpenCode binary. Either click Browse… to pick the actual binary, or paste the full path (e.g. ~/Desktop/repo/OpenCode/target/release/opencode).
`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    return;
  }
  if (!isAbsolutePath(configured) && !resolveBinPath(configured)) {
    const msg = `
[opencode] Binary "${configured}" not found on PATH.
PATH searched: ${process.env.PATH}
Either put opencode on your PATH or set an absolute path in Settings → Local AI → OpenCode binary (Browse…).
`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    return;
  }
  const args = ["ask", "--repo", cwd];
  if (settings.aiLocalBaseUrl?.trim()) {
    let url = settings.aiLocalBaseUrl.trim().replace(/\/+$/, "");
    if (!/\/v\d+$/.test(url)) url += "/v1";
    args.push("--base-url", url);
  }
  if (settings.aiLocalModel?.trim()) {
    args.push("--model", settings.aiLocalModel.trim());
  }
  if (settings.aiLocalApiKey?.trim()) {
    args.push("--api-key", settings.aiLocalApiKey.trim());
  }
  args.push(text);
  const displayArgs = args.slice(0, -1).join(" ");
  const startBanner = `
_Running: ${bin} ${displayArgs} "<your question>"_
_cwd: ${cwd}_
`;
  safeSend(IPC.AiStream, { streamId, chunk: startBanner, done: false });
  console.log(`[opencode] spawn ${bin} ${displayArgs} <question> in ${cwd} (q=${text.length} chars)`);
  const proc = spawnBin(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  activeStreams.set(streamId, proc);
  const startedAt = Date.now();
  const acc = makeResponseAcc();
  let stderrBuf = "";
  let spawnErrored = false;
  let gotStdout = false;
  const heartbeat = setInterval(() => {
    if (gotStdout) return;
    const secs = Math.round((Date.now() - startedAt) / 1e3);
    safeSend(IPC.AiStream, { streamId, chunk: `
_…still waiting on first stdout from opencode (${secs}s elapsed)_
`, done: false });
  }, 15e3);
  proc.on("error", (err2) => {
    spawnErrored = true;
    const code = err2.code || "";
    const hint = code === "ENOENT" ? `Binary not found at "${bin}". Update the path in Settings → Local AI → OpenCode binary.` : code === "EACCES" ? `Permission denied executing "${bin}". Run \`chmod +x "${bin}"\` and try again.` : `Update Settings → Local AI → OpenCode binary if the path is wrong.`;
    const msg = `
[opencode failed to spawn] ${err2.message}
${hint}
`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
    acc.append(msg);
    console.error("[opencode] spawn error", err2.message);
  });
  proc.stdout?.on("data", (b) => {
    const t = b.toString("utf8");
    if (!gotStdout) {
      gotStdout = true;
      const secs = ((Date.now() - startedAt) / 1e3).toFixed(1);
      safeSend(IPC.AiStream, { streamId, chunk: `
_first stdout chunk after ${secs}s_

`, done: false });
    }
    acc.append(t);
    if (acc.truncated()) {
      try {
        proc.kill("SIGTERM");
      } catch {
      }
      return;
    }
    safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
  });
  let stderrLineBuf = "";
  proc.stderr?.on("data", (b) => {
    const t = b.toString("utf8");
    stderrBuf = tail(stderrBuf + t, LIMITS.aiStderrTailBytes);
    console.error("[opencode stderr]", t.trimEnd());
    stderrLineBuf += t;
    let nl;
    while ((nl = stderrLineBuf.indexOf("\n")) >= 0) {
      const line = stderrLineBuf.slice(0, nl).trim();
      stderrLineBuf = stderrLineBuf.slice(nl + 1);
      if (!line) continue;
      safeSend(IPC.AiStream, { streamId, chunk: `
_${line}_
`, done: false });
    }
  });
  await new Promise((resolve2) => {
    proc.on("close", (code, signal) => {
      clearInterval(heartbeat);
      console.log(`[opencode] exit code=${code} signal=${signal} acc=${acc.value().length} stderr=${stderrBuf.length}`);
      if (spawnErrored) {
        resolve2();
        return;
      }
      if (acc.value().length === 0 && (code !== 0 || signal)) {
        let exitWord;
        if (signal) {
          exitWord = `terminated by ${signal}`;
        } else if (typeof code === "number" && code < 0) {
          const libuv = { [-2]: "ENOENT — binary not found", [-13]: "EACCES — permission denied", [-8]: "ENOEXEC — not a valid executable" };
          exitWord = `failed to spawn (${libuv[code] || `libuv code ${code}`})`;
        } else {
          exitWord = `exited ${code}`;
        }
        const msg = `
[opencode ${exitWord} with no output]
` + (stderrBuf ? `stderr:
${stderrBuf}
` : "") + `Common causes:
  • Backend not reachable at ${settings.aiLocalBaseUrl || "http://localhost:11434/v1"} from this machine
  • Model "${settings.aiLocalModel || "(unset)"}" not pulled on the host (run \`ollama pull ${settings.aiLocalModel || "<model>"}\` there)
  • Wrong binary path in Settings → Local AI
Try in Terminal: \`${bin} ask --base-url ${settings.aiLocalBaseUrl || "http://localhost:11434/v1"} --model ${settings.aiLocalModel || "<model>"} "hello"\` to see the real error.
`;
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc.append(msg);
      }
      resolve2();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: "assistant", text: acc.value(), createdAt: Date.now(), provider: "opencode" });
  trimConversation(conv);
  await saveConversation(conv);
}
function registerAiIpc() {
  ipcMain.handle(IPC.AiConversations, () => listConversations());
  ipcMain.handle(IPC.AiConversationGet, (_e, id) => loadConversation(id));
  ipcMain.handle(IPC.AiConversationDelete, async (_e, id) => {
    const p = convPath(id);
    if (p) {
      try {
        await promises.unlink(p);
      } catch {
      }
    }
    return true;
  });
  ipcMain.handle(IPC.AiSend, async (_e, args) => {
    let conv = null;
    if (args.conversationId) {
      conv = await loadConversation(args.conversationId);
      if (!conv) console.warn(`[ai:send] stale conversationId ${args.conversationId} — starting new conversation`);
    }
    if (!conv) {
      conv = {
        id: randomUUID(),
        title: args.text.slice(0, 60) || "New conversation",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        workspaceRoot: workspace.getRoot()
      };
    }
    conv.messages.push({
      id: randomUUID(),
      role: "user",
      text: args.text,
      attachments: args.attachments,
      createdAt: Date.now()
    });
    await saveConversation(conv);
    const streamId = randomUUID();
    const raw = args.transport || "claude-cli";
    const transport = raw === "sdk" ? "claude-sdk" : raw === "cli" ? "claude-cli" : raw;
    const isFirstTurn = !conv.claudeSessionId;
    const prompt = buildPrompt(conv.messages.slice(0, -1), args.attachments, args.text, args.context, isFirstTurn);
    const run = (() => {
      if (transport === "claude-cli") return () => streamViaClaudeCli(streamId, prompt, conv);
      if (transport === "openai-sdk") return () => streamViaOpenAiSdk(streamId, prompt, conv, args.attachments);
      if (transport === "codex-cli") return () => streamViaCodexCli(streamId, prompt, conv);
      if (transport === "opencode-cli") return () => streamViaOpenCodeCli(streamId, args.text, conv);
      return () => streamViaClaudeSdk(streamId, prompt, conv, args.attachments);
    })();
    run().catch((err2) => {
      safeSend(IPC.AiStream, {
        streamId,
        chunk: `
[error] ${err2.message}
`,
        done: true,
        full: ""
      });
    });
    return { conversationId: conv.id, streamId };
  });
  ipcMain.handle(IPC.AiCancel, (_e, streamId) => {
    const s = activeStreams.get(streamId);
    if (!s) return false;
    if ("abort" in s) s.abort();
    else s.kill();
    activeStreams.delete(streamId);
    return true;
  });
}
const pexec$2 = promisify(exec);
async function listListeningPortsPosix() {
  const { stdout } = await pexec$2("lsof -nP -iTCP -sTCP:LISTEN -F pcPn", { maxBuffer: 4 * 1024 * 1024 });
  const ports = [];
  let cur = {};
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      if (cur.port && cur.pid) ports.push(cur);
      cur = { pid: Number(val), protocol: "tcp" };
    } else if (tag === "c") {
      cur.command = val;
    } else if (tag === "n") {
      const m = val.match(/:(\d+)(?:\s|$)/) || val.match(/:(\d+)$/);
      if (m) cur.port = Number(m[1]);
    } else if (tag === "P") {
      cur.protocol = val.toLowerCase() === "udp" ? "udp" : "tcp";
    }
  }
  if (cur.port && cur.pid) ports.push(cur);
  return ports;
}
async function pidsOnPortPosix(port) {
  try {
    const { stdout } = await pexec$2(`lsof -ti:${port}`, { timeout: 2e3 });
    return parsePids(stdout.split(/\s+/));
  } catch {
    return [];
  }
}
function parsePids(raw) {
  const pids = raw.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(pids)];
}
async function listListeningPorts() {
  try {
    const ports = await listListeningPortsPosix();
    return Array.from(new Map(ports.map((p) => [`${p.port}-${p.protocol}`, p])).values()).sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}
async function pidsOnPort(port) {
  return pidsOnPortPosix(port);
}
async function freePort(port) {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { killed: [], error: "invalid port" };
  }
  try {
    const pids = await pidsOnPort(port);
    if (pids.length === 0) return { killed: [] };
    await killPids(pids);
    await new Promise((r) => setTimeout(r, 200));
    return { killed: pids };
  } catch (e) {
    return { killed: [], error: e?.message || String(e) };
  }
}
function registerPortsIpc() {
  ipcMain.handle(IPC.PortsList, () => listListeningPorts());
  ipcMain.handle(IPC.PortsFree, (_e, port) => freePort(port));
}
const pexec$1 = promisify(exec);
async function listeningPortsForService(rootPid) {
  try {
    const { stdout } = await pexec$1(`lsof -nP -iTCP -sTCP:LISTEN -a -g ${rootPid} -F n`, { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
    const ports = /* @__PURE__ */ new Set();
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("n")) continue;
      const m = line.match(/:(\d+)$/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}
const LOG_TAIL$2 = 1e3;
class ServiceManager {
  runtimes = /* @__PURE__ */ new Map();
  // Internal listeners — other main-process modules (e.g. mlx.ts) hook
  // these to parse a service's stdout without re-spawning the process.
  logListeners = /* @__PURE__ */ new Set();
  statusListeners = /* @__PURE__ */ new Set();
  onLogChunk(cb) {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }
  onStatusChange(cb) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
  emitLog(id, chunk) {
    for (const cb of this.logListeners) {
      try {
        cb(id, chunk);
      } catch (e) {
        console.error("[services] log listener threw", e);
      }
    }
  }
  emitStatus(r) {
    for (const cb of this.statusListeners) {
      try {
        cb(r);
      } catch (e) {
        console.error("[services] status listener threw", e);
      }
    }
  }
  storePath() {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    return join(root, ".opendev", "services.json");
  }
  legacyPath() {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    return join(root, ".idea", "opendev", "services.json");
  }
  async list() {
    const root = workspace.getRoot();
    if (!root) return [];
    let store = null;
    try {
      const raw = await promises.readFile(this.storePath(), "utf8");
      store = JSON.parse(raw);
    } catch {
    }
    if (!store) {
      try {
        const raw = await promises.readFile(this.legacyPath(), "utf8");
        const legacy = JSON.parse(raw);
        store = { items: legacy.items.map((i) => ({ id: i.id, name: i.name, command: i.command, cwd: i.workingDir })) };
      } catch {
      }
    }
    const userItems = store?.items ?? [];
    const autoItems = await this.autoServices(root);
    const userIds = new Set(userItems.map((s) => s.id));
    const merged = [...autoItems.filter((s) => !userIds.has(s.id)), ...userItems];
    return merged;
  }
  // Workspace-derived "auto" services that show up without the user
  // explicitly adding them. Currently: MLX-LM LoRA training. id is stable
  // and prefixed with "auto-" so the UI hides delete/edit affordances.
  async autoServices(root) {
    const out = [];
    try {
      const { detectMlxProject: detectMlxProject2, buildTrainCommand: buildTrainCommand2, MLX_AUTO_SERVICE_ID: MLX_AUTO_SERVICE_ID2 } = await Promise.resolve().then(() => mlx);
      const info = await detectMlxProject2();
      if (info) {
        out.push({
          id: MLX_AUTO_SERVICE_ID2,
          name: "mlx-lora-train",
          cwd: ".",
          command: await buildTrainCommand2(info)
        });
      }
    } catch (e) {
      console.warn("[services] auto-detect mlx failed", e.message);
    }
    return out;
  }
  async deriveFromDir(absPath) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace");
    const norm = absPath.replace(/\/+$/, "");
    if (!isWithin(norm, root)) throw new Error("Path outside workspace");
    const cwd = norm === root ? "." : norm.slice(root.length + 1);
    const name = cwd === "." ? baseName(root) || "service" : baseName(cwd) || cwd;
    const has = async (f) => {
      try {
        await promises.access(join(norm, f));
        return true;
      } catch {
        return false;
      }
    };
    const read2 = async (f) => {
      try {
        return await promises.readFile(join(norm, f), "utf8");
      } catch {
        return null;
      }
    };
    const pkgRaw = await read2("package.json");
    if (pkgRaw) {
      try {
        const scripts = JSON.parse(pkgRaw).scripts || {};
        let command = "npm start";
        if (scripts.dev) command = "npm run dev";
        else if (scripts.start) command = "npm run start";
        else if (scripts.serve) command = "npm run serve";
        return { name, command, cwd };
      } catch {
      }
    }
    const pom = await read2("pom.xml");
    if (pom) {
      const mvn = await has("mvnw") ? "./mvnw" : "mvn";
      const command = /spring-boot/.test(pom) ? `${mvn} spring-boot:run` : `${mvn} compile exec:java`;
      return { name, command, cwd };
    }
    const gradleBuild = await read2("build.gradle") ?? await read2("build.gradle.kts");
    if (gradleBuild) {
      const gradle = await has("gradlew") ? "./gradlew" : "gradle";
      const command = /spring-boot|org\.springframework\.boot/.test(gradleBuild) ? `${gradle} bootRun` : `${gradle} run`;
      return { name, command, cwd };
    }
    try {
      const entries = await promises.readdir(norm);
      const hasCsproj = entries.some((e) => e.endsWith(".csproj"));
      const hasSln = entries.some((e) => e.endsWith(".sln"));
      if (hasCsproj || hasSln) {
        return { name, command: "dotnet run", cwd };
      }
    } catch {
    }
    if (await has("lora_config.yaml")) {
      const venvLora = join(norm, ".venv", "bin", "mlx_lm.lora");
      const venvPy = join(norm, ".venv", "bin", "python");
      let command = "python3 -m mlx_lm.lora --config lora_config.yaml";
      try {
        await promises.access(venvLora);
        command = ".venv/bin/mlx_lm.lora --config lora_config.yaml";
      } catch {
        try {
          await promises.access(venvPy);
          command = ".venv/bin/python -m mlx_lm.lora --config lora_config.yaml";
        } catch {
        }
      }
      return { name, command, cwd };
    }
    try {
      const entries = await promises.readdir(norm);
      const pyEntry = ["main.py", "app.py", "run.py", "server.py", "train.py"].find((f) => entries.includes(f));
      const hasPy = pyEntry || entries.some((e) => e.endsWith(".py"));
      if (hasPy || await has("requirements.txt") || await has("pyproject.toml")) {
        const venvPy = join(norm, ".venv", "bin", "python");
        let pyBin = "python3";
        try {
          await promises.access(venvPy);
          pyBin = ".venv/bin/python";
        } catch {
        }
        const command = pyEntry ? `${pyBin} ${pyEntry}` : `${pyBin}`;
        return { name, command, cwd };
      }
    } catch {
    }
    return { name, command: "npm run dev", cwd };
  }
  async save(def) {
    const list = await this.readUserList();
    const out = { ...def, id: def.id || randomUUID() };
    const idx = list.findIndex((s) => s.id === out.id);
    if (idx >= 0) list[idx] = out;
    else list.push(out);
    await this.writeUserList(list);
    safeSend(IPC.ServicesChanged);
    return out;
  }
  async delete(id) {
    const list = (await this.readUserList()).filter((s) => s.id !== id);
    await this.writeUserList(list);
    safeSend(IPC.ServicesChanged);
  }
  async readUserList() {
    try {
      const raw = await promises.readFile(this.storePath(), "utf8");
      return JSON.parse(raw).items ?? [];
    } catch {
      return [];
    }
  }
  async writeUserList(items) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace");
    await promises.mkdir(join(root, ".opendev"), { recursive: true });
    await promises.writeFile(this.storePath(), JSON.stringify({ items }, null, 2), "utf8");
  }
  async start(id) {
    const list = await this.list();
    const def = list.find((s) => s.id === id);
    if (!def) throw new Error(`Service ${id} not found`);
    if (this.runtimes.has(id)) {
      const existing = this.runtimes.get(id);
      if (existing.runtime.status === "running" || existing.runtime.status === "starting") {
        return existing.runtime;
      }
    }
    const root = workspace.getRoot();
    const cwd = isAbsolute(def.cwd) ? def.cwd : resolve(root, def.cwd);
    const log = [];
    const runtime = { id, status: "starting", startedAt: Date.now() };
    const broadcast2 = () => {
      safeSend(IPC.ServicesStatus, runtime);
      this.emitStatus(runtime);
    };
    if (def.port) {
      try {
        const r = await freePort(def.port);
        if (r.killed.length > 0) {
          const msg = `[opendev] freed port ${def.port} (killed PID${r.killed.length === 1 ? "" : "s"} ${r.killed.join(", ")})
`;
          log.push(msg);
          safeSend(IPC.ServicesLog, { id, chunk: msg });
        }
      } catch {
      }
    }
    log.push(`[opendev] $ ${def.command}
[opendev] cwd: ${cwd}
[opendev] PATH=${(process.env.PATH || "").split(delimiter).slice(0, 6).join(delimiter)}…
`);
    const proc = spawn(def.command, {
      cwd,
      shell: commandShell(),
      env: { ...process.env, FORCE_COLOR: "1", ...def.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...detachedSpawnOptions()
    });
    runtime.pid = proc.pid;
    this.runtimes.set(id, { proc, runtime, log });
    let attemptedRecovery = false;
    const tryRecoverEaddrInUse = async (text) => {
      if (attemptedRecovery) return;
      const m = text.match(/EADDRINUSE[^\d]*:?(\d{2,5})\b/);
      if (!m) return;
      const conflictPort = Number(m[1]);
      if (!Number.isFinite(conflictPort) || conflictPort < 1) return;
      attemptedRecovery = true;
      const msg = `
[opendev] detected EADDRINUSE on :${conflictPort} — killing holder and restarting…
`;
      log.push(msg);
      safeSend(IPC.ServicesLog, { id, chunk: msg });
      try {
        const r = await freePort(conflictPort);
        const done = `[opendev] freed :${conflictPort} (killed PID${r.killed.length === 1 ? "" : "s"} ${r.killed.join(", ") || "none"})
`;
        log.push(done);
        safeSend(IPC.ServicesLog, { id, chunk: done });
      } catch {
      }
      const pid = proc.pid;
      try {
        if (pid) process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
        }
      }
      setTimeout(() => {
        this.start(id).catch((err2) => {
          const errMsg = `
[opendev] auto-restart failed: ${err2?.message || err2}
`;
          log.push(errMsg);
          safeSend(IPC.ServicesLog, { id, chunk: errMsg });
        });
      }, 250);
    };
    const pushLog = (chunk) => {
      try {
        const s = chunk.toString("utf8");
        log.push(s);
        while (log.length > LOG_TAIL$2) log.shift();
        safeSend(IPC.ServicesLog, { id, chunk: s });
        this.emitLog(id, s);
        if (runtime.status === "starting") {
          runtime.status = "running";
          broadcast2();
        }
        if (/EADDRINUSE/i.test(s)) void tryRecoverEaddrInUse(s);
      } catch {
      }
    };
    proc.stdout?.on("data", pushLog);
    proc.stderr?.on("data", pushLog);
    proc.on("exit", (code, signal) => {
      try {
        const r = this.runtimes.get(id);
        if (!r) return;
        r.runtime.status = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
        r.runtime.lastError = code !== 0 && signal !== "SIGTERM" ? `exit code ${code}` : void 0;
        broadcast2();
      } catch {
      }
    });
    proc.on("error", (err2) => {
      try {
        runtime.status = "error";
        runtime.lastError = err2.message;
        log.push(`
[spawn error] ${err2.message}
`);
        broadcast2();
      } catch {
      }
    });
    broadcast2();
    return runtime;
  }
  async stop(id, opts = {}) {
    const r = this.runtimes.get(id);
    if (!r) return;
    const pid = r.proc.pid;
    const kill = async (force) => {
      if (pid) await killTree(pid, force);
      else {
        try {
          r.proc.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
        }
      }
    };
    if (r.proc.exitCode == null) await kill(false);
    const waitMs = opts.waitMs ?? 4e3;
    await new Promise((resolve2) => {
      if (r.proc.exitCode != null) return resolve2();
      const t = setTimeout(() => {
        void kill(true).then(resolve2);
      }, waitMs);
      r.proc.once("exit", () => {
        clearTimeout(t);
        resolve2();
      });
    });
  }
  async restart(id) {
    const existing = this.runtimes.get(id);
    if (existing) {
      await this.stop(id);
      await new Promise((resolve2) => {
        const t = setTimeout(resolve2, 4500);
        existing.proc.once("exit", () => {
          clearTimeout(t);
          resolve2();
        });
      });
    }
    return this.start(id);
  }
  status(id) {
    const r = this.runtimes.get(id);
    return r?.runtime ?? { id, status: "stopped" };
  }
  allStatuses() {
    return [...this.runtimes.values()].map((r) => r.runtime);
  }
  async allPorts() {
    const out = {};
    await Promise.all([...this.runtimes.entries()].map(async ([id, r]) => {
      if (r.runtime.status !== "running" && r.runtime.status !== "starting") return;
      if (!r.proc.pid) return;
      const ports = await listeningPortsForService(r.proc.pid);
      if (ports.length) out[id] = ports;
    }));
    return out;
  }
  log(id) {
    const r = this.runtimes.get(id);
    if (!r) return "";
    return r.log.join("");
  }
  async stopAll(waitMs = 3500) {
    const ids = [...this.runtimes.keys()];
    if (ids.length === 0) return;
    console.log(`[services] stopping ${ids.length} on shutdown`);
    await Promise.all(ids.map((id) => this.stop(id, { waitMs })));
  }
  // Shutdown-path variant: skip graceful SIGTERM entirely and ALSO kill
  // whatever's still listening on the ports each service was using. With
  // shell:true + node/npm child trees, some processes escape the group
  // kill (vite cluster workers, npm respawn-on-crash, etc) and keep the
  // dev port held even after the parent shell exits — which is exactly
  // what the user is seeing. Targeting the port directly is the only
  // reliable cleanup.
  async stopAllImmediate() {
    const entries = [...this.runtimes.entries()];
    if (entries.length === 0) return;
    console.log(`[services] hard-killing ${entries.length} on quit`);
    const portsByService = await Promise.all(entries.map(async ([, r]) => {
      if (!r.proc.pid) return [];
      try {
        return await listeningPortsForService(r.proc.pid);
      } catch {
        return [];
      }
    }));
    await Promise.all(entries.map(async ([, r]) => {
      const pid = r.proc.pid;
      if (pid) await killTree(pid, true);
      else {
        try {
          r.proc.kill("SIGKILL");
        } catch {
        }
      }
    }));
    const allPorts = /* @__PURE__ */ new Set();
    for (const ports of portsByService) for (const p of ports) allPorts.add(p);
    if (allPorts.size > 0) {
      console.log(`[services] freeing ports ${[...allPorts].join(", ")}`);
      await Promise.all([...allPorts].map((port) => freePort(port).catch(() => ({ killed: [] }))));
    }
  }
}
const serviceManager = new ServiceManager();
onShutdown(() => serviceManager.stopAllImmediate());
function registerServicesIpc() {
  ipcMain.handle(IPC.ServicesList, () => serviceManager.list());
  ipcMain.handle(IPC.ServicesSave, (_e, def) => serviceManager.save(def));
  ipcMain.handle(IPC.ServicesDelete, (_e, id) => serviceManager.delete(id));
  ipcMain.handle(IPC.ServicesStart, (_e, id) => serviceManager.start(id));
  ipcMain.handle(IPC.ServicesStop, (_e, id) => serviceManager.stop(id));
  ipcMain.handle(IPC.ServicesRestart, (_e, id) => serviceManager.restart(id));
  ipcMain.handle(IPC.ServicesDeriveFromDir, (_e, absPath) => serviceManager.deriveFromDir(absPath));
  ipcMain.handle(IPC.ServicesStatus, () => serviceManager.allStatuses());
  ipcMain.handle(IPC.ServicesLog, (_e, id) => serviceManager.log(id));
  ipcMain.handle(IPC.ServicesPorts, () => serviceManager.allPorts());
}
function storePath() {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  return join(root, ".opendev", "tasks.json");
}
async function read() {
  try {
    const raw = await promises.readFile(storePath(), "utf8");
    return JSON.parse(raw).items ?? [];
  } catch {
    return [];
  }
}
async function write(items) {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace");
  await promises.mkdir(join(root, ".opendev"), { recursive: true });
  await promises.writeFile(storePath(), JSON.stringify({ items }, null, 2), "utf8");
}
function registerTasksIpc() {
  ipcMain.handle(IPC.TasksList, () => read());
  ipcMain.handle(IPC.TasksSave, async (_e, item) => {
    const items = await read();
    const next = {
      id: item.id || randomUUID(),
      title: item.title || "Untitled",
      done: !!item.done,
      notes: item.notes,
      createdAt: item.createdAt || Date.now()
    };
    const idx = items.findIndex((t) => t.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.push(next);
    await write(items);
    return next;
  });
  ipcMain.handle(IPC.TasksDelete, async (_e, id) => {
    const items = (await read()).filter((t) => t.id !== id);
    await write(items);
    return true;
  });
}
let _undiciAgent = null;
async function getUndiciAgent() {
  if (_undiciAgent) return _undiciAgent;
  try {
    const undici = eval("require")("undici");
    _undiciAgent = (opts) => new undici.Agent(opts);
    return _undiciAgent;
  } catch {
    return null;
  }
}
function capRows(rows) {
  if (rows.length <= LIMITS.dbResultRows) return { rows, truncated: false };
  return { rows: rows.slice(0, LIMITS.dbResultRows), truncated: true };
}
function esBaseUrl(profile, relayHost, relayPort) {
  let proto = profile.ssl ? "https" : "http";
  if (/^https:\/\//i.test(profile.host)) proto = "https";
  else if (/^http:\/\//i.test(profile.host)) proto = "http";
  const host = relayHost ?? profile.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const port = relayPort ?? profile.port;
  return `${proto}://${host}:${port}`;
}
const MOZILLA_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
async function esFetch(profile, password, method, path, body, relayHost, relayPort) {
  const url = esBaseUrl(profile, relayHost, relayPort) + (path.startsWith("/") ? path : "/" + path);
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": MOZILLA_UA
  };
  if (profile.user) {
    const creds = Buffer.from(`${profile.user}:${password ?? ""}`).toString("base64");
    headers["Authorization"] = `Basic ${creds}`;
  }
  const useHttps = url.startsWith("https://");
  let dispatcher;
  if (useHttps && profile.allowSelfSigned) {
    const make = await getUndiciAgent();
    if (make) dispatcher = make({ connect: { rejectUnauthorized: false } });
  }
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== void 0 ? JSON.stringify(body) : void 0,
      // @ts-expect-error undici dispatcher pass-through
      dispatcher
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
    }
    return { status: res.status, body: parsed };
  } catch (err2) {
    const cause = err2?.cause;
    const code = cause?.code;
    const detail = cause?.message || err2?.message || String(err2);
    let hint = "";
    if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      hint = ` — toggle "Accept self-signed certificates" in the connection settings.`;
    } else if (code === "ECONNREFUSED") {
      hint = ` — nothing listening on ${url}. Wrong port? Server down?`;
    } else if (code === "ENOTFOUND") {
      hint = ` — hostname not resolvable.`;
    } else if (code === "EHOSTUNREACH") {
      hint = ` — LAN host not reachable; if on macOS, see the same network workaround as SQL connections.`;
    } else if (code === "ECONNRESET") {
      hint = ` — connection reset. Maybe the server expects HTTPS but you connected over HTTP (toggle "Use HTTPS"), or there's a proxy in the way.`;
    } else if (/wrong version number|ssl/i.test(detail)) {
      hint = ` — TLS protocol mismatch; flip the "Use HTTPS" checkbox.`;
    }
    throw new Error(`${url} → ${detail}${code ? ` [${code}]` : ""}${hint}`);
  }
}
function esColumnsFromMapping(mapping) {
  const idx = Object.keys(mapping || {})[0];
  const props = mapping?.[idx]?.mappings?.properties || {};
  const cols = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (v?.properties) {
        walk(v.properties, name);
      } else {
        cols.push({ name, type: v?.type || "object", nullable: true });
      }
    }
  };
  walk(props, "");
  return cols;
}
function isLanHost(host) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
}
async function startNcRelay(host, port) {
  const server2 = net.createServer();
  await new Promise((resolve2, reject) => {
    server2.once("error", reject);
    server2.listen(0, "127.0.0.1", () => resolve2());
  });
  const localPort = server2.address().port;
  const procs = /* @__PURE__ */ new Set();
  server2.on("connection", (sock) => {
    const proc = spawn("nc", [host, String(port)]);
    procs.add(proc);
    const cleanup = () => {
      procs.delete(proc);
      try {
        sock.destroy();
      } catch {
      }
      try {
        proc.kill();
      } catch {
      }
    };
    sock.on("error", cleanup);
    sock.on("close", cleanup);
    proc.on("error", cleanup);
    proc.on("exit", cleanup);
    sock.pipe(proc.stdin);
    proc.stdout.pipe(sock);
  });
  return {
    host: "127.0.0.1",
    port: localPort,
    cleanup: () => {
      for (const p of procs) {
        try {
          p.kill("SIGKILL");
        } catch {
        }
      }
      try {
        server2.close();
      } catch {
      }
    }
  };
}
async function maybeStartRelay(host, port) {
  if (process.platform !== "darwin" || !isLanHost(host)) {
    return { host, port, cleanup: () => {
    } };
  }
  return startNcRelay(host, port);
}
async function probeRawSocket(host, port, family, timeoutMs = 5e3) {
  const name = `node net.Socket${family ? ` (IPv${family})` : ""}`;
  return new Promise((resolve2) => {
    const sock = new net.Socket();
    const start = Date.now();
    const finish = (ok2, detail) => {
      try {
        sock.destroy();
      } catch {
      }
      resolve2({ name, ok: ok2, detail });
    };
    const t = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      finish(true, `connected in ${Date.now() - start}ms`);
    });
    sock.once("error", (err2) => {
      clearTimeout(t);
      finish(false, `${err2.code || ""} ${err2.message}`);
    });
    try {
      sock.connect({ host, port, family });
    } catch (e) {
      clearTimeout(t);
      finish(false, e?.message || String(e));
    }
  });
}
async function probeNc(host, port, timeoutMs = 5e3) {
  return new Promise((resolve2) => {
    const proc = spawn("nc", ["-vz", "-G", "4", host, String(port)], { env: process.env });
    let out = "";
    proc.stdout.on("data", (b) => {
      out += b.toString("utf8");
    });
    proc.stderr.on("data", (b) => {
      out += b.toString("utf8");
    });
    const t = setTimeout(() => {
      try {
        proc.kill();
      } catch {
      }
      resolve2({ name: "nc subprocess", ok: false, detail: `timeout: ${out.trim().slice(0, 200)}` });
    }, timeoutMs);
    proc.on("error", (err2) => {
      clearTimeout(t);
      resolve2({ name: "nc subprocess", ok: false, detail: `spawn failed: ${err2.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      const text = out.trim().slice(0, 200) || `exit ${code}`;
      resolve2({ name: "nc subprocess", ok: code === 0, detail: text });
    });
  });
}
async function runNetworkDiagnostic(host, port) {
  const probes = [probeRawSocket(host, port, 4), probeRawSocket(host, port)];
  if (hasBin("nc")) probes.push(probeNc(host, port));
  return Promise.all(probes);
}
const pools = /* @__PURE__ */ new Map();
const dbOverrides = /* @__PURE__ */ new Map();
function effectiveDatabase(profile) {
  const o = dbOverrides.get(profile.id);
  if (o !== void 0) return o;
  if (profile.database) return profile.database;
  return profile.driver === "postgres" ? "postgres" : void 0;
}
const KEYTAR_SERVICE = "opendev-ide-db";
async function getKeytar() {
  try {
    return (await import("keytar")).default ?? await import("keytar");
  } catch {
    return null;
  }
}
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}
async function setPassword(id, password) {
  try {
    const k = await getKeytar();
    if (k) await withTimeout(k.setPassword(KEYTAR_SERVICE, id, password), 3e3, "keychain setPassword");
  } catch (e) {
    console.error("[db.setPassword] keychain write failed:", e?.message || e);
  }
}
async function getPassword(id) {
  try {
    const k = await getKeytar();
    if (!k) return void 0;
    return await withTimeout(k.getPassword(KEYTAR_SERVICE, id), 3e3, "keychain getPassword") ?? void 0;
  } catch (e) {
    console.error("[db.getPassword] keychain read failed:", e?.message || e);
    return void 0;
  }
}
async function deletePassword(id) {
  try {
    const k = await getKeytar();
    if (k) await withTimeout(k.deletePassword(KEYTAR_SERVICE, id), 3e3, "keychain deletePassword");
  } catch (e) {
    console.error("[db.deletePassword] keychain delete failed:", e?.message || e);
  }
}
function profilesPath() {
  const root = workspace.getRoot();
  if (!root) return null;
  return join(root, ".opendev", "db-connections.json");
}
async function readProfiles() {
  const p = profilesPath();
  if (!p) return [];
  try {
    const raw = await promises.readFile(p, "utf8");
    return JSON.parse(raw).items ?? [];
  } catch {
    return [];
  }
}
async function writeProfiles(items) {
  const p = profilesPath();
  if (!p) throw new Error("No workspace open — open a project before saving a DB connection.");
  await promises.mkdir(join(p, ".."), { recursive: true });
  await promises.writeFile(p, JSON.stringify({ items }, null, 2), "utf8");
}
async function openPool(profile, passwordOverride) {
  const existing = pools.get(profile.id);
  if (existing) return existing;
  const password = passwordOverride ?? await getPassword(profile.id);
  const bareHost = profile.host.replace(/^https?:\/\//, "");
  const relay = await maybeStartRelay(bareHost, profile.port);
  const db = effectiveDatabase(profile);
  if (profile.driver === "elasticsearch") {
    const pool = { driver: "elasticsearch", client: { password, relayHost: relay.host, relayPort: relay.port }, profile, relay };
    pools.set(profile.id, pool);
    return pool;
  }
  if (profile.driver === "mysql") {
    const mysql = await import("mysql2/promise");
    const client = await mysql.createPool({
      host: relay.host,
      port: relay.port,
      user: profile.user,
      password,
      database: db,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 1e4,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      multipleStatements: true,
      charset: "utf8mb4",
      ...{ allowPublicKeyRetrieval: true }
    });
    const pool = { driver: "mysql", client, profile, relay };
    pools.set(profile.id, pool);
    return pool;
  } else {
    const { Pool: PgPool } = await import("pg");
    const client = new PgPool({
      host: relay.host,
      port: relay.port,
      user: profile.user,
      password,
      database: db || "postgres",
      max: 5,
      connectionTimeoutMillis: 1e4
    });
    const pool = { driver: "postgres", client, profile, relay };
    pools.set(profile.id, pool);
    return pool;
  }
}
async function testProfile(profile) {
  const bareHost = profile.host.replace(/^https?:\/\//, "");
  const relay = await maybeStartRelay(bareHost, profile.port);
  const viaRelay = relay.host !== bareHost;
  try {
    if (profile.driver === "elasticsearch") {
      const password = profile.password ?? await getPassword(profile.id);
      const r = await esFetch(profile, password, "GET", "/", void 0, relay.host, relay.port);
      relay.cleanup();
      if (r.status >= 400) {
        return {
          ok: false,
          error: `HTTP ${r.status}: ${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}`,
          hint: r.status === 401 ? "Auth failed — wrong user/password." : void 0
        };
      }
      const v = r.body?.version?.number;
      const flavor = r.body?.version?.distribution === "opensearch" ? "OpenSearch" : "Elasticsearch";
      const name = r.body?.cluster_name ? ` · cluster ${r.body.cluster_name}` : "";
      return { ok: true, serverInfo: v ? `${flavor} ${v}${name}` : flavor, viaRelay };
    }
    if (profile.driver === "mysql") {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection({
        host: relay.host,
        port: relay.port,
        user: profile.user,
        password: profile.password ?? await getPassword(profile.id),
        database: profile.database || void 0,
        connectTimeout: 1e4,
        ...{ allowPublicKeyRetrieval: true }
      });
      try {
        const [r] = await conn.query("SELECT VERSION() AS v");
        const v = r?.[0]?.v;
        return { ok: true, serverInfo: v ? `MySQL ${v}` : void 0, viaRelay };
      } finally {
        await conn.end();
        relay.cleanup();
      }
    } else {
      const { Client } = await import("pg");
      const client = new Client({
        host: relay.host,
        port: relay.port,
        user: profile.user,
        password: profile.password ?? await getPassword(profile.id),
        database: profile.database || "postgres",
        connectionTimeoutMillis: 1e4
      });
      await client.connect();
      try {
        const r = await client.query("SELECT version() AS v");
        const v = r.rows[0]?.v;
        return { ok: true, serverInfo: v, viaRelay };
      } finally {
        await client.end();
        relay.cleanup();
      }
    }
  } catch (err2) {
    relay.cleanup();
    const msg = err2?.message || String(err2);
    const code = err2?.code;
    let hint;
    const altPort = profile.driver === "postgres" ? 3306 : 5432;
    const altDriver = profile.driver === "postgres" ? "MySQL" : "Postgres";
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ETIMEDOUT") {
      const probes = await runNetworkDiagnostic(profile.host, profile.port).catch(() => []);
      const probesText = probes.map((p) => `   ${p.ok ? "✓" : "✗"} ${p.name} — ${p.detail}`).join("\n");
      const allNcOk = probes.find((p) => p.name === "nc subprocess")?.ok;
      const sockOk = probes.find((p) => p.name.startsWith("node net.Socket (IPv4)"))?.ok;
      const isLan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(profile.host);
      const lines = [];
      lines.push(`Network diagnostic for ${profile.host}:${profile.port} —`);
      lines.push(probesText);
      lines.push("");
      if (sockOk && !allNcOk) {
        lines.push(`Node sockets work but nc didn't — the IDE network stack is fine; the DB error is elsewhere.`);
      } else if (allNcOk && !sockOk) {
        lines.push(`nc reaches the host but Node sockets cannot. That's the classic macOS Local Network filter for unsigned apps on Sequoia.`);
        lines.push(`Workaround until we have a Developer ID: try launching the app from Terminal so it inherits Terminal's network permission:`);
        lines.push(`   open '/Applications/openDev.app'`);
        lines.push(`If that still fails:`);
        lines.push(`   tccutil reset LocalNetwork com.opendev.ide`);
        lines.push(`then relaunch. System Settings → Privacy & Security → Local Network should now list OpenDev IDE; turn it on.`);
      } else if (!allNcOk && !sockOk) {
        lines.push(`Neither nc nor Node sockets reach ${profile.host}:${profile.port}. This is a real network problem (VPN, VLAN, firewall) — not an IDE permission.`);
      } else if (isLan && process.platform === "darwin") {
        lines.push(`Both probes succeeded but the DB driver still failed — try the test again; this is typically a transient first-attempt issue.`);
      }
      if (profile.driver === "postgres") lines.push(`(If the DB is actually MySQL the right port is ${altPort}.)`);
      else if (profile.driver === "mysql") lines.push(`(If the DB is actually Postgres the right port is ${altPort}.)`);
      hint = lines.join("\n");
    } else if (code === "ECONNREFUSED") hint = `Host ${profile.host} answered but nothing is listening on port ${profile.port}. Is the server up? If it's ${altDriver}, port should be ${altPort}.`;
    else if (code === "ETIMEDOUT" || /timeout/i.test(msg)) hint = `Network timeout — the host is unreachable from here (firewall, VPN, bind-address?).`;
    else if (code === "ENETUNREACH") hint = `Network unreachable — your machine has no route to ${profile.host}.`;
    else if (code === "ENOTFOUND") hint = `Hostname couldn't be resolved.`;
    else if (/Access denied/i.test(msg)) hint = `Auth rejected. Check user, password, and host-grant — MySQL grants are user@host so '${profile.user}'@'%' may need an explicit grant for this IP.`;
    else if (/password authentication failed/i.test(msg)) hint = `Postgres password didn't match for user '${profile.user}'.`;
    else if (/no pg_hba.conf entry/i.test(msg)) hint = `Postgres pg_hba.conf doesn't allow connections from this client for that user.`;
    else if (/SSL\/TLS required/i.test(msg) || /SSL connection is required/i.test(msg)) hint = `Server requires SSL.`;
    else if (/database "[^"]+" does not exist/i.test(msg)) hint = `That database doesn't exist on this server — leave the Database field blank to list.`;
    return { ok: false, error: msg, hint };
  }
}
async function closePool(id) {
  const p = pools.get(id);
  if (!p) return;
  try {
    if (p.driver === "mysql") await p.client.end();
    else if (p.driver === "postgres") await p.client.end();
  } catch {
  }
  try {
    p.relay?.cleanup();
  } catch {
  }
  pools.delete(id);
}
async function fetchSchema(pool) {
  if (pool.driver === "elasticsearch") {
    const r = await esFetch(pool.profile, pool.client.password, "GET", "/_cat/indices?format=json&h=index,docs.count,store.size&s=index", void 0, pool.client.relayHost, pool.client.relayPort);
    if (r.status >= 400) throw new Error(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    const indices = r.body.filter((i) => i.index && !i.index.startsWith("."));
    const tbls = [];
    for (const idx of indices.slice(0, 100)) {
      let cols = [];
      try {
        const m = await esFetch(pool.profile, pool.client.password, "GET", `/${encodeURIComponent(idx.index)}/_mapping`, void 0, pool.client.relayHost, pool.client.relayPort);
        if (m.status < 400) cols = esColumnsFromMapping(m.body);
      } catch {
      }
      tbls.push({ name: idx.index, type: "table", columns: cols });
    }
    return [{ name: "indices", tables: tbls }];
  }
  if (pool.driver === "mysql") {
    let dbNames = [];
    if (pool.profile.database) {
      dbNames = [pool.profile.database];
    } else {
      try {
        const [dbs] = await pool.client.query("SHOW DATABASES");
        dbNames = dbs.map((r) => r.Database ?? r.database).filter(Boolean);
      } catch (err2) {
        try {
          const [rows] = await pool.client.query(
            `SELECT DISTINCT table_schema AS s FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')`
          );
          dbNames = rows.map((r) => r.s);
        } catch {
          throw new Error(`Couldn't list databases (${err2?.code || ""}: ${err2?.message || err2}). Tip: set a specific database on the connection.`);
        }
      }
    }
    const schemas = [];
    for (const name of dbNames) {
      if (["information_schema", "mysql", "performance_schema", "sys"].includes(name) && dbNames.length > 1) continue;
      let tables = [];
      try {
        const [t] = await pool.client.query(
          `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ?`,
          [name]
        );
        tables = t;
      } catch {
        schemas.push({ name, tables: [] });
        continue;
      }
      const tbls = [];
      for (const t of tables) {
        const tname = t.table_name ?? t.TABLE_NAME;
        const ttype = (t.table_type ?? t.TABLE_TYPE) === "VIEW" ? "view" : "table";
        let cols = [];
        try {
          const [c] = await pool.client.query(
            `SELECT column_name, column_type, is_nullable, column_key
               FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            [name, tname]
          );
          cols = c;
        } catch {
        }
        const columns = cols.map((c) => ({
          name: c.column_name ?? c.COLUMN_NAME,
          type: c.column_type ?? c.COLUMN_TYPE,
          nullable: (c.is_nullable ?? c.IS_NULLABLE) === "YES",
          key: c.column_key ?? c.COLUMN_KEY
        }));
        tbls.push({ name: tname, type: ttype, columns });
      }
      schemas.push({ name, tables: tbls });
    }
    return schemas;
  } else {
    const sres = await pool.client.query(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname`
    );
    const schemas = [];
    for (const row of sres.rows) {
      const tres = await pool.client.query(
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        [row.nspname]
      );
      const tbls = [];
      for (const t of tres.rows) {
        const cres = await pool.client.query(
          `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [row.nspname, t.table_name]
        );
        const columns = cres.rows.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES"
        }));
        try {
          const pkres = await pool.client.query(
            `SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema    = kcu.table_schema
              WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_schema    = $1
                AND tc.table_name      = $2`,
            [row.nspname, t.table_name]
          );
          const pkSet = new Set(pkres.rows.map((r) => r.column_name));
          for (const c of columns) if (pkSet.has(c.name)) c.key = "PRI";
        } catch {
        }
        tbls.push({ name: t.table_name, type: t.table_type === "VIEW" ? "view" : "table", columns });
      }
      schemas.push({ name: row.nspname, tables: tbls });
    }
    return schemas;
  }
}
async function runQuery(pool, sql) {
  const start = Date.now();
  if (pool.driver === "elasticsearch") {
    const trimmed = sql.trim();
    if (trimmed.startsWith("{")) {
      const lines = sql.split("\n");
      const firstLine = lines[0].trim();
      let method = "POST", path = "/_search";
      const dslMatch = firstLine.match(/^(GET|POST|PUT|DELETE)\s+(\/\S*)$/i);
      let bodyText = sql;
      if (dslMatch) {
        method = dslMatch[1].toUpperCase();
        path = dslMatch[2];
        bodyText = lines.slice(1).join("\n");
      }
      let body = void 0;
      try {
        body = bodyText.trim() ? JSON.parse(bodyText) : void 0;
      } catch (e) {
        throw new Error("Invalid JSON DSL: " + e.message);
      }
      const r2 = await esFetch(pool.profile, pool.client.password, method, path, body, pool.client.relayHost, pool.client.relayPort);
      if (r2.status >= 400) throw new Error(typeof r2.body === "string" ? r2.body : JSON.stringify(r2.body));
      const hits = r2.body?.hits?.hits;
      if (hits) {
        const cols = /* @__PURE__ */ new Set(["_id"]);
        for (const h of hits) for (const k of Object.keys(h._source || {})) cols.add(k);
        const columns2 = [...cols];
        const allRows2 = hits.map((h) => columns2.map((c) => c === "_id" ? h._id : h._source?.[c]));
        const capped2 = capRows(allRows2);
        return { columns: columns2, rows: capped2.rows, rowCount: hits.length, durationMs: Date.now() - start, truncated: capped2.truncated };
      }
      return { columns: ["response"], rows: [[r2.body]], rowCount: 1, durationMs: Date.now() - start };
    }
    const trySql = async (path) => esFetch(pool.profile, pool.client.password, "POST", path, { query: sql, fetch_size: 500 }, pool.client.relayHost, pool.client.relayPort);
    let r = await trySql("/_sql?format=json");
    if (r.status === 404) r = await trySql("/_plugins/_sql");
    if (r.status >= 400) throw new Error(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    const columns = (r.body?.columns || []).map((c) => c.name);
    const allRows = r.body?.rows || r.body?.datarows || [];
    const capped = capRows(allRows);
    return { columns, rows: capped.rows, rowCount: allRows.length, durationMs: Date.now() - start, truncated: capped.truncated };
  }
  if (pool.driver === "mysql") {
    const [rows, fields] = await pool.client.query(sql);
    const columns = fields?.map((f) => f.name) ?? [];
    if (Array.isArray(rows)) {
      const totalCount = rows.length;
      const allMapped = rows.map((r) => columns.map((c) => r[c]));
      const capped = capRows(allMapped);
      return {
        columns,
        rows: capped.rows,
        rowCount: totalCount,
        durationMs: Date.now() - start,
        truncated: capped.truncated
      };
    }
    return { columns: ["affectedRows"], rows: [[rows.affectedRows]], rowCount: 1, durationMs: Date.now() - start };
  } else {
    const res = await pool.client.query(sql);
    const columns = res.fields.map((f) => f.name);
    const totalCount = res.rowCount ?? res.rows.length;
    const allMapped = res.rows.map((r) => columns.map((c) => r[c]));
    const capped = capRows(allMapped);
    return {
      columns,
      rows: capped.rows,
      rowCount: totalCount,
      durationMs: Date.now() - start,
      truncated: capped.truncated
    };
  }
}
function registerDbIpc() {
  ipcMain.handle(IPC.DbConnectionsList, () => readProfiles());
  ipcMain.handle(IPC.DbConnectionsSave, async (_e, profile) => {
    try {
      const items = await readProfiles();
      const next = {
        id: profile.id || randomUUID(),
        name: profile.name,
        driver: profile.driver,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        database: profile.database,
        readOnly: profile.readOnly,
        // Preserve ES-specific flags — dropping these on save was a bug:
        // editing an ES profile and clicking Save would silently revert
        // ssl=true / allowSelfSigned=true back to undefined.
        ssl: profile.ssl,
        allowSelfSigned: profile.allowSelfSigned
      };
      if (profile.password) await setPassword(next.id, profile.password);
      const idx = items.findIndex((i) => i.id === next.id);
      if (idx >= 0) items[idx] = next;
      else items.push(next);
      await writeProfiles(items);
      console.log(`[db.save] persisted profile ${next.id} (${next.name})`);
      return next;
    } catch (e) {
      console.error("[db.save] failed:", e);
      throw e;
    }
  });
  ipcMain.handle(IPC.DbConnectionsDelete, async (_e, id) => {
    const items = (await readProfiles()).filter((i) => i.id !== id);
    await writeProfiles(items);
    await deletePassword(id);
    await closePool(id);
    return true;
  });
  ipcMain.handle(IPC.DbConnect, async (_e, id) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    await openPool(profile);
    return true;
  });
  ipcMain.handle(IPC.DbTest, async (_e, profile) => {
    return testProfile(profile);
  });
  ipcMain.handle(IPC.DbListDatabases, async (_e, id) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    const pool = await openPool(profile);
    if (pool.driver === "elasticsearch") {
      const r = await esFetch(profile, pool.client.password, "GET", "/", void 0, pool.client.relayHost, pool.client.relayPort);
      const cluster = r.body?.cluster_name || "cluster";
      return { databases: [cluster], current: cluster };
    }
    if (pool.driver === "mysql") {
      const [rows] = await pool.client.query("SHOW DATABASES");
      const names = rows.map((r) => r.Database ?? r.database).filter(Boolean).filter((n) => !["information_schema", "mysql", "performance_schema", "sys"].includes(n));
      return { databases: names, current: effectiveDatabase(profile) };
    } else {
      const r = await pool.client.query(
        `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname`
      );
      const names = r.rows.map((x) => x.datname);
      return { databases: names, current: effectiveDatabase(profile) };
    }
  });
  ipcMain.handle(IPC.DbEsRequest, async (_e, id, payload) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    if (profile.driver !== "elasticsearch") throw new Error("Not an ES connection");
    const pool = await openPool(profile);
    const start = Date.now();
    const method = (payload.method || "GET").toUpperCase();
    const path = payload.path || "/_search";
    const r = await esFetch(pool.profile, pool.client.password, method, path, payload.body, pool.client.relayHost, pool.client.relayPort);
    return { status: r.status, body: r.body, durationMs: Date.now() - start };
  });
  ipcMain.handle(IPC.DbSwitchDatabase, async (_e, id, dbName) => {
    dbOverrides.set(id, dbName);
    await closePool(id);
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    await openPool(profile);
    return true;
  });
  ipcMain.handle(IPC.DbDisconnect, (_e, id) => closePool(id));
  ipcMain.handle(IPC.DbSchema, async (_e, id) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    const pool = await openPool(profile);
    return fetchSchema(pool);
  });
  ipcMain.handle(IPC.DbQuery, async (_e, id, sql) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    if (profile.readOnly && /^\s*(drop|delete|update|insert|truncate|alter)\b/i.test(sql)) {
      throw new Error("Connection is read-only");
    }
    const pool = await openPool(profile);
    return runQuery(pool, sql);
  });
  ipcMain.handle(IPC.DbUpdateRows, async (_e, args) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === args.connId);
    if (!profile) throw new Error("Profile not found");
    if (profile.readOnly) throw new Error("Connection is read-only");
    if (profile.driver === "elasticsearch") throw new Error("Row updates are only supported on SQL connections");
    const pool = await openPool(profile);
    const driver = pool.driver;
    const errors = [];
    let applied = 0;
    if (driver === "mysql") {
      const conn = await pool.client.getConnection();
      try {
        await conn.beginTransaction();
        for (let i = 0; i < args.updates.length; i++) {
          const u = args.updates[i];
          if (!Object.keys(u.set).length || !Object.keys(u.where).length) {
            errors.push({ index: i, message: "empty set or where" });
            continue;
          }
          const setKeys = Object.keys(u.set);
          const whereKeys = Object.keys(u.where);
          const setSql = setKeys.map((k) => `\`${k.replace(/`/g, "``")}\` = ?`).join(", ");
          const whereSql = whereKeys.map((k) => `\`${k.replace(/`/g, "``")}\` = ?`).join(" AND ");
          const ref = args.schema ? `\`${args.schema.replace(/`/g, "``")}\`.\`${args.table.replace(/`/g, "``")}\`` : `\`${args.table.replace(/`/g, "``")}\``;
          const sql = `UPDATE ${ref} SET ${setSql} WHERE ${whereSql} LIMIT 1`;
          const params = [...setKeys.map((k) => u.set[k]), ...whereKeys.map((k) => u.where[k])];
          try {
            const [res] = await conn.query(sql, params);
            const affected = res?.affectedRows ?? 0;
            if (affected === 0) errors.push({ index: i, message: "no row matched WHERE" });
            else applied++;
          } catch (e) {
            errors.push({ index: i, message: e?.message || String(e) });
          }
        }
        if (errors.length === args.updates.length) await conn.rollback();
        else await conn.commit();
      } finally {
        try {
          conn.release();
        } catch {
        }
      }
    } else {
      const client = pool.client;
      try {
        await client.query("BEGIN");
        for (let i = 0; i < args.updates.length; i++) {
          const u = args.updates[i];
          if (!Object.keys(u.set).length || !Object.keys(u.where).length) {
            errors.push({ index: i, message: "empty set or where" });
            continue;
          }
          const setKeys = Object.keys(u.set);
          const whereKeys = Object.keys(u.where);
          const params = [];
          const setSql = setKeys.map((k) => {
            params.push(u.set[k]);
            return `"${k.replace(/"/g, '""')}" = $${params.length}`;
          }).join(", ");
          const whereSql = whereKeys.map((k) => {
            params.push(u.where[k]);
            return `"${k.replace(/"/g, '""')}" = $${params.length}`;
          }).join(" AND ");
          const ref = args.schema ? `"${args.schema.replace(/"/g, '""')}"."${args.table.replace(/"/g, '""')}"` : `"${args.table.replace(/"/g, '""')}"`;
          const sql = `UPDATE ${ref} SET ${setSql} WHERE ${whereSql}`;
          try {
            const res = await client.query(sql, params);
            if ((res.rowCount ?? 0) === 0) errors.push({ index: i, message: "no row matched WHERE" });
            else applied++;
          } catch (e) {
            errors.push({ index: i, message: e?.message || String(e) });
          }
        }
        if (errors.length === args.updates.length) await client.query("ROLLBACK");
        else await client.query("COMMIT");
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
        }
        throw e;
      }
    }
    return { applied, errors };
  });
}
onShutdown(async () => {
  for (const id of [...pools.keys()]) await closePool(id);
});
const dbApi = {
  listProfiles: () => readProfiles(),
  connect: async (id) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    await openPool(profile);
    return true;
  },
  disconnect: (id) => closePool(id),
  listDatabases: async (id) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    const pool = await openPool(profile);
    if (pool.driver === "elasticsearch") {
      const r2 = await esFetch(profile, pool.client.password, "GET", "/", void 0, pool.client.relayHost, pool.client.relayPort);
      const cluster = r2.body?.cluster_name || "cluster";
      return { databases: [cluster], current: cluster };
    }
    if (pool.driver === "mysql") {
      const [rows] = await pool.client.query("SHOW DATABASES");
      const names2 = rows.map((r2) => r2.Database ?? r2.database).filter(Boolean).filter((n) => !["information_schema", "mysql", "performance_schema", "sys"].includes(n));
      return { databases: names2, current: effectiveDatabase(profile) };
    }
    const r = await pool.client.query(
      `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname`
    );
    const names = r.rows.map((x) => x.datname);
    return { databases: names, current: effectiveDatabase(profile) };
  },
  switchDatabase: async (id, dbName) => {
    dbOverrides.set(id, dbName);
    await closePool(id);
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    await openPool(profile);
    return true;
  },
  schema: async (id) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    const pool = await openPool(profile);
    return fetchSchema(pool);
  },
  query: async (id, sql) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    if (profile.readOnly && /^\s*(drop|delete|update|insert|truncate|alter)\b/i.test(sql)) {
      throw new Error("Connection is read-only");
    }
    const pool = await openPool(profile);
    return runQuery(pool, sql);
  },
  esRequest: async (id, payload) => {
    const items = await readProfiles();
    const profile = items.find((i) => i.id === id);
    if (!profile) throw new Error("Profile not found");
    if (profile.driver !== "elasticsearch") throw new Error("Not an ES connection");
    const pool = await openPool(profile);
    const start = Date.now();
    const method = (payload.method || "GET").toUpperCase();
    const path = payload.path || "/_search";
    const r = await esFetch(pool.profile, pool.client.password, method, path, payload.body, pool.client.relayHost, pool.client.relayPort);
    return { status: r.status, body: r.body, durationMs: Date.now() - start };
  }
};
let gitInstance = null;
let gitRoot;
function git() {
  const root = requireRoot();
  if (!gitInstance || gitRoot !== root) {
    gitInstance = simpleGit(root);
    gitRoot = root;
  }
  return gitInstance;
}
async function bundleRepo(root) {
  const out = join(tmpdir(), `opendev-bundle-${randomUUID()}.bundle`);
  await simpleGit(root).raw(["bundle", "create", out, "--all"]);
  return out;
}
async function applyBundle(bundlePath, targetDir) {
  let exists = false;
  try {
    await promises.access(join(targetDir, ".git"));
    exists = true;
  } catch {
  }
  if (exists) {
    const g = simpleGit(targetDir);
    await g.raw(["fetch", bundlePath, "+refs/heads/*:refs/heads/*", "--force"]);
    const head = (await simpleGit(targetDir).raw(["rev-parse", "HEAD"])).trim();
    await g.raw(["reset", "--hard", head]);
  } else {
    await promises.mkdir(targetDir, { recursive: true });
    await simpleGit().raw(["clone", bundlePath, targetDir]);
  }
}
function peerRepoDir(workspaceName) {
  const safe = workspaceName.replace(/[^a-zA-Z0-9._-]/g, "_") || "repo";
  return join(app.getPath("appData"), "openDev", "peer-repos", safe);
}
function mapStatus(idx, wt) {
  if (idx === "A" || wt === "A") return "added";
  if (idx === "D" || wt === "D") return "deleted";
  if (idx === "R" || wt === "R") return "renamed";
  if (idx === "U" || wt === "U") return "conflicted";
  if (idx === "?" || wt === "?") return "untracked";
  return "modified";
}
async function status$1() {
  try {
    const s = await git().status();
    const out = [];
    for (const f of s.files) {
      out.push({
        path: f.path,
        status: mapStatus(f.index, f.working_dir),
        staged: f.index !== " " && f.index !== "?"
      });
    }
    return out;
  } catch {
    return [];
  }
}
const worktreesFile = () => join(workspace.getRoot(), ".opendev", "worktrees.json");
async function readWorktrees() {
  try {
    const raw = await promises.readFile(worktreesFile(), "utf8");
    return JSON.parse(raw).items;
  } catch {
    return [];
  }
}
async function writeWorktrees(items) {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace");
  await promises.mkdir(join(root, ".opendev"), { recursive: true });
  await promises.writeFile(worktreesFile(), JSON.stringify({ items }, null, 2), "utf8");
}
function registerGitIpc() {
  ipcMain.handle(IPC.GitStatus, () => status$1());
  ipcMain.handle(IPC.GitDiff, async (_e, path) => {
    try {
      return path ? await git().diff(["--", path]) : await git().diff();
    } catch {
      return "";
    }
  });
  ipcMain.handle(IPC.GitStage, async (_e, paths) => {
    await git().add(paths);
    return true;
  });
  ipcMain.handle(IPC.GitUnstage, async (_e, paths) => {
    await git().reset(["HEAD", "--", ...paths]);
    return true;
  });
  ipcMain.handle(IPC.GitCommit, async (_e, message) => {
    const r = await git().commit(message);
    return r.commit;
  });
  ipcMain.handle(IPC.GitPush, async () => {
    try {
      await git().push();
      return true;
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle(IPC.GitPull, async () => {
    try {
      await git().pull();
      return true;
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle(IPC.GitBranch, async () => {
    try {
      const r = await git().branch();
      return r;
    } catch {
      return null;
    }
  });
  ipcMain.handle(IPC.GitCheckout, async (_e, branch) => {
    await git().checkout(branch);
    return true;
  });
  ipcMain.handle(IPC.GitBlame, async (_e, filePath) => {
    try {
      const dir = dirName(filePath);
      const file = baseName(filePath);
      const g = simpleGit(dir);
      const raw = await g.raw(["blame", "--porcelain", "--", file]);
      const commits = /* @__PURE__ */ new Map();
      const lines = [];
      const text = raw.split("\n");
      let i = 0;
      while (i < text.length) {
        const line = text[i++];
        if (!line) continue;
        const m = line.match(/^\^?([0-9a-f]{7,40})\s+\d+\s+(\d+)(?:\s+\d+)?\s*$/);
        if (!m) continue;
        const hash = m[1];
        const finalLine = Number(m[2]);
        let entry = commits.get(hash);
        if (!entry) entry = { hash };
        while (i < text.length && !text[i].startsWith("	")) {
          const meta = text[i++];
          if (meta.startsWith("author ")) entry.author = meta.slice(7);
          else if (meta.startsWith("author-time ")) entry.authorTime = Number(meta.slice(12));
          else if (meta.startsWith("summary ")) entry.summary = meta.slice(8);
        }
        i++;
        commits.set(hash, entry);
        const dateStr = entry.authorTime ? new Date(entry.authorTime * 1e3).toISOString().slice(0, 10) : void 0;
        lines.push({ line: finalLine, hash, author: entry.author, date: dateStr, summary: entry.summary });
      }
      console.log(`[git blame] ${filePath} → parsed ${lines.length} lines from ${raw.length} bytes`);
      return { lines };
    } catch (e) {
      console.error(`[git blame] ${filePath} failed:`, e?.message || e);
      return { error: e?.message || String(e) };
    }
  });
  ipcMain.handle(IPC.GitFileLog, async (_e, filePath, limit = 100) => {
    try {
      const dir = dirName(filePath);
      const file = baseName(filePath);
      const g = simpleGit(dir);
      const log = await g.log({ file, maxCount: limit, "--follow": null });
      return { commits: log.all };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  });
  ipcMain.handle(IPC.GitShow, async (_e, dir, hash) => {
    try {
      const g = simpleGit(dir);
      const diff = await g.show([hash, "--stat", "--patch"]);
      return { diff };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  });
  ipcMain.handle(IPC.GitBranchesAt, async (_e, absPath) => {
    try {
      const g = simpleGit(absPath);
      const r = await g.branch(["-a"]);
      return { current: r.current, all: r.all };
    } catch (err2) {
      return { error: err2?.message || String(err2) };
    }
  });
  ipcMain.handle(IPC.GitCheckoutAt, async (_e, absPath, branch) => {
    try {
      const g = simpleGit(absPath);
      await g.checkout(branch);
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: err2?.message || String(err2) };
    }
  });
  ipcMain.handle(IPC.GitLog, async (_e, limit = 50) => {
    try {
      return await git().log({ maxCount: limit });
    } catch {
      return { all: [] };
    }
  });
  ipcMain.handle(IPC.GitWorktreeCreate, async (_e, opts) => {
    const root = workspace.getRoot();
    const id = randomUUID();
    const name = opts.name || `sandbox-${id.slice(0, 8)}`;
    const wtPath = join(root, ".opendev", "worktrees", name);
    await promises.mkdir(join(root, ".opendev", "worktrees"), { recursive: true });
    const branch = opts.branch || `opendev/${name}`;
    await git().raw(["worktree", "add", "-b", branch, wtPath]);
    const items = await readWorktrees();
    const info = { id, path: wtPath, branch, createdAt: Date.now() };
    items.push(info);
    await writeWorktrees(items);
    return info;
  });
  ipcMain.handle(IPC.GitWorktreeList, async () => readWorktrees());
  ipcMain.handle(IPC.GitWorktreeRemove, async (_e, id) => {
    const items = await readWorktrees();
    const wt = items.find((w) => w.id === id);
    if (!wt) return false;
    try {
      await git().raw(["worktree", "remove", "--force", wt.path]);
    } catch {
    }
    try {
      await git().raw(["branch", "-D", wt.branch]);
    } catch {
    }
    await writeWorktrees(items.filter((w) => w.id !== id));
    return true;
  });
  ipcMain.handle(IPC.GitWorktreeMerge, async (_e, id) => {
    const items = await readWorktrees();
    const wt = items.find((w) => w.id === id);
    if (!wt) return false;
    await git().raw(["merge", "--no-ff", wt.branch]);
    return true;
  });
}
function makeBatcher(id) {
  let pending = "";
  let dropped = 0;
  let timer2 = null;
  const flush = () => {
    timer2 = null;
    if (!pending && !dropped) return;
    let data = pending;
    pending = "";
    if (dropped > 0) {
      data = `\r
[terminal output throttled — dropped ${dropped} bytes]\r
` + data;
      dropped = 0;
    }
    safeSend(IPC.TermData, { id, data });
  };
  return {
    push: (s) => {
      pending += s;
      if (pending.length > LIMITS.ptyBacklogBytes) {
        const overflow = pending.length - LIMITS.ptyBacklogBytes;
        pending = pending.slice(overflow);
        dropped += overflow;
      }
      if (pending.length >= LIMITS.ptyFlushBytes) {
        if (timer2) {
          clearTimeout(timer2);
          timer2 = null;
        }
        flush();
      } else if (!timer2) {
        timer2 = setTimeout(flush, LIMITS.ptyFlushMs);
        timer2.unref?.();
      }
    },
    flush,
    dispose: () => {
      if (timer2) {
        clearTimeout(timer2);
        timer2 = null;
      }
      pending = "";
      dropped = 0;
    }
  };
}
const terms = /* @__PURE__ */ new Map();
const batchers = /* @__PURE__ */ new Map();
let nodePty = null;
async function loadNodePty() {
  if (nodePty) return nodePty;
  try {
    nodePty = await import("node-pty");
    return nodePty;
  } catch (err2) {
    console.error("node-pty unavailable, falling back to child_process", err2);
    return null;
  }
}
async function createPty(cwd, cols, rows) {
  const pty = await loadNodePty();
  const { file: shell2, args: shellArgs } = terminalShell();
  if (pty) {
    const term = pty.spawn(shell2, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: process.env
    });
    return {
      write: (s) => term.write(s),
      resize: (c, r) => term.resize(c, r),
      kill: (sig) => term.kill(sig),
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(({ exitCode }) => cb(exitCode))
    };
  }
  const { spawn: spawn2 } = await import("child_process");
  const child = spawn2(shell2, shellArgs.length ? shellArgs : ["-i"], { cwd, env: process.env });
  return {
    write: (s) => child.stdin?.write(s),
    resize: () => {
    },
    kill: (sig) => child.kill(sig || "SIGTERM"),
    onData: (cb) => {
      child.stdout?.on("data", (b) => cb(b.toString("utf8")));
      child.stderr?.on("data", (b) => cb(b.toString("utf8")));
    },
    onExit: (cb) => child.on("exit", (code) => cb(code ?? 0))
  };
}
function registerTerminalIpc() {
  ipcMain.handle(IPC.TermCreate, async (_e, opts) => {
    const id = randomUUID();
    const cwd = opts?.cwd || workspace.getRoot() || process.env.HOME || "/";
    const term = await createPty(cwd, opts?.cols ?? 80, opts?.rows ?? 24);
    terms.set(id, term);
    const batcher = makeBatcher(id);
    batchers.set(id, batcher);
    term.onData((s) => batcher.push(s));
    term.onExit((code) => {
      batcher.flush();
      batcher.dispose();
      batchers.delete(id);
      terms.delete(id);
      safeSend(IPC.TermExit, { id, code });
    });
    return { id, cwd };
  });
  ipcMain.handle(IPC.TermWrite, (_e, id, data) => {
    terms.get(id)?.write(data);
    return true;
  });
  ipcMain.handle(IPC.TermResize, (_e, id, cols, rows) => {
    terms.get(id)?.resize(cols, rows);
    return true;
  });
  ipcMain.handle(IPC.TermKill, (_e, id) => {
    terms.get(id)?.kill();
    batchers.get(id)?.dispose();
    batchers.delete(id);
    return true;
  });
}
onShutdown(() => {
  for (const b of batchers.values()) {
    try {
      b.dispose();
    } catch {
    }
  }
  batchers.clear();
  for (const t of terms.values()) {
    try {
      t.kill();
    } catch {
    }
  }
});
function registerBrowserIpc() {
  ipcMain.handle(IPC.BrowserScreenshotRect, async (_e, rect) => {
    return null;
  });
}
const securityScanSrc = `// Security Scan — dependency-free secret/credential scan of the workspace.
// Walks the codebase looking for hardcoded secrets, private keys, and
// committed .env files, then emits an HTML report.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const TEXT_EXT = /\\.(js|jsx|ts|tsx|mjs|cjs|json|ya?ml|sh|bash|zsh|py|rb|go|java|php|rs|c|cc|cpp|cs|kt|swift|env|config|conf|ini|properties|xml|txt|md|html|css|scss|sql)$/i;
const MAX_FILE = 2 * 1024 * 1024;

const PATTERNS = [
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g, sev: 'high' },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, sev: 'high' },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, sev: 'high' },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g, sev: 'high' },
  { name: 'GitHub token', re: /gh[pousr]_[0-9A-Za-z]{36,}/g, sev: 'high' },
  { name: 'DB URL with password', re: /(?:mysql|postgres(?:ql)?|mongodb(?:\\+srv)?):\\/\\/[^\\s:'"]+:[^\\s@'"]+@/gi, sev: 'medium' },
  { name: 'Hardcoded secret/token', re: /(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)["']?\\s*[:=]\\s*["'][^"'\\s]{12,}["']/gi, sev: 'medium' },
  { name: 'JWT-like token', re: /eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/g, sev: 'low' }
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const findings = [];
const files = walk(ROOT);
let scanned = 0;

for (const f of files) {
  const base = path.basename(f);
  const rel = path.relative(ROOT, f);

  // Committed real .env files (not examples/templates).
  if (/^\\.env(\\..+)?$/.test(base) && !/example|sample|template|dist/i.test(base)) {
    findings.push({ rel, line: 0, sev: 'medium', name: 'Committed .env file', snippet: base });
  }

  if (!TEXT_EXT.test(base)) continue;
  let stat;
  try { stat = fs.statSync(f); } catch { continue; }
  if (stat.size > MAX_FILE) continue;
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
  scanned++;
  const lines = content.split('\\n');
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split('\\n').length;
      const snippet = (lines[lineNo - 1] || '').trim().slice(0, 140);
      findings.push({ rel, line: lineNo, sev: p.sev, name: p.name, snippet });
      if (p.re.lastIndex === m.index) p.re.lastIndex++;
    }
  }
}

const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => (order[a.sev] - order[b.sev]) || a.rel.localeCompare(b.rel) || a.line - b.line);
const counts = { high: 0, medium: 0, low: 0 };
for (const x of findings) counts[x.sev]++;

const rows = findings.map((x) => \`
  <tr class="sev-\${x.sev}">
    <td class="sev"><span class="badge \${x.sev}">\${x.sev}</span></td>
    <td class="what">\${esc(x.name)}</td>
    <td class="loc">\${esc(x.rel)}\${x.line ? ':' + x.line : ''}</td>
    <td class="snip"><code>\${esc(x.snippet || '')}</code></td>
  </tr>\`).join('');

const html = \`<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 18px; }
  .summary { display: flex; gap: 10px; margin-bottom: 20px; }
  .stat { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 10px 16px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat.high .n { color: #f48771; } .stat.medium .n { color: #cca700; } .stat.low .n { color: #4ec9b0; }
  .stat .l { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #888; padding: 6px 8px; border-bottom: 1px solid #3c3c3c; }
  td { padding: 6px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; }
  .badge.high { background: rgba(244,135,113,.18); color: #f48771; }
  .badge.medium { background: rgba(204,167,0,.18); color: #cca700; }
  .badge.low { background: rgba(78,201,176,.18); color: #4ec9b0; }
  .loc { font-family: ui-monospace, Menlo, monospace; color: #9cdcfe; font-size: 12px; }
  .snip code { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #ce9178; word-break: break-all; }
  .ok { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 24px; text-align: center; color: #4ec9b0; }
</style></head><body>
  <h1>🔒 Security Scan</h1>
  <div class="sub">Scanned \${scanned} text files under \${esc(ROOT)}</div>
  <div class="summary">
    <div class="stat high"><div class="n">\${counts.high}</div><div class="l">High</div></div>
    <div class="stat medium"><div class="n">\${counts.medium}</div><div class="l">Medium</div></div>
    <div class="stat low"><div class="n">\${counts.low}</div><div class="l">Low</div></div>
  </div>
  \${findings.length === 0
    ? '<div class="ok">✓ No hardcoded secrets or credentials found.</div>'
    : \`<table><thead><tr><th>Severity</th><th>Finding</th><th>Location</th><th>Snippet</th></tr></thead><tbody>\${rows}</tbody></table>\`}
</body></html>\`;

console.log(html);
`;
const codeQualitySrc = `// Code Quality — runs ESLint if it's installed in the workspace, and always
// reports dependency-free metrics (file counts, size, LOC, TODO density).
// If ESLint isn't installed it tells you how to add it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const CODE_EXT = /\\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i;
const MAX_FILE = 4 * 1024 * 1024;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Dependency-free metrics ──────────────────────────────────────────
const files = walk(ROOT);
const byExt = {};
let totalLoc = 0;
let todoCount = 0;
const largest = [];

for (const f of files) {
  const ext = (path.extname(f) || '(none)').toLowerCase();
  byExt[ext] = (byExt[ext] || 0) + 1;
  if (!CODE_EXT.test(f)) continue;
  let stat;
  try { stat = fs.statSync(f); } catch { continue; }
  if (stat.size > MAX_FILE) continue;
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const loc = content.split('\\n').length;
  totalLoc += loc;
  todoCount += (content.match(/\\b(?:TODO|FIXME|HACK|XXX)\\b/g) || []).length;
  largest.push({ rel: path.relative(ROOT, f), loc });
}
largest.sort((a, b) => b.loc - a.loc);
const topLargest = largest.slice(0, 10);
const codeFileCount = largest.length;

// ── ESLint (only if installed in the workspace) ──────────────────────
const eslintBin = path.join(ROOT, 'node_modules', '.bin', 'eslint');
const eslintAvailable = fs.existsSync(eslintBin);
let eslintResults = null;
let eslintError = null;
if (eslintAvailable) {
  try {
    const out = execFileSync(eslintBin, ['.', '--format', 'json', '--no-error-on-unmatched-pattern'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
    });
    eslintResults = JSON.parse(out);
  } catch (err) {
    // ESLint exits 1 when it finds lint problems — the JSON is still on stdout.
    if (err && err.stdout) {
      try { eslintResults = JSON.parse(err.stdout.toString()); }
      catch { eslintError = String(err.message || err); }
    } else {
      eslintError = String((err && err.message) || err);
    }
  }
}

let eslintErrors = 0, eslintWarnings = 0;
const eslintTop = [];
if (eslintResults) {
  for (const r of eslintResults) {
    eslintErrors += r.errorCount || 0;
    eslintWarnings += r.warningCount || 0;
    if ((r.errorCount || 0) + (r.warningCount || 0) > 0) {
      eslintTop.push({ rel: path.relative(ROOT, r.filePath), e: r.errorCount || 0, w: r.warningCount || 0 });
    }
  }
  eslintTop.sort((a, b) => (b.e + b.w) - (a.e + a.w));
}

const extRows = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([ext, n]) => \`<tr><td class="loc">\${esc(ext)}</td><td>\${n}</td></tr>\`).join('');
const largeRows = topLargest
  .map((x) => \`<tr><td class="loc">\${esc(x.rel)}</td><td>\${x.loc}</td></tr>\`).join('');

let eslintSection;
if (!eslintAvailable) {
  eslintSection = \`<div class="callout">
    <strong>ESLint is not installed in this project.</strong><br>
    Install it to enable lint checks here:
    <pre>npm install --save-dev eslint</pre>
    Then re-run this agent.
  </div>\`;
} else if (eslintError) {
  eslintSection = \`<div class="callout">ESLint ran but couldn't be parsed: <code>\${esc(eslintError)}</code></div>\`;
} else {
  const rows = eslintTop.slice(0, 15)
    .map((x) => \`<tr><td class="loc">\${esc(x.rel)}</td><td class="err">\${x.e}</td><td class="warn">\${x.w}</td></tr>\`).join('');
  eslintSection = \`
    <div class="summary">
      <div class="stat err"><div class="n">\${eslintErrors}</div><div class="l">Errors</div></div>
      <div class="stat warn"><div class="n">\${eslintWarnings}</div><div class="l">Warnings</div></div>
    </div>
    \${eslintTop.length === 0
      ? '<div class="ok">✓ ESLint found no problems.</div>'
      : \`<table><thead><tr><th>File</th><th>Errors</th><th>Warnings</th></tr></thead><tbody>\${rows}</tbody></table>\`}\`;
}

const html = \`<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 26px 0 10px; color: #cccccc; }
  .sub { color: #888; margin-bottom: 18px; }
  .summary { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 10px 16px; min-width: 80px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat .l { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: .05em; }
  .stat.err .n { color: #f48771; } .stat.warn .n { color: #cca700; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #888; padding: 6px 8px; border-bottom: 1px solid #3c3c3c; }
  td { padding: 5px 8px; border-bottom: 1px solid #2a2a2a; }
  .loc { font-family: ui-monospace, Menlo, monospace; color: #9cdcfe; font-size: 12px; }
  td.err { color: #f48771; } td.warn { color: #cca700; }
  .callout { background: #2d2d30; border: 1px solid #cca700; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
  .callout pre { background: #1e1e1e; padding: 8px 10px; border-radius: 6px; margin: 8px 0 0; color: #ce9178; }
  .ok { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 18px; text-align: center; color: #4ec9b0; }
  .grid { display: flex; gap: 24px; flex-wrap: wrap; }
  .grid > div { flex: 1; min-width: 220px; }
</style></head><body>
  <h1>📊 Code Quality</h1>
  <div class="sub">\${codeFileCount} code files · \${totalLoc.toLocaleString()} lines · \${todoCount} TODO/FIXME markers · under \${esc(ROOT)}</div>

  <h2>ESLint</h2>
  \${eslintSection}

  <div class="grid">
    <div>
      <h2>Largest code files</h2>
      <table><thead><tr><th>File</th><th>Lines</th></tr></thead><tbody>\${largeRows || '<tr><td colspan="2">No code files found.</td></tr>'}</tbody></table>
    </div>
    <div>
      <h2>Files by extension</h2>
      <table><thead><tr><th>Ext</th><th>Count</th></tr></thead><tbody>\${extRows}</tbody></table>
    </div>
  </div>
</body></html>\`;

console.log(html);
`;
const todoCollectorSrc = "// TODO Collector — scans the codebase for TODO / FIXME / HACK / XXX / BUG\n// comment markers and turns them into a checklist of tasks, grouped by file.\nimport fs from 'node:fs';\nimport path from 'node:path';\n\nconst ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();\nconst SKIP_DIRS = new Set([\n  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',\n  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'\n]);\nconst TEXT_EXT = /\\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|go|java|php|rs|c|cc|cpp|cs|kt|swift|sh|css|scss|html|md|yml|yaml|sql)$/i;\nconst MAX_FILE = 2 * 1024 * 1024;\nconst MARKER = /\\b(TODO|FIXME|HACK|XXX|BUG)\\b[:\\s-]*(.*)$/;\n\nfunction walk(dir, out = []) {\n  let entries;\n  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }\n  for (const e of entries) {\n    const full = path.join(dir, e.name);\n    if (e.isDirectory()) {\n      if (SKIP_DIRS.has(e.name)) continue;\n      walk(full, out);\n    } else if (e.isFile() && TEXT_EXT.test(e.name)) {\n      out.push(full);\n    }\n  }\n  return out;\n}\n\nfunction esc(s) {\n  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n}\n\nconst byFile = new Map();\nconst tagCounts = { TODO: 0, FIXME: 0, HACK: 0, XXX: 0, BUG: 0 };\nlet total = 0;\n\nfor (const f of walk(ROOT)) {\n  let stat;\n  try { stat = fs.statSync(f); } catch { continue; }\n  if (stat.size > MAX_FILE) continue;\n  let content;\n  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }\n  const lines = content.split('\\n');\n  const rel = path.relative(ROOT, f);\n  for (let i = 0; i < lines.length; i++) {\n    const m = lines[i].match(MARKER);\n    if (!m) continue;\n    const tag = m[1].toUpperCase();\n    tagCounts[tag] = (tagCounts[tag] || 0) + 1;\n    total++;\n    if (!byFile.has(rel)) byFile.set(rel, []);\n    byFile.get(rel).push({ line: i + 1, tag, text: (m[2] || '').trim().slice(0, 200) });\n  }\n}\n\nconst sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);\n\nconst sections = sortedFiles.map(([rel, items]) => {\n  const rows = items.map((it) => `\n    <li class=\"task\">\n      <span class=\"tag ${it.tag.toLowerCase()}\">${it.tag}</span>\n      <span class=\"line\">:${it.line}</span>\n      <span class=\"text\">${esc(it.text) || '<em>(no description)</em>'}</span>\n    </li>`).join('');\n  return `<div class=\"file\"><div class=\"file-name\">${esc(rel)} <span class=\"file-n\">${items.length}</span></div><ul>${rows}</ul></div>`;\n}).join('');\n\nconst chips = Object.entries(tagCounts).filter(([, n]) => n > 0)\n  .map(([t, n]) => `<span class=\"chip ${t.toLowerCase()}\">${t} ${n}</span>`).join('');\n\nconst html = `<!doctype html><html><head><meta charset=\"utf-8\"><style>\n  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }\n  h1 { font-size: 18px; margin: 0 0 4px; }\n  .sub { color: #888; margin-bottom: 14px; }\n  .chips { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }\n  .chip { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 5px; background: #2d2d30; border: 1px solid #3c3c3c; }\n  .chip.todo { color: #4ec9b0; } .chip.fixme { color: #f48771; } .chip.hack { color: #cca700; }\n  .chip.xxx { color: #c586c0; } .chip.bug { color: #f48771; }\n  .file { margin-bottom: 16px; }\n  .file-name { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #9cdcfe; margin-bottom: 4px; }\n  .file-n { background: #3c3c3c; color: #ccc; border-radius: 8px; padding: 0 6px; font-size: 10px; }\n  ul { list-style: none; margin: 0; padding: 0; }\n  .task { display: flex; gap: 8px; align-items: baseline; padding: 3px 0 3px 12px; border-left: 2px solid #2a2a2a; }\n  .tag { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; }\n  .tag.todo { background: rgba(78,201,176,.18); color: #4ec9b0; }\n  .tag.fixme, .tag.bug { background: rgba(244,135,113,.18); color: #f48771; }\n  .tag.hack { background: rgba(204,167,0,.18); color: #cca700; }\n  .tag.xxx { background: rgba(197,134,192,.18); color: #c586c0; }\n  .line { font-family: ui-monospace, Menlo, monospace; color: #888; font-size: 11px; flex-shrink: 0; }\n  .text { color: #d4d4d4; }\n  .ok { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 24px; text-align: center; color: #4ec9b0; }\n</style></head><body>\n  <h1>✅ TODO Collector</h1>\n  <div class=\"sub\">${total} marker${total === 1 ? '' : 's'} across ${byFile.size} file${byFile.size === 1 ? '' : 's'} · under ${esc(ROOT)}</div>\n  <div class=\"chips\">${chips || ''}</div>\n  ${total === 0 ? '<div class=\"ok\">✓ No TODO/FIXME markers found — clean codebase.</div>' : sections}\n</body></html>`;\n\nconsole.log(html);\n";
const designGallerySrc = `// Design Gallery — surveys the UI surface of the project: renders every
// standalone HTML file in a live preview grid, and inventories CSS and
// component files. A quick visual overview of the project's design.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.OPENDEV_WORKSPACE_ROOT || process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage',
  '.opendev', '.cache', 'vendor', '.turbo', '.parcel-cache'
]);
const MAX_HTML = 512 * 1024;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Escape content for use inside a double-quoted srcdoc="" attribute.
function attrEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const files = walk(ROOT);
const htmlFiles = [];
let cssCount = 0;
let componentCount = 0;

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    if (stat.size > MAX_HTML) continue;
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    htmlFiles.push({ rel: path.relative(ROOT, f), content });
  } else if (ext === '.css' || ext === '.scss' || ext === '.sass' || ext === '.less') {
    cssCount++;
  } else if (/\\.(jsx|tsx|vue|svelte)$/i.test(f)) {
    componentCount++;
  }
}

const cards = htmlFiles.slice(0, 40).map((h) => \`
  <div class="card">
    <div class="card-head">\${esc(h.rel)}</div>
    <div class="frame-wrap">
      <iframe sandbox="" srcdoc="\${attrEsc(h.content)}"></iframe>
    </div>
  </div>\`).join('');

const html = \`<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 18px; }
  .summary { display: flex; gap: 10px; margin-bottom: 22px; flex-wrap: wrap; }
  .stat { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 10px 16px; min-width: 90px; }
  .stat .n { font-size: 22px; font-weight: 700; color: #9cdcfe; }
  .stat .l { font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: .05em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .card { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; overflow: hidden; }
  .card-head { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: #9cdcfe; padding: 8px 10px; border-bottom: 1px solid #3c3c3c; }
  .frame-wrap { height: 240px; background: #fff; }
  iframe { width: 100%; height: 100%; border: 0; }
  .empty { background: #2d2d30; border: 1px solid #3c3c3c; border-radius: 8px; padding: 24px; text-align: center; color: #888; }
</style></head><body>
  <h1>🎨 Design Gallery</h1>
  <div class="sub">UI surface of \${esc(ROOT)}</div>
  <div class="summary">
    <div class="stat"><div class="n">\${htmlFiles.length}</div><div class="l">HTML pages</div></div>
    <div class="stat"><div class="n">\${cssCount}</div><div class="l">Stylesheets</div></div>
    <div class="stat"><div class="n">\${componentCount}</div><div class="l">Components</div></div>
  </div>
  \${htmlFiles.length === 0
    ? \`<div class="empty">No standalone HTML files found to preview.<br>This project has \${cssCount} stylesheet(s) and \${componentCount} component file(s) — its UI is likely rendered by a framework.</div>\`
    : \`<div class="grid">\${cards}</div>\`}
</body></html>\`;

console.log(html);
`;
function manifest(slug, name, description) {
  return {
    slug,
    name,
    description,
    entry: "index.mjs",
    runtime: "node",
    createdBy: "builtin",
    createdAt: 0
  };
}
const BUILTIN_AGENTS = [
  {
    manifest: manifest(
      "security-scan",
      "Security Scan",
      "Scans the codebase for hardcoded secrets, private keys, and committed .env files."
    ),
    source: securityScanSrc
  },
  {
    manifest: manifest(
      "code-quality",
      "Code Quality",
      "Runs ESLint (if installed) plus dependency-free metrics: file counts, LOC, TODO density."
    ),
    source: codeQualitySrc
  },
  {
    manifest: manifest(
      "todo-collector",
      "TODO Collector",
      "Collects TODO / FIXME / HACK / XXX / BUG markers into a checklist of tasks."
    ),
    source: todoCollectorSrc
  },
  {
    manifest: manifest(
      "design-gallery",
      "Design Gallery",
      "Surveys the project UI — renders every standalone HTML page in a live preview grid."
    ),
    source: designGallerySrc
  }
];
const BUILTIN_SLUGS = new Set(BUILTIN_AGENTS.map((a) => a.manifest.slug));
const LOG_TAIL$1 = 2e3;
const STARTER_INDEX = `// OpenDev IDE agent — a standalone Node.js app run against the workspace codebase.
//
// Runtime contract:
//   - cwd is the workspace root (the codebase you operate on).
//   - process.env.OPENDEV_WORKSPACE_ROOT  — absolute path to the codebase.
//   - process.env.OPENDEV_AGENT_DIR       — absolute path to this agent's folder.
//   - Write results to stdout. If the FIRST thing you print is a full HTML
//     document (starts with <!doctype html> or <html>), the IDE renders it
//     in a sandboxed iframe; otherwise stdout streams as a plain log.
//   - Bundle any npm deps inside this agent folder.

const root = process.env.OPENDEV_WORKSPACE_ROOT;
console.log('Agent running against:', root);
`;
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}
class AgentManager {
  runs = /* @__PURE__ */ new Map();
  watcher = null;
  watchedDir = null;
  changeTimer = null;
  builtinsReady = false;
  agentsDir() {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    return join(root, ".opendev", "agents");
  }
  // Built-in agents live app-globally (not per-workspace) — they ship with
  // OpenDev IDE. We materialize them to disk so run() treats them exactly
  // like user agents. Re-materialized once per launch to pick up updates.
  builtinDir() {
    return join(app.getPath("appData"), "openDev", "builtin-agents");
  }
  async ensureBuiltins() {
    if (this.builtinsReady) return;
    for (const a of BUILTIN_AGENTS) {
      const dir = join(this.builtinDir(), a.manifest.slug);
      try {
        await promises.mkdir(dir, { recursive: true });
        await promises.writeFile(join(dir, a.manifest.entry), a.source, "utf8");
        await promises.writeFile(join(dir, "agent.json"), JSON.stringify(a.manifest, null, 2), "utf8");
      } catch (err2) {
        console.error(`[agents] failed to materialize built-in ${a.manifest.slug}`, err2);
      }
    }
    this.builtinsReady = true;
  }
  builtinInfos() {
    return BUILTIN_AGENTS.map((a) => ({
      ...a.manifest,
      dir: join(this.builtinDir(), a.manifest.slug)
    }));
  }
  // (Re)point a shallow watcher at the current workspace's agents dir. Called
  // from list() so it always tracks the active workspace — same on-demand
  // re-watch philosophy as workspace.ts.
  ensureWatcher(dir) {
    if (this.watchedDir === dir && this.watcher) return;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
      }
      this.watcher = null;
    }
    this.watchedDir = dir;
    try {
      this.watcher = watch(dir, { persistent: true, recursive: true }, () => {
        if (this.changeTimer) clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => safeSend(IPC.AgentsChanged), 150);
      });
      this.watcher.on("error", () => {
        if (this.watcher) {
          try {
            this.watcher.close();
          } catch {
          }
        }
        this.watcher = null;
        this.watchedDir = null;
      });
    } catch {
      this.watchedDir = null;
    }
  }
  async list() {
    await this.ensureBuiltins();
    const builtins = this.builtinInfos();
    const root = workspace.getRoot();
    if (!root) return builtins;
    const dir = this.agentsDir();
    try {
      await promises.mkdir(dir, { recursive: true });
    } catch {
    }
    this.ensureWatcher(dir);
    let entries;
    try {
      entries = await promises.readdir(dir);
    } catch {
      return builtins;
    }
    const user = [];
    for (const name of entries) {
      const agentDir = join(dir, name);
      try {
        const stat = await promises.stat(agentDir);
        if (!stat.isDirectory()) continue;
        const raw = await promises.readFile(join(agentDir, "agent.json"), "utf8");
        const m = JSON.parse(raw);
        if (!m.slug || !m.entry) continue;
        user.push({ ...m, dir: agentDir });
      } catch {
      }
    }
    user.sort((a, b) => b.createdAt - a.createdAt);
    return [...builtins, ...user];
  }
  async uniqueSlug(base) {
    const dir = this.agentsDir();
    let slug = slugify(base);
    let n = 2;
    while (true) {
      try {
        await promises.access(join(dir, slug));
        slug = `${slugify(base)}-${n++}`;
      } catch {
        return slug;
      }
    }
  }
  async create(args) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    const slug = await this.uniqueSlug(args.name || "agent");
    const agentDir = join(this.agentsDir(), slug);
    await promises.mkdir(agentDir, { recursive: true });
    await promises.writeFile(join(agentDir, "index.js"), STARTER_INDEX, "utf8");
    const manifest2 = {
      slug,
      name: args.name || slug,
      description: args.description || "",
      entry: "index.js",
      runtime: "node",
      createdBy: "ai",
      createdAt: Date.now()
    };
    await promises.writeFile(join(agentDir, "agent.json"), JSON.stringify(manifest2, null, 2), "utf8");
    safeSend(IPC.AgentsChanged);
    return { ...manifest2, dir: agentDir };
  }
  // Detect the entry file inside an imported folder: package.json `main`,
  // else the first conventional entry name.
  async detectEntry(folder) {
    try {
      const pkg = JSON.parse(await promises.readFile(join(folder, "package.json"), "utf8"));
      if (typeof pkg.main === "string" && pkg.main) {
        if (await this.exists(join(folder, pkg.main))) return pkg.main;
      }
    } catch {
    }
    for (const cand of ["index.ts", "index.js", "index.mjs", "main.ts", "main.js", "main.mjs"]) {
      if (await this.exists(join(folder, cand))) return cand;
    }
    throw new Error("Could not find an entry file (index.js / index.ts / package.json main) in the imported folder");
  }
  async exists(p) {
    try {
      await promises.access(p);
      return true;
    } catch {
      return false;
    }
  }
  async importFrom(srcPath) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    const stat = await promises.stat(srcPath);
    const base = basename(srcPath).replace(/\.(ts|js|mjs)$/i, "");
    const slug = await this.uniqueSlug(base);
    const agentDir = join(this.agentsDir(), slug);
    await promises.mkdir(agentDir, { recursive: true });
    let entry;
    if (stat.isFile()) {
      entry = basename(srcPath);
      await promises.copyFile(srcPath, join(agentDir, entry));
    } else {
      await promises.cp(srcPath, agentDir, { recursive: true });
      entry = await this.detectEntry(agentDir);
    }
    const runtime = extname(entry).toLowerCase() === ".ts" ? "tsx" : "node";
    const manifest2 = {
      slug,
      name: base,
      description: `Imported from ${srcPath}`,
      entry,
      runtime,
      createdBy: "import",
      createdAt: Date.now()
    };
    await promises.writeFile(join(agentDir, "agent.json"), JSON.stringify(manifest2, null, 2), "utf8");
    safeSend(IPC.AgentsChanged);
    return { ...manifest2, dir: agentDir };
  }
  async delete(slug) {
    if (BUILTIN_SLUGS.has(slug)) {
      throw new Error("Built-in agents cannot be deleted.");
    }
    for (const [runId, r] of this.runs) {
      if (r.run.agentSlug === slug) await this.stop(runId);
    }
    const agentDir = join(this.agentsDir(), slug);
    await promises.rm(agentDir, { recursive: true, force: true });
    safeSend(IPC.AgentsChanged);
    return true;
  }
  async loadManifest(slug) {
    const dir = BUILTIN_SLUGS.has(slug) ? join(this.builtinDir(), slug) : join(this.agentsDir(), slug);
    const raw = await promises.readFile(join(dir, "agent.json"), "utf8");
    return { manifest: JSON.parse(raw), dir };
  }
  // Resolve the interpreter + env for an agent. node => the node binary (or
  // the bundled Electron-as-node fallback); tsx => the tsx binary, which the
  // user must have installed. Shared by run() and runAndCollect().
  resolveAgentCommand(manifest2, dir, entryAbs, root) {
    const env = {
      ...process.env,
      OPENDEV_WORKSPACE_ROOT: root,
      OPENDEV_AGENT_DIR: dir,
      FORCE_COLOR: "1"
    };
    if (manifest2.runtime === "tsx") {
      const tsx = resolveBinPath("tsx");
      if (!tsx) {
        throw new Error("This agent is TypeScript and needs tsx. Install it with: npm i -g tsx");
      }
      return { cmd: tsx, args: [entryAbs], env };
    }
    const node = resolveBinPath("node");
    if (node) return { cmd: node, args: [entryAbs], env };
    return { cmd: process.execPath, args: [entryAbs], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  // Run an agent and resolve with its full output once it exits. Used by the
  // MCP `ide_run_agent` tool so the main AI can invoke an agent and read the
  // result synchronously (no IPC streaming, no center tab).
  async runAndCollect(slug, opts = {}) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    await this.ensureBuiltins();
    const { manifest: manifest2, dir } = await this.loadManifest(slug);
    const entryAbs = join(dir, manifest2.entry);
    if (!await this.exists(entryAbs)) {
      throw new Error(`Agent entry not found: ${manifest2.entry}`);
    }
    const { cmd, args, env } = this.resolveAgentCommand(manifest2, dir, entryAbs, root);
    const timeoutMs = Math.min(Math.max(1e3, opts.timeoutMs ?? 12e4), 6e5);
    const cap = 2 * 1024 * 1024;
    return new Promise((resolveP) => {
      const proc = spawnBin(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env });
      let output = "";
      let timedOut = false;
      const onData = (b) => {
        if (output.length < cap) output += b.toString("utf8");
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      const t = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
        }
      }, timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(t);
        resolveP({ output: output.slice(0, cap), exitCode: code, timedOut });
      });
      proc.on("error", (e) => {
        clearTimeout(t);
        resolveP({ output: output + `
[spawn error] ${e.message}`, exitCode: -1, timedOut });
      });
    });
  }
  async run(slug, target = "local") {
    if (target !== "local") {
      const { dispatchAgentRun: dispatchAgentRun2 } = await Promise.resolve().then(() => peers);
      return dispatchAgentRun2(slug, target);
    }
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    await this.ensureBuiltins();
    const { manifest: manifest2, dir } = await this.loadManifest(slug);
    const entryAbs = join(dir, manifest2.entry);
    if (!await this.exists(entryAbs)) {
      throw new Error(`Agent entry not found: ${manifest2.entry}`);
    }
    const { cmd, args, env } = this.resolveAgentCommand(manifest2, dir, entryAbs, root);
    const runId = `ar-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const streamId = runId;
    const proc = spawnBin(cmd, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    const run = {
      runId,
      agentSlug: slug,
      streamId,
      status: "running",
      startedAt: Date.now(),
      target: "local"
    };
    const log = [];
    this.runs.set(runId, { proc, run, log });
    const pushLog = (chunk) => {
      try {
        const s = chunk.toString("utf8");
        log.push(s);
        while (log.length > LOG_TAIL$1) log.shift();
        safeSend(IPC.AgentStream, { streamId, chunk: s });
      } catch {
      }
    };
    proc.stdout?.on("data", pushLog);
    proc.stderr?.on("data", pushLog);
    proc.on("exit", (code, signal) => {
      try {
        const r = this.runs.get(runId);
        if (!r) return;
        const status2 = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
        r.run.status = status2;
        r.run.exitCode = code ?? void 0;
        safeSend(IPC.AgentStream, { streamId, done: true, status: status2, exitCode: code ?? void 0 });
      } catch {
      }
    });
    proc.on("error", (err2) => {
      try {
        const r = this.runs.get(runId);
        if (!r) return;
        r.run.status = "error";
        const msg = `
[agent spawn error] ${err2.message}
`;
        log.push(msg);
        safeSend(IPC.AgentStream, { streamId, chunk: msg });
        safeSend(IPC.AgentStream, { streamId, done: true, status: "error" });
      } catch {
      }
    });
    return run;
  }
  async stop(runId) {
    const r = this.runs.get(runId);
    if (!r) {
      const { stopRemoteRun: stopRemoteRun2 } = await Promise.resolve().then(() => peers);
      return stopRemoteRun2(runId);
    }
    const pid = r.proc.pid;
    const killGroup = (sig) => {
      try {
        if (pid) process.kill(-pid, sig);
      } catch {
        try {
          r.proc.kill(sig);
        } catch {
        }
      }
    };
    if (r.proc.exitCode == null) killGroup("SIGTERM");
    await new Promise((resolve2) => {
      if (r.proc.exitCode != null) return resolve2();
      const t = setTimeout(() => {
        killGroup("SIGKILL");
        resolve2();
      }, 4e3);
      r.proc.once("exit", () => {
        clearTimeout(t);
        resolve2();
      });
    });
    return true;
  }
}
const agentManager = new AgentManager();
function registerAgentsIpc() {
  ipcMain.handle(IPC.AgentsList, () => agentManager.list());
  ipcMain.handle(IPC.AgentsCreate, (_e, a) => agentManager.create(a));
  ipcMain.handle(IPC.AgentsImport, (_e, p) => agentManager.importFrom(p));
  ipcMain.handle(IPC.AgentsImportPick, async () => {
    const r = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return agentManager.importFrom(r.filePaths[0]);
  });
  ipcMain.handle(IPC.AgentsRun, (_e, args) => agentManager.run(args.slug, args.target ?? "local"));
  ipcMain.handle(IPC.AgentsStop, (_e, runId) => agentManager.stop(runId));
  ipcMain.handle(IPC.AgentsDelete, (_e, slug) => agentManager.delete(slug));
}
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SEND_TIMEOUT_MS = 6e4;
function collectionPath() {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  return join(root, ".opendev", "rest-collection.json");
}
async function readCollection() {
  if (!workspace.getRoot()) return [];
  try {
    const raw = await promises.readFile(collectionPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.requests ?? [];
  } catch {
    return [];
  }
}
async function writeCollection(requests) {
  const root = workspace.getRoot();
  if (!root) return;
  await promises.mkdir(join(root, ".opendev"), { recursive: true });
  await promises.writeFile(collectionPath(), JSON.stringify({ requests }, null, 2), "utf8");
}
function buildUrl(baseUrl, params) {
  const enabled = params.filter((p) => (p.enabled ?? true) && p.key);
  if (enabled.length === 0) return baseUrl;
  const sep2 = baseUrl.includes("?") ? "&" : "?";
  const qs = enabled.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join("&");
  return baseUrl + sep2 + qs;
}
function buildHeaders(spec) {
  const out = {};
  for (const h of spec.headers) {
    if ((h.enabled ?? true) && h.key) out[h.key] = h.value;
  }
  if (spec.auth.kind === "bearer" && spec.auth.token) {
    out["Authorization"] = `Bearer ${spec.auth.token}`;
  } else if (spec.auth.kind === "basic" && (spec.auth.username || spec.auth.password)) {
    const enc = Buffer.from(`${spec.auth.username}:${spec.auth.password}`, "utf8").toString("base64");
    out["Authorization"] = `Basic ${enc}`;
  }
  const hasCT = Object.keys(out).some((k) => k.toLowerCase() === "content-type");
  if (!hasCT) {
    if (spec.body.kind === "json") out["Content-Type"] = "application/json";
    else if (spec.body.kind === "text" && spec.body.contentType) out["Content-Type"] = spec.body.contentType;
    else if (spec.body.kind === "form") out["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return out;
}
function buildBody(spec) {
  if (spec.method === "GET" || spec.method === "HEAD") return void 0;
  if (spec.body.kind === "none") return void 0;
  if (spec.body.kind === "json" || spec.body.kind === "text") return spec.body.text;
  if (spec.body.kind === "form") {
    const enabled = spec.body.fields.filter((f) => (f.enabled ?? true) && f.key);
    return enabled.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join("&");
  }
  return void 0;
}
async function send(spec) {
  if (!spec.url || !spec.url.trim()) return { error: "URL is required" };
  let url;
  try {
    url = buildUrl(spec.url.trim(), spec.params);
    new URL(url);
  } catch (e) {
    return { error: `Invalid URL: ${e?.message || String(e)}` };
  }
  const headers = buildHeaders(spec);
  const body = buildBody(spec);
  const controller = new AbortController();
  const timer2 = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: spec.method,
      headers,
      body,
      signal: controller.signal,
      // Don't follow redirects silently for HEAD/OPTIONS so the user sees what
      // the server actually returned. fetch's default ('follow') is fine for
      // the common case — leave it alone.
      redirect: "follow"
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_RESPONSE_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf;
    const text = slice.toString("utf8") + (truncated ? `

[…truncated at ${MAX_RESPONSE_BYTES} bytes]` : "");
    const outHeaders = [];
    res.headers.forEach((v, k) => outHeaders.push([k, v]));
    const ct = res.headers.get("content-type") || void 0;
    const response = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
      body: text,
      contentType: ct,
      durationMs: Date.now() - startedAt,
      sizeBytes: buf.length,
      url
    };
    return response;
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { error: aborted ? `Timed out after ${SEND_TIMEOUT_MS / 1e3}s` : e?.message || String(e) };
  } finally {
    clearTimeout(timer2);
  }
}
async function saveRequest(req) {
  const list = await readCollection();
  const idx = list.findIndex((r) => r.id === req.id);
  const next = { ...req, updatedAt: Date.now() };
  if (idx >= 0) list[idx] = next;
  else list.unshift(next);
  await writeCollection(list);
  return list;
}
async function deleteRequest(id) {
  const list = (await readCollection()).filter((r) => r.id !== id);
  await writeCollection(list);
  return list;
}
function registerRestIpc() {
  ipcMain.handle(IPC.RestSend, async (_e, spec) => send(spec));
  ipcMain.handle(IPC.RestListSaved, async () => readCollection());
  ipcMain.handle(IPC.RestSave, async (_e, req) => saveRequest(req));
  ipcMain.handle(IPC.RestDelete, async (_e, id) => deleteRequest(id));
}
const restApi = { send, readCollection, saveRequest, deleteRequest };
async function pickFreePort$1() {
  return new Promise((resolve2, reject) => {
    const server2 = createServer();
    server2.unref();
    server2.on("error", reject);
    server2.listen(0, "127.0.0.1", () => {
      const addr = server2.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server2.close(() => resolve2(port));
    });
  });
}
class MlxServerManager {
  proc = null;
  status = { running: false };
  getStatus() {
    return { ...this.status };
  }
  broadcast() {
    safeSend(IPC.LlmMlxStatusChanged, this.getStatus());
  }
  async start(opts) {
    if (this.proc && this.proc.exitCode == null) {
      if (this.status.model === opts.model && (this.status.adapter || null) === (opts.adapter || null)) {
        return this.getStatus();
      }
      await this.stop();
    }
    const interpreter = await this.resolveInterpreter(opts.interpreter);
    const port = opts.port ?? await pickFreePort$1();
    const args = ["-m", "mlx_lm.server", "--model", opts.model, "--port", String(port), "--host", "127.0.0.1"];
    if (opts.adapter) args.push("--adapter-path", opts.adapter);
    safeSend(IPC.LlmMlxLog, `[opendev] $ ${interpreter} ${args.join(" ")}
`);
    const proc = spawn(interpreter, args, {
      cwd: workspace.getRoot() || process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    this.proc = proc;
    this.status = {
      running: true,
      pid: proc.pid,
      port,
      model: opts.model,
      adapter: opts.adapter || null,
      startedAt: Date.now()
    };
    this.broadcast();
    let stderrTail = "";
    proc.stdout?.on("data", (b) => safeSend(IPC.LlmMlxLog, b.toString("utf8")));
    proc.stderr?.on("data", (b) => {
      const s = b.toString("utf8");
      stderrTail = (stderrTail + s).slice(-2e3);
      safeSend(IPC.LlmMlxLog, s);
    });
    proc.on("exit", (code, signal) => {
      this.proc = null;
      const cleanExit = code === 0 || signal === "SIGTERM";
      this.status = {
        ...this.status,
        running: false,
        pid: void 0,
        lastError: cleanExit ? void 0 : /No module named ['"]mlx_lm['"]/i.test(stderrTail) || /No module named ['"]mlx['"]/i.test(stderrTail) ? "mlx_lm is not installed in this interpreter. Open Packages and install: mlx-lm" : signal ? `signal ${signal}` : `exit code ${code}`
      };
      this.broadcast();
    });
    proc.on("error", (err2) => {
      this.status = { ...this.status, running: false, lastError: err2.message };
      this.broadcast();
    });
    return this.getStatus();
  }
  async stop() {
    const p = this.proc;
    if (!p || p.exitCode != null) {
      this.status = { ...this.status, running: false };
      this.broadcast();
      return;
    }
    const pid = p.pid;
    try {
      if (pid) process.kill(-pid, "SIGTERM");
    } catch {
      try {
        p.kill("SIGTERM");
      } catch {
      }
    }
    await new Promise((res) => {
      if (p.exitCode != null) return res();
      const t = setTimeout(() => {
        try {
          if (pid) process.kill(-pid, "SIGKILL");
        } catch {
        }
        res();
      }, 3e3);
      p.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
    this.proc = null;
  }
  async resolveInterpreter(override) {
    if (override) return override;
    try {
      const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
      const sel = await getSelectedInterpreter2();
      if (sel) return sel.path;
    } catch {
    }
    return "python3";
  }
}
const mlxServer = new MlxServerManager();
onShutdown(() => mlxServer.stop());
function registerLocalModelsIpc() {
  ipcMain.handle(IPC.LlmMlxStart, (_e, opts) => mlxServer.start(opts));
  ipcMain.handle(IPC.LlmMlxStop, () => mlxServer.stop());
  ipcMain.handle(IPC.LlmMlxStatus, () => mlxServer.getStatus());
}
function trimSlash(s) {
  return s.replace(/\/+$/, "");
}
function normalizeBaseUrl(raw) {
  const s = raw.trim();
  if (!s) return s;
  const scheme = /^https?:\/\//i.test(s) ? "" : "http://";
  return trimSlash(scheme + s);
}
async function fetchJson(url, apiKey, timeoutMs = 1e4) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const r = await fetch(url, { headers, signal: controller.signal });
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}
async function listLocalModels(overrideBaseUrl) {
  const settings = await loadSettings();
  const raw = (overrideBaseUrl ?? settings.aiLocalBaseUrl) || "http://localhost:11434/v1";
  const apiKey = settings.aiLocalApiKey?.trim();
  const baseUrl = normalizeBaseUrl(raw);
  const trimmed = baseUrl;
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: `Couldn't make sense of base URL "${raw}". Expected something like http://localhost:11434 or http://192.168.1.50:11434.`, baseUrl: raw };
  }
  const ollamaRoot = trimmed.replace(/\/v1$/, "");
  const tagsUrl = `${ollamaRoot}/api/tags`;
  const attempts = [];
  let ollamaBodyPreview = "";
  try {
    const r = await fetchJson(tagsUrl, apiKey);
    attempts.push({ url: tagsUrl, ok: r.ok, status: r.status });
    console.log(`[aiLocal] probe ${tagsUrl} → status=${r.status} ok=${r.ok}`);
    if (r.ok && r.body) {
      if (Array.isArray(r.body.models)) {
        const models = r.body.models.map((m) => ({
          id: String(m?.name ?? m?.model ?? ""),
          size: typeof m?.size === "number" ? m.size : void 0,
          modifiedAt: m?.modified_at ? String(m.modified_at) : void 0
        })).filter((m) => !!m.id);
        console.log(`[aiLocal] discovered ${models.length} models via ollama at ${tagsUrl}`);
        return { ok: true, models, source: "ollama", baseUrl };
      }
      try {
        ollamaBodyPreview = JSON.stringify(r.body).slice(0, 400);
      } catch {
        ollamaBodyPreview = String(r.body).slice(0, 400);
      }
    }
  } catch (e) {
    const msg = e?.cause?.code || e?.code || e?.message || String(e);
    attempts.push({ url: tagsUrl, error: msg });
    console.warn(`[aiLocal] probe ${tagsUrl} failed: ${msg}`);
  }
  const openAiCandidates = [`${trimmed}/models`];
  if (!/\/v1$/.test(trimmed)) openAiCandidates.push(`${trimmed}/v1/models`);
  for (const url of openAiCandidates) {
    try {
      const r = await fetchJson(url, apiKey);
      attempts.push({ url, ok: r.ok, status: r.status });
      console.log(`[aiLocal] probe ${url} → status=${r.status} ok=${r.ok}`);
      if (r.ok && r.body && Array.isArray(r.body.data)) {
        const models = r.body.data.map((m) => ({ id: String(m?.id ?? "") })).filter((m) => !!m.id);
        if (models.length > 0) {
          console.log(`[aiLocal] discovered ${models.length} models via openai at ${url}`);
          return { ok: true, models, source: "openai", baseUrl };
        }
      }
    } catch (e) {
      const msg = e?.cause?.code || e?.code || e?.message || String(e);
      attempts.push({ url, error: msg });
      console.warn(`[aiLocal] probe ${url} failed: ${msg}`);
    }
  }
  const rootUrl = ollamaRoot;
  let rootAlive = false;
  let rootBodyPreview = "";
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5e3);
    try {
      const r = await fetch(rootUrl, { signal: controller.signal });
      rootAlive = r.ok || r.status === 200;
      const txt = await r.text().catch(() => "");
      rootBodyPreview = txt.slice(0, 200).trim();
    } finally {
      clearTimeout(t);
    }
    console.log(`[aiLocal] root probe ${rootUrl} → alive=${rootAlive} preview="${rootBodyPreview}"`);
  } catch (e) {
    console.warn(`[aiLocal] root probe ${rootUrl} failed: ${e?.message || e}`);
  }
  const errCodes = attempts.map((a) => a.error || "").join(" ");
  const looksLikeNetwork = !rootAlive && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|abort|AbortError|fetch failed/i.test(errCodes);
  const hint = looksLikeNetwork ? `

Server not reachable. Ollama only listens on 127.0.0.1 by default — on the remote machine, restart with OLLAMA_HOST=0.0.0.0:11434 (or set the env var in your launchd / systemd unit) so it accepts LAN connections.` : rootAlive ? `

Server at ${rootUrl} responded ("${rootBodyPreview}") but /api/tags didn't return a recognisable model list. ${ollamaBodyPreview ? `Raw /api/tags body: ${ollamaBodyPreview}` : "Check that the Ollama version on this machine is recent — older versions used a different endpoint."}` : "";
  const detail = attempts.map(
    (a) => a.error ? `  • ${a.url} — ${a.error}` : `  • ${a.url} — HTTP ${a.status}${a.ok ? " (no models in response)" : ""}`
  ).join("\n");
  return {
    ok: false,
    error: `No models discovered at ${baseUrl}.
Tried:
${detail}${hint}`,
    baseUrl
  };
}
function registerAiLocalIpc() {
  ipcMain.handle(IPC.AiLocalListModels, (_e, baseUrl) => listLocalModels(baseUrl));
  ipcMain.handle(IPC.AiLocalPickBinary, async () => {
    const r = await dialog.showOpenDialog({
      title: "Select OpenCode binary",
      properties: ["openFile"],
      buttonLabel: "Use this binary",
      // OpenCode is a Rust binary with no extension on macOS, so don't
      // restrict to extensions — but offer "All Files" explicitly.
      filters: [{ name: "All Files", extensions: ["*"] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
}
const PORT$1 = Number(process.env.OPENDEV_MCP_PORT) || 53825;
const HOST_LOOPBACK = "127.0.0.1";
const HOST_ALL = "0.0.0.0";
let status = { running: false };
let server = null;
let ipcRegistered = false;
let currentAccessKey = null;
function firstLanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net2 of nets[name] || []) {
      if (net2.family === "IPv4" && !net2.internal) return net2.address;
    }
  }
  return null;
}
function generateAccessKey() {
  const n = randomBytes(4).readUInt32BE(0) % 1e6;
  return n.toString().padStart(6, "0");
}
async function ensureAccessKey() {
  const s = await loadSettings();
  if (s.mcpAccessKey && /^\d{6}$/.test(s.mcpAccessKey)) return s.mcpAccessKey;
  const fresh = generateAccessKey();
  await patchSettings({ mcpAccessKey: fresh });
  return fresh;
}
function ok(msg) {
  return { content: [{ type: "text", text: typeof msg === "string" ? msg : JSON.stringify(msg, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}
const TOOLS = [
  { name: "ide_workspace_root", description: "Return the currently open workspace root path.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_list_dir", description: "List entries in a directory of the workspace.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Absolute or workspace-relative path. Defaults to the workspace root." } } } },
  { name: "ide_walk_files", description: "Recursively list every file in the workspace (excluding node_modules, .git, dist, out). Returns up to `limit` paths.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max files to return (default 5000)." } } } },
  { name: "ide_read_file", description: "Read the UTF-8 contents of a file in the workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "ide_write_file", description: "Write UTF-8 contents to a file in the workspace. Creates parent directories if needed.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "ide_grep", description: "Run ripgrep over the workspace and return the matching lines (file:line:col preview).", inputSchema: { type: "object", properties: { query: { type: "string" }, glob: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] } },
  { name: "ide_listening_ports", description: "List local TCP ports currently in LISTEN state (port, pid, command).", inputSchema: { type: "object", properties: {} } },
  { name: "ide_services_list", description: "List the services registered in this workspace.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_services_start", description: "Start a registered service by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_services_stop", description: "Stop a running service by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_services_log", description: "Return the tail of the captured stdout/stderr log for a service.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_run", description: "Spawn a one-shot shell command in the workspace and capture its output. Use for build/test invocations, not long-running processes.", inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string", description: "Optional working directory; defaults to workspace root." }, timeoutMs: { type: "number", description: "Default 60000." } }, required: ["command"] } },
  { name: "ide_git_status", description: "Run git status against a directory (defaults to the workspace root).", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "ide_git_diff", description: "Run git diff against a directory.", inputSchema: { type: "object", properties: { path: { type: "string" }, file: { type: "string", description: "Optional path to diff one file." } } } },
  { name: "ide_editor_state", description: "Return the renderer-side editor state: active tab, all open tabs, optional selected text. May be stale by up to a few hundred milliseconds.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_open_file", description: "Open a file in the editor (creating a tab) and optionally place the cursor at a position.", inputSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, col: { type: "number" } }, required: ["path"] } },
  { name: "ide_list_agents", description: "List the AI agents available in this workspace — built-in agents (security-scan, code-quality, todo-collector, design-gallery) plus any the user created or imported. Returns each agent's slug, name, description, and runtime.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_run_agent", description: "Run an AI agent by slug against the current workspace and return its full output once it finishes. Agents are self-contained Node.js apps; output is plain text or a complete HTML document. Use ide_list_agents first to see available slugs.", inputSchema: { type: "object", properties: { slug: { type: "string", description: "The agent slug from ide_list_agents." }, timeoutMs: { type: "number", description: "Max run time in ms (default 120000, max 600000)." } }, required: ["slug"] } },
  // REST client — let the AI hit any HTTP endpoint and manage the user's saved-request collection.
  { name: "ide_rest_send", description: "Send an arbitrary HTTP request from the IDE's REST client. Returns status, headers, and body. Supports JSON / raw / form bodies and bearer/basic auth.", inputSchema: { type: "object", properties: {
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
    url: { type: "string" },
    headers: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, enabled: { type: "boolean" } }, required: ["key", "value"] } },
    params: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, enabled: { type: "boolean" } }, required: ["key", "value"] } },
    body: { type: "object", description: 'One of {kind:"none"} | {kind:"json", text:string} | {kind:"text", text:string, contentType?:string} | {kind:"form", fields:[{key,value,enabled?}]}.' },
    auth: { type: "object", description: 'One of {kind:"none"} | {kind:"bearer", token} | {kind:"basic", username, password}.' }
  }, required: ["method", "url"] } },
  { name: "ide_rest_list_saved", description: "List the saved REST requests in this workspace (the right-panel REST collection).", inputSchema: { type: "object", properties: {} } },
  { name: "ide_rest_get_saved", description: "Return one saved REST request by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_rest_save", description: "Save (create or update) a REST request to the workspace collection. Pass an existing id to update, or omit it to create a fresh entry — a new id will be assigned and returned.", inputSchema: { type: "object", properties: {
    id: { type: "string", description: "Existing saved-request id, or omit to create new." },
    name: { type: "string" },
    folder: { type: "string" },
    method: { type: "string" },
    url: { type: "string" },
    headers: { type: "array" },
    params: { type: "array" },
    body: { type: "object" },
    auth: { type: "object" }
  }, required: ["name", "method", "url"] } },
  { name: "ide_rest_delete", description: "Delete a saved REST request by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_rest_open_saved", description: "Open a saved REST request in the center workspace, optionally sending it immediately. Use with id from ide_rest_list_saved.", inputSchema: { type: "object", properties: { id: { type: "string" }, send: { type: "boolean", description: "If true, fire the request as soon as it loads." } }, required: ["id"] } },
  // IDE panel control — the right column hosts AI/DB/ES/REST/ML/LLM; the bottom application bar hosts LOG/DEBUG. The AI can drive both.
  { name: "ide_set_right_tab", description: 'Switch the right-panel tab. Valid values: "ai", "db", "es", "rest", "ml", "llm".', inputSchema: { type: "object", properties: { tab: { type: "string", enum: ["ai", "db", "es", "rest", "ml", "llm"] } }, required: ["tab"] } },
  { name: "ide_get_right_tab", description: "Return which right-panel tab is currently selected.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_set_bottom_tab", description: 'Switch the bottom application-bar tab. Valid values: "log", "debug". Expands the bar if collapsed.', inputSchema: { type: "object", properties: { tab: { type: "string", enum: ["log", "debug"] } }, required: ["tab"] } },
  { name: "ide_get_bottom_tab", description: "Return which bottom-bar tab is currently selected and whether the bar is collapsed.", inputSchema: { type: "object", properties: {} } },
  // Filesystem mutations beyond ide_write_file (which only writes whole files).
  { name: "ide_mkdir", description: "Create a directory in the workspace (mkdir -p). No-op if it already exists.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "ide_copy", description: "Copy a file or directory tree to a new location inside the workspace. Recursive for directories. Errors if the destination exists.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, overwrite: { type: "boolean", description: "Allow overwriting an existing destination (default false)." } }, required: ["from", "to"] } },
  { name: "ide_move", description: "Move/rename a file or directory inside the workspace.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  { name: "ide_delete", description: "Delete a file or directory inside the workspace (recursive for directories).", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  // File-tree control (the left sidebar). Lets the AI reveal a path, expand
  // or collapse folders, and read the current expansion set.
  { name: "ide_reveal_in_tree", description: "Expand every ancestor folder of the given path in the left file tree and scroll it into view. Optionally select it.", inputSchema: { type: "object", properties: { path: { type: "string" }, select: { type: "boolean", description: "Also select the revealed row (default true)." } }, required: ["path"] } },
  { name: "ide_expand_tree", description: "Expand a folder in the left file tree. With recursive=true, also expand every directory beneath it.", inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"] } },
  { name: "ide_collapse_tree", description: "Collapse a folder (and everything beneath it) in the left file tree. Pass {all:true} to collapse the whole tree back to the workspace root.", inputSchema: { type: "object", properties: { path: { type: "string" }, all: { type: "boolean" } } } },
  { name: "ide_focus_tree", description: "Move keyboard focus to the left file tree.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_tree_state", description: "Return which folders are currently expanded and which row(s) are selected in the left file tree.", inputSchema: { type: "object", properties: {} } },
  // SQL / database connections. The IDE owns the connection pools; the AI
  // talks to them by profile id (use ide_db_list_connections to discover ids).
  { name: "ide_db_list_connections", description: "List all saved DB connection profiles in this workspace (SQL + Elasticsearch). Returns id, name, driver, host, port, database.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_db_connect", description: "Open (or refresh) the connection pool for a saved profile by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_db_disconnect", description: "Close the connection pool for a saved profile.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_db_list_databases", description: "List the databases reachable through the given connection (MySQL/Postgres) or the cluster name (ES).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_db_switch_database", description: "Switch the active database for a SQL connection. Closes and re-opens the pool.", inputSchema: { type: "object", properties: { id: { type: "string" }, database: { type: "string" } }, required: ["id", "database"] } },
  { name: "ide_db_schema", description: "Return the schema (tables + columns) visible through a SQL connection.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "ide_db_query", description: "Run a SQL statement against a connection and return its result. Read-only profiles refuse DML/DDL.", inputSchema: { type: "object", properties: { id: { type: "string" }, sql: { type: "string" } }, required: ["id", "sql"] } },
  // Elasticsearch. Send a raw request via a saved ES connection profile.
  { name: "ide_es_request", description: "Send a request to Elasticsearch through a saved ES profile. Returns { status, body, durationMs }.", inputSchema: { type: "object", properties: {
    id: { type: "string", description: "ES connection profile id." },
    method: { type: "string", description: "HTTP method, default GET." },
    path: { type: "string", description: "ES path, e.g. /_cat/indices?format=json, /my-index/_search. Defaults to /_search." },
    body: { description: "JSON body for the request (omit for GET)." }
  }, required: ["id"] } },
  // Local LLM server (MLX) — the right-panel LLM tab.
  { name: "ide_llm_status", description: "Return the current local-LLM server status: running, model, adapter, port, pid, recent log tail.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_llm_start", description: "Start the local MLX-LM server with a model (and optional LoRA adapter). Replaces any running instance.", inputSchema: { type: "object", properties: { model: { type: "string" }, adapter: { type: "string", description: "Optional LoRA adapter path." }, port: { type: "number" } }, required: ["model"] } },
  { name: "ide_llm_stop", description: "Stop the running local MLX-LM server, if any.", inputSchema: { type: "object", properties: {} } },
  { name: "ide_llm_list_models", description: "List the models the configured local LLM endpoint (Ollama / OpenAI-compatible) reports. Pass baseUrl to override the saved setting.", inputSchema: { type: "object", properties: { baseUrl: { type: "string" } } } }
];
function resolveWorkspacePath(p) {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open in the IDE.");
  if (!p) return root;
  return isAbsolute(p) ? p : resolve(root, p);
}
let editorSnapshot = null;
ipcMain.handle("mcp:editor-snapshot", (_e, snap) => {
  editorSnapshot = snap;
  return true;
});
ipcMain.handle("mcp:subscribe-commands", () => true);
function dispatchToRenderer(cmd) {
  Promise.resolve().then(() => safeSend$1).then(({ safeSend: safeSend2 }) => safeSend2("mcp:command", cmd));
}
async function runShell(command, cwd, timeoutMs) {
  return await new Promise((resolveP) => {
    const proc = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const cap = LIMITS.subprocessBytes;
    const enforceCap = () => {
      if (truncated) return;
      if (stdout.length + stderr.length > cap) {
        truncated = true;
        try {
          proc.kill("SIGTERM");
        } catch {
        }
      }
    };
    const t = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
      }
    }, timeoutMs);
    proc.stdout.on("data", (b) => {
      if (truncated) return;
      stdout += b.toString("utf8");
      enforceCap();
    });
    proc.stderr.on("data", (b) => {
      if (truncated) return;
      stderr += b.toString("utf8");
      enforceCap();
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      const tag = truncated ? `
[output truncated — exceeded ${cap} bytes]` : "";
      resolveP({ stdout: stdout + tag, stderr, exitCode: code, timedOut, truncated });
    });
    proc.on("error", (e) => {
      clearTimeout(t);
      resolveP({ stdout, stderr: stderr + e.message, exitCode: -1, timedOut, truncated });
    });
  });
}
async function callTool(name, args) {
  try {
    switch (name) {
      case "ide_workspace_root":
        return ok(workspace.getRoot() ?? "(no workspace open)");
      case "ide_list_dir": {
        const target = resolveWorkspacePath(args?.path);
        const items = await listDir(target);
        return ok(items.map((n) => `${n.isDir ? "d" : "f"} ${n.path}`).join("\n"));
      }
      case "ide_walk_files": {
        const root = workspace.getRoot();
        if (!root) throw new Error("No workspace open");
        const limit = Math.min(Math.max(1, Number(args?.limit) || 5e3), 5e4);
        const files = await walkAllFiles(root, limit);
        return ok(files.join("\n"));
      }
      case "ide_read_file": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        const st = await promises.stat(p);
        if (st.size > LIMITS.fileReadBytes) {
          const mb = (st.size / (1024 * 1024)).toFixed(1);
          const capMb = (LIMITS.fileReadBytes / (1024 * 1024)).toFixed(0);
          throw new Error(`File too large to read (${mb} MB; cap is ${capMb} MB): ${p}`);
        }
        const text = await promises.readFile(p, "utf8");
        return ok(text);
      }
      case "ide_write_file": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        const content = String(args?.content ?? "");
        await promises.mkdir(join(p, ".."), { recursive: true });
        await promises.writeFile(p, content, "utf8");
        return ok(`wrote ${content.length} bytes to ${p}`);
      }
      case "ide_grep": {
        const root = workspace.getRoot();
        if (!root) throw new Error("No workspace open");
        const query = String(args?.query ?? "");
        if (!query) throw new Error("query required");
        const cli = [
          rgPath,
          "--json",
          "--max-count",
          "500",
          ...args?.caseSensitive ? [] : ["-i"],
          ...args?.glob ? ["-g", String(args.glob)] : [],
          "--",
          query
        ];
        const result = await runShell(cli.map((s) => `'${String(s).replace(/'/g, `'\\''`)}'`).join(" "), root, 3e4);
        const hits = [];
        for (const line of result.stdout.split("\n")) {
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === "match") {
              const p = j.data.path?.text ?? "";
              const ln = j.data.line_number ?? 0;
              const txt = (j.data.lines?.text ?? "").replace(/\n$/, "");
              hits.push(`${p}:${ln}: ${txt}`);
            }
          } catch {
          }
        }
        return ok(hits.join("\n") || "(no matches)");
      }
      case "ide_listening_ports": {
        const ports = await listListeningPorts();
        return ok(ports.map((p) => `${p.port} ${p.protocol} pid=${p.pid} ${p.command}`).join("\n") || "(none)");
      }
      case "ide_services_list": {
        const list = await serviceManager.list();
        const statuses = serviceManager.allStatuses();
        const byId = new Map(statuses.map((r) => [r.id, r]));
        return ok(list.map((s) => ({
          id: s.id,
          name: s.name,
          command: s.command,
          cwd: s.cwd,
          status: byId.get(s.id)?.status ?? "stopped",
          pid: byId.get(s.id)?.pid
        })));
      }
      case "ide_services_start": {
        const id = String(args?.id ?? "");
        if (!id) throw new Error("id required");
        const r = await serviceManager.start(id);
        return ok(r);
      }
      case "ide_services_stop": {
        const id = String(args?.id ?? "");
        if (!id) throw new Error("id required");
        await serviceManager.stop(id);
        return ok(`stopped ${id}`);
      }
      case "ide_services_log": {
        const id = String(args?.id ?? "");
        if (!id) throw new Error("id required");
        const log = serviceManager.log(id);
        return ok(log || "(empty)");
      }
      case "ide_run": {
        const root = workspace.getRoot();
        if (!root) throw new Error("No workspace open");
        const cmd = String(args?.command ?? "");
        if (!cmd) throw new Error("command required");
        const cwd = args?.cwd ? resolveWorkspacePath(args.cwd) : root;
        const timeoutMs = Math.min(Math.max(1e3, Number(args?.timeoutMs) || 6e4), 3e5);
        const r = await runShell(cmd, cwd, timeoutMs);
        return ok(`exit=${r.exitCode}${r.timedOut ? " (TIMEOUT)" : ""}
--- stdout ---
${r.stdout}
--- stderr ---
${r.stderr}`);
      }
      case "ide_git_status": {
        const p = resolveWorkspacePath(args?.path);
        const g = simpleGit(p);
        const r = await g.status();
        return ok(r);
      }
      case "ide_git_diff": {
        const p = resolveWorkspacePath(args?.path);
        const g = simpleGit(p);
        const r = args?.file ? await g.diff(["--", String(args.file)]) : await g.diff();
        return ok(r);
      }
      case "ide_editor_state":
        return ok(editorSnapshot ?? "(not yet captured — open a file first)");
      case "ide_open_file": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        dispatchToRenderer({ kind: "open-file", path: p, line: args?.line, col: args?.col });
        return ok(`opening ${p}`);
      }
      case "ide_list_agents": {
        const agents = await agentManager.list();
        return ok(agents.map((a) => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          runtime: a.runtime,
          builtIn: a.createdBy === "builtin"
        })));
      }
      case "ide_run_agent": {
        const slug = String(args?.slug ?? "");
        if (!slug) throw new Error("slug required");
        const r = await agentManager.runAndCollect(slug, { timeoutMs: Number(args?.timeoutMs) || void 0 });
        const header = `agent=${slug} exit=${r.exitCode}${r.timedOut ? " (TIMEOUT)" : ""}`;
        return ok(`${header}
--- output ---
${r.output || "(no output)"}`);
      }
      case "ide_rest_send": {
        if (!args?.method || !args?.url) throw new Error("method and url required");
        const r = await restApi.send({
          method: args.method,
          url: args.url,
          headers: args.headers ?? [],
          params: args.params ?? [],
          body: args.body ?? { kind: "none" },
          auth: args.auth ?? { kind: "none" }
        });
        return ok(r);
      }
      case "ide_rest_list_saved": {
        const list = await restApi.readCollection();
        return ok(list.map((r) => ({ id: r.id, name: r.name, folder: r.folder, method: r.method, url: r.url })));
      }
      case "ide_rest_get_saved": {
        const id = String(args?.id ?? "");
        if (!id) throw new Error("id required");
        const list = await restApi.readCollection();
        const r = list.find((x) => x.id === id);
        if (!r) return err(`No saved request with id ${id}`);
        return ok(r);
      }
      case "ide_rest_save": {
        if (!args?.name || !args?.method || !args?.url) throw new Error("name, method, and url required");
        const id = String(args.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const record = {
          id,
          name: String(args.name),
          folder: args.folder ? String(args.folder) : void 0,
          method: args.method,
          url: String(args.url),
          headers: args.headers ?? [],
          params: args.params ?? [],
          body: args.body ?? { kind: "none" },
          auth: args.auth ?? { kind: "none" },
          updatedAt: Date.now()
        };
        await restApi.saveRequest(record);
        return ok({ id, saved: record });
      }
      case "ide_rest_delete": {
        const id = String(args?.id ?? "");
        if (!id) throw new Error("id required");
        await restApi.deleteRequest(id);
        return ok(`deleted ${id}`);
      }
      case "ide_rest_open_saved": {
        const id = String(args?.id ?? "");
        if (!id) throw new Error("id required");
        dispatchToRenderer({ kind: "open-rest-saved", savedId: id, send: !!args?.send });
        return ok(`opening saved request ${id}${args?.send ? " (and sending)" : ""}`);
      }
      case "ide_set_right_tab": {
        const tab = String(args?.tab ?? "");
        if (!["ai", "db", "es", "rest", "ml", "llm"].includes(tab)) {
          throw new Error("tab must be one of: ai, db, es, rest, ml, llm");
        }
        dispatchToRenderer({ kind: "set-right-tab", tab });
        return ok(`right-tab set to ${tab}`);
      }
      case "ide_get_right_tab": {
        const snap = editorSnapshot;
        return ok(snap?.rightTab ?? "(unknown — open the IDE)");
      }
      case "ide_set_bottom_tab": {
        const tab = String(args?.tab ?? "");
        if (!["log", "debug"].includes(tab)) {
          throw new Error("tab must be one of: log, debug");
        }
        dispatchToRenderer({ kind: "set-bottom-tab", tab });
        return ok(`bottom-tab set to ${tab}`);
      }
      case "ide_get_bottom_tab": {
        const snap = editorSnapshot;
        return ok({ tab: snap?.bottomTab ?? "(unknown)", collapsed: snap?.bottomCollapsed ?? false });
      }
      case "ide_mkdir": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        await promises.mkdir(p, { recursive: true });
        return ok(`created ${p}`);
      }
      case "ide_copy": {
        if (!args?.from || !args?.to) throw new Error("from and to required");
        const from = resolveWorkspacePath(String(args.from));
        const to = resolveWorkspacePath(String(args.to));
        if (!safeWithinRoot(from) || !safeWithinRoot(to)) throw new Error("Path outside workspace");
        await promises.mkdir(join(to, ".."), { recursive: true });
        await promises.cp(from, to, { recursive: true, force: !!args.overwrite, errorOnExist: !args.overwrite });
        return ok(`copied ${from} → ${to}`);
      }
      case "ide_move": {
        if (!args?.from || !args?.to) throw new Error("from and to required");
        const from = resolveWorkspacePath(String(args.from));
        const to = resolveWorkspacePath(String(args.to));
        if (!safeWithinRoot(from) || !safeWithinRoot(to)) throw new Error("Path outside workspace");
        await promises.mkdir(join(to, ".."), { recursive: true });
        await promises.rename(from, to);
        return ok(`moved ${from} → ${to}`);
      }
      case "ide_delete": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        if (p === workspace.getRoot()) throw new Error("Refusing to delete the workspace root");
        await promises.rm(p, { recursive: true, force: true });
        return ok(`deleted ${p}`);
      }
      case "ide_reveal_in_tree": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        dispatchToRenderer({ kind: "tree-reveal", path: p, select: args?.select !== false });
        return ok(`revealing ${p}`);
      }
      case "ide_expand_tree": {
        const p = resolveWorkspacePath(args?.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        dispatchToRenderer({ kind: "tree-expand", path: p, recursive: !!args?.recursive });
        return ok(`expanding ${p}${args?.recursive ? " (recursive)" : ""}`);
      }
      case "ide_collapse_tree": {
        if (args?.all) {
          dispatchToRenderer({ kind: "tree-collapse", all: true });
          return ok("collapsed all");
        }
        if (!args?.path) throw new Error("path or all=true required");
        const p = resolveWorkspacePath(args.path);
        if (!safeWithinRoot(p)) throw new Error("Path outside workspace");
        dispatchToRenderer({ kind: "tree-collapse", path: p });
        return ok(`collapsed ${p}`);
      }
      case "ide_focus_tree": {
        dispatchToRenderer({ kind: "tree-focus" });
        return ok("focusing file tree");
      }
      case "ide_tree_state": {
        const snap = editorSnapshot;
        return ok({
          expanded: snap?.treeExpanded ?? [],
          selected: snap?.treeSelected ?? []
        });
      }
      case "ide_db_list_connections": {
        const profiles = await dbApi.listProfiles();
        return ok(profiles.map((p) => ({ id: p.id, name: p.name, driver: p.driver, host: p.host, port: p.port, database: p.database, readOnly: p.readOnly })));
      }
      case "ide_db_connect": {
        if (!args?.id) throw new Error("id required");
        await dbApi.connect(String(args.id));
        return ok(`connected ${args.id}`);
      }
      case "ide_db_disconnect": {
        if (!args?.id) throw new Error("id required");
        await dbApi.disconnect(String(args.id));
        return ok(`disconnected ${args.id}`);
      }
      case "ide_db_list_databases": {
        if (!args?.id) throw new Error("id required");
        return ok(await dbApi.listDatabases(String(args.id)));
      }
      case "ide_db_switch_database": {
        if (!args?.id || !args?.database) throw new Error("id and database required");
        await dbApi.switchDatabase(String(args.id), String(args.database));
        return ok(`${args.id} → ${args.database}`);
      }
      case "ide_db_schema": {
        if (!args?.id) throw new Error("id required");
        return ok(await dbApi.schema(String(args.id)));
      }
      case "ide_db_query": {
        if (!args?.id || !args?.sql) throw new Error("id and sql required");
        return ok(await dbApi.query(String(args.id), String(args.sql)));
      }
      case "ide_es_request": {
        if (!args?.id) throw new Error("id required");
        return ok(await dbApi.esRequest(String(args.id), {
          method: args.method ? String(args.method) : void 0,
          path: args.path ? String(args.path) : void 0,
          body: args.body
        }));
      }
      case "ide_llm_status":
        return ok(mlxServer.getStatus());
      case "ide_llm_start": {
        if (!args?.model) throw new Error("model required");
        await mlxServer.start({ model: String(args.model), adapter: args?.adapter ? String(args.adapter) : null, port: typeof args?.port === "number" ? args.port : void 0 });
        return ok(mlxServer.getStatus());
      }
      case "ide_llm_stop":
        await mlxServer.stop();
        return ok(mlxServer.getStatus());
      case "ide_llm_list_models": {
        const r = await listLocalModels(args?.baseUrl ? String(args.baseUrl) : void 0);
        return ok(r);
      }
    }
    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(e?.message || String(e));
  }
}
async function handleJsonRpc(req) {
  const id = req?.id;
  const method = req?.method;
  const params = req?.params ?? {};
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "opendev-ide", version: "0.3.0" }
    } };
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (method === "tools/call") {
    const r = await callTool(params?.name, params?.arguments ?? {});
    return { jsonrpc: "2.0", id, result: r };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}
function registerMcpIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle(IPC.McpStatus, async () => {
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
async function stopIdeMcpServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((res) => s.close(() => res()));
  status = { running: false };
}
async function startIdeMcpServer() {
  registerMcpIpc();
  if (server) return;
  const settings = await loadSettings();
  const exposeOnLan = settings.mcpExposeOnLan === true;
  const HOST2 = exposeOnLan ? HOST_ALL : HOST_LOOPBACK;
  currentAccessKey = await ensureAccessKey();
  server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "opendev-ide", version: "0.3.0", tools: TOOLS.length }));
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    {
      const auth = req.headers["authorization"] || "";
      const expected = currentAccessKey ? `Bearer ${currentAccessKey}` : "";
      if (!expected || auth !== expected) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Bearer realm="opendev-mcp"');
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized — set Authorization: Bearer <opendev MCP access PIN from Settings → AI>" } }));
        return;
      }
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e7) {
        req.destroy();
      }
    });
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: " + e.message } }));
        return;
      }
      try {
        const replies = await (Array.isArray(parsed) ? Promise.all(parsed.map(handleJsonRpc)) : handleJsonRpc(parsed));
        res.setHeader("Content-Type", "application/json");
        if (replies === null || Array.isArray(replies) && replies.every((r) => r == null)) {
          res.statusCode = 202;
          res.end();
          return;
        }
        res.end(JSON.stringify(replies));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e?.message || String(e) } }));
      }
    });
  });
  await new Promise((resolveP, rejectP) => {
    server.once("error", (e) => {
      if (e?.code === "EADDRINUSE") {
        status = { running: false, error: `Port ${PORT$1} already in use — close any other OpenDev IDE instance.` };
        rejectP(e);
      } else rejectP(e);
    });
    server.listen(PORT$1, HOST2, () => resolveP());
  }).catch((e) => {
    console.error("[mcp]", e?.message || e);
  });
  if (server && server.listening) {
    const loopback = `http://${HOST_LOOPBACK}:${PORT$1}/`;
    const lanIp = exposeOnLan ? firstLanIPv4() : null;
    status = {
      running: true,
      url: loopback,
      lanUrl: lanIp ? `http://${lanIp}:${PORT$1}/` : void 0,
      port: PORT$1,
      host: HOST2,
      exposedOnLan: exposeOnLan,
      accessKey: currentAccessKey ?? void 0
    };
    console.log(`[mcp] listening on ${HOST2}:${PORT$1}${exposeOnLan ? ` (LAN: ${status.lanUrl ?? "<no LAN IP>"})` : ""}`);
  }
}
onShutdown(() => {
  if (server) {
    try {
      server.close();
    } catch {
    }
    server = null;
  }
});
function sessionPath() {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  return join(root, ".opendev", "session.json");
}
function registerSessionIpc() {
  ipcMain.handle(IPC.SessionSave, async (_e, state) => {
    const root = workspace.getRoot();
    if (!root) return false;
    try {
      await promises.mkdir(join(root, ".opendev"), { recursive: true });
      await promises.writeFile(sessionPath(), JSON.stringify(state, null, 2), "utf8");
      return true;
    } catch (err2) {
      console.error("[session] save failed", err2?.message || err2);
      return false;
    }
  });
  ipcMain.handle(IPC.SessionLoad, async () => {
    const root = workspace.getRoot();
    if (!root) return null;
    try {
      const raw = await promises.readFile(sessionPath(), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
}
const which = hasBin;
function packageManager() {
  return which("brew") ? "brew" : null;
}
function version(cmd, flag2 = "--version") {
  try {
    const r = execSync(`${cmd} ${flag2}`, { encoding: "utf8", env: process.env, timeout: 2e3 });
    return r.trim().split("\n")[0];
  } catch {
    return void 0;
  }
}
function registerToolsIpc() {
  ipcMain.handle("tools:check", async () => ({
    npm: which("npm"),
    node: which("node"),
    brew: packageManager() !== null,
    git: which("git"),
    npmVersion: which("npm") ? version("npm") : void 0,
    nodeVersion: which("node") ? version("node") : void 0
  }));
  ipcMain.handle("tools:install-node", async () => installTool("node"));
  ipcMain.handle("tools:install", async (_e, tool) => {
    if (tool === "tsx") {
      if (!which("npm")) return { ok: false, error: "npm is not installed — install Node.js first." };
      return runStreamedInstall("npm", ["i", "-g", "tsx"]);
    }
    return installTool(tool);
  });
  ipcMain.handle("tools:cancel-install", () => {
    if (!activeInstallProc) return { ok: false, error: "No active install." };
    try {
      activeInstallProc.kill("SIGTERM");
    } catch {
    }
    return { ok: true };
  });
}
function brewArgsFor(tool) {
  switch (tool) {
    case "node":
      return ["install", "node"];
    case "mvn":
      return ["install", "maven"];
    case "java":
      return ["install", "openjdk@17"];
    case "dotnet":
      return ["install", "dotnet"];
    default:
      return null;
  }
}
async function installTool(tool) {
  const manager = packageManager();
  if (!manager) return { ok: false, error: "Homebrew is not installed. Install it from https://brew.sh first." };
  const argv = brewArgsFor(tool);
  if (!argv) return { ok: false, error: `Don't know how to install "${tool}".` };
  return runStreamedInstall("brew", argv);
}
let activeInstallProc = null;
function runStreamedInstall(cmd, args) {
  return new Promise((resolve2) => {
    safeSend("tools:install-log", `$ ${cmd} ${args.join(" ")}
`);
    const proc = spawnBin(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    activeInstallProc = proc;
    let out = "";
    const append2 = (s) => {
      out = tail(out + s, LIMITS.subprocessBytes);
    };
    proc.stdout?.on("data", (b) => {
      const s = b.toString("utf8");
      append2(s);
      safeSend("tools:install-log", s);
    });
    proc.stderr?.on("data", (b) => {
      const s = b.toString("utf8");
      append2(s);
      safeSend("tools:install-log", s);
    });
    proc.on("error", (e) => {
      activeInstallProc = null;
      resolve2({ ok: false, error: e.message });
    });
    proc.on("exit", (code, signal) => {
      activeInstallProc = null;
      if (signal === "SIGTERM") resolve2({ ok: false, error: "Cancelled." });
      else resolve2({
        ok: code === 0,
        error: code === 0 ? void 0 : `${cmd} exited with code ${code}.`
      });
    });
  });
}
const DISCOVERY_PORT = 53826;
const ANNOUNCE_INTERVAL_MS = 3e3;
const PRUNE_INTERVAL_MS = 4e3;
const PEER_STALE_MS = 1e4;
const AUTH_SKEW_MS = 3e4;
const MAX_AGENT_BUNDLE = 25 * 1024 * 1024;
function bodyHashOf(body) {
  return createHmac("sha256", "opendev-body").update(body).digest("hex");
}
async function packDir(dir) {
  const out = [];
  let total = 0;
  async function walk(cur) {
    const entries = await promises.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const data = await promises.readFile(abs);
        total += data.length;
        if (total > MAX_AGENT_BUNDLE) {
          throw new Error(`Agent folder exceeds ${MAX_AGENT_BUNDLE / 1024 / 1024}MB — too large to dispatch.`);
        }
        out.push({ path: relative(dir, abs).split(sep).join("/"), data: data.toString("base64") });
      }
    }
  }
  await walk(dir);
  return out;
}
async function unpackTo(files, destDir) {
  for (const f of files) {
    const rel2 = f.path.replace(/\\/g, "/");
    if (rel2.startsWith("/") || rel2.split("/").includes("..")) continue;
    const abs = join(destDir, rel2);
    await promises.mkdir(join(abs, ".."), { recursive: true });
    await promises.writeFile(abs, Buffer.from(f.data, "base64"));
  }
}
class PeerManager {
  machineId = "";
  machineName = getMachineName();
  linkKey;
  enabled = false;
  httpServer = null;
  httpPort = 0;
  udp = null;
  announceTimer = null;
  pruneTimer = null;
  peers = /* @__PURE__ */ new Map();
  // runId -> in-flight remote run (the originating side: the streaming
  // response we're relaying to the renderer).
  remoteRuns = /* @__PURE__ */ new Map();
  // runId -> child process spawned for an inbound dispatch (the executing
  // side), so a client disconnect can kill it.
  inboundRuns = /* @__PURE__ */ new Map();
  async init() {
    this.machineId = await getMachineId();
    const s = await loadSettings();
    this.linkKey = s.linkKey;
    this.enabled = !!s.linkingEnabled;
    if (this.enabled && this.linkKey) {
      try {
        await this.startNetworking();
      } catch (err2) {
        console.error("[peers] start failed", err2);
      }
    }
    onShutdown(() => this.stopNetworking());
  }
  hmac(data) {
    if (!this.linkKey) return "";
    return createHmac("sha256", this.linkKey).update(data).digest("hex");
  }
  eq(a, b) {
    if (a.length !== b.length || a.length === 0) return false;
    try {
      return timingSafeEqual$1(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
  status() {
    return {
      machineId: this.machineId,
      machineName: this.machineName,
      linkingEnabled: this.enabled,
      hasLinkKey: !!this.linkKey,
      httpPort: this.httpPort || void 0
    };
  }
  list() {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  getPeer(machineId) {
    return this.peers.get(machineId);
  }
  authHeaders(bodyHash) {
    const ts = Date.now().toString();
    return {
      "X-OpenDev-Machine": this.machineId,
      "X-OpenDev-Ts": ts,
      "X-OpenDev-Auth": this.hmac(`${ts}.${bodyHash}`)
    };
  }
  async setLinkKey(key) {
    this.linkKey = key.trim() || void 0;
    await patchSettings({ linkKey: this.linkKey });
    await this.restartNetworking();
    return true;
  }
  async setEnabled(enabled) {
    this.enabled = enabled;
    await patchSettings({ linkingEnabled: enabled });
    await this.restartNetworking();
    return true;
  }
  async restartNetworking() {
    this.stopNetworking();
    if (this.enabled && this.linkKey) {
      try {
        await this.startNetworking();
      } catch (err2) {
        console.error("[peers] restart failed", err2);
      }
    }
    safeSend(IPC.PeersChanged);
  }
  async startNetworking() {
    this.httpServer = createServer$1((req, res) => {
      void this.handleHttp(req, res);
    });
    await new Promise((resolve2, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(0, "0.0.0.0", () => {
        const addr = this.httpServer.address();
        this.httpPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve2();
      });
    });
    this.udp = createSocket({ type: "udp4", reuseAddr: true });
    this.udp.on("message", (msg, rinfo) => this.handleAnnounce(msg, rinfo.address));
    this.udp.on("error", (err2) => console.error("[peers] udp error", err2.message));
    await new Promise((resolve2) => {
      this.udp.bind(DISCOVERY_PORT, () => {
        try {
          this.udp.setBroadcast(true);
        } catch {
        }
        resolve2();
      });
    });
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.announce();
    console.log(`[peers] linking on — http :${this.httpPort}, discovery udp :${DISCOVERY_PORT}`);
  }
  stopNetworking() {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
      }
      this.udp = null;
    }
    if (this.httpServer) {
      try {
        this.httpServer.close();
      } catch {
      }
      this.httpServer = null;
    }
    for (const proc of this.inboundRuns.values()) {
      try {
        proc.kill("SIGTERM");
      } catch {
      }
    }
    this.inboundRuns.clear();
    this.httpPort = 0;
    if (this.peers.size > 0) {
      this.peers.clear();
      safeSend(IPC.PeersChanged);
    }
  }
  announce() {
    if (!this.udp || !this.linkKey) return;
    const payload = {
      t: "opendev-announce",
      machineId: this.machineId,
      name: this.machineName,
      httpPort: this.httpPort,
      keyHash: this.hmac(this.machineId)
    };
    const buf = Buffer.from(JSON.stringify(payload));
    try {
      this.udp.send(buf, 0, buf.length, DISCOVERY_PORT, "255.255.255.255");
    } catch {
    }
  }
  handleAnnounce(msg, address) {
    let data;
    try {
      data = JSON.parse(msg.toString("utf8"));
    } catch {
      return;
    }
    if (data?.t !== "opendev-announce") return;
    if (typeof data.machineId !== "string" || data.machineId === this.machineId) return;
    if (!this.eq(this.hmac(data.machineId), data.keyHash || "")) return;
    const existed = this.peers.has(data.machineId);
    this.peers.set(data.machineId, {
      machineId: data.machineId,
      name: typeof data.name === "string" ? data.name : data.machineId,
      address,
      httpPort: typeof data.httpPort === "number" ? data.httpPort : 0,
      lastSeen: Date.now(),
      online: true
    });
    if (!existed) safeSend(IPC.PeersChanged);
  }
  prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_STALE_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) safeSend(IPC.PeersChanged);
  }
  verifyRequest(req, bodyHash) {
    const ts = String(req.headers["x-opendev-ts"] || "");
    const auth = String(req.headers["x-opendev-auth"] || "");
    if (!ts || !auth) return false;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > AUTH_SKEW_MS) return false;
    return this.eq(this.hmac(`${ts}.${bodyHash}`), auth);
  }
  // ── HTTP server (the executing side of a link) ───────────────────────
  async handleHttp(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (!this.linkKey || !this.verifyRequest(req, bodyHashOf(body))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = req.url || "/";
    try {
      if (req.method === "POST" && url === "/link/hello") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ machineId: this.machineId, name: this.machineName, httpPort: this.httpPort }));
        return;
      }
      if (req.method === "POST" && url === "/repo/push") {
        await this.handleRepoPush(req, res, body);
        return;
      }
      if (req.method === "POST" && url === "/agent/dispatch") {
        await this.handleAgentDispatch(req, res, body);
        return;
      }
    } catch (err2) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err2.message }));
      } else {
        try {
          res.end();
        } catch {
        }
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
  // Receive a git bundle and clone/update it into our peer-repos area.
  async handleRepoPush(req, res, body) {
    const wsName = String(req.headers["x-opendev-workspace"] || "").trim();
    if (!wsName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing workspace name" }));
      return;
    }
    const bundlePath = join(tmpdir(), `opendev-recv-${randomUUID()}.bundle`);
    await promises.writeFile(bundlePath, body);
    const dest = peerRepoDir(wsName);
    try {
      await applyBundle(bundlePath, dest);
    } finally {
      try {
        await promises.unlink(bundlePath);
      } catch {
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, dir: dest }));
  }
  // Receive a packaged agent, run it against a previously-pushed repo, and
  // stream its stdout/stderr back as the chunked response body.
  async handleAgentDispatch(req, res, body) {
    const payload = JSON.parse(body.toString("utf8"));
    const repoDir = peerRepoDir(payload.workspaceName);
    try {
      await promises.access(repoDir);
    } catch {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `No repo "${payload.workspaceName}" here — push the repo first.` }));
      return;
    }
    const agentDir = join(tmpdir(), `opendev-agent-${payload.runId}`);
    await promises.mkdir(agentDir, { recursive: true });
    await unpackTo(payload.files, agentDir);
    const entryAbs = join(agentDir, payload.manifest.entry);
    let cmd;
    const env = {
      ...process.env,
      OPENDEV_WORKSPACE_ROOT: repoDir,
      OPENDEV_AGENT_DIR: agentDir,
      FORCE_COLOR: "1"
    };
    if (payload.manifest.runtime === "tsx") {
      const tsx = resolveBinPath("tsx");
      if (!tsx) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "This agent needs tsx, which is not installed on the target machine." }));
        return;
      }
      cmd = tsx;
    } else {
      const node = resolveBinPath("node");
      if (node) {
        cmd = node;
      } else {
        cmd = process.execPath;
        env.ELECTRON_RUN_AS_NODE = "1";
      }
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
    const proc = spawnBin(cmd, [entryAbs], { cwd: repoDir, ...detachedSpawnOptions(), stdio: ["ignore", "pipe", "pipe"], env });
    this.inboundRuns.set(payload.runId, proc);
    const onData = (b) => {
      try {
        res.write(b);
      } catch {
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    req.on("close", () => {
      const pid = proc.pid;
      try {
        if (pid) process.kill(-pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
        }
      }
    });
    proc.on("exit", () => {
      this.inboundRuns.delete(payload.runId);
      try {
        res.end();
      } catch {
      }
      promises.rm(agentDir, { recursive: true, force: true }).catch(() => {
      });
    });
    proc.on("error", (err2) => {
      try {
        res.write(`
[agent spawn error] ${err2.message}
`);
        res.end();
      } catch {
      }
      this.inboundRuns.delete(payload.runId);
    });
  }
  // ── HTTP client (the originating side of a link) ─────────────────────
  // POST a buffer to a peer endpoint; resolves with the response stream.
  peerRequest(peer, path, body, extraHeaders = {}) {
    return new Promise((resolve2, reject) => {
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        ...this.authHeaders(bodyHashOf(body)),
        ...extraHeaders
      };
      const r = request(
        { host: peer.address, port: peer.httpPort, path, method: "POST", headers },
        (resp) => resolve2(resp)
      );
      r.on("error", reject);
      r.end(body);
    });
  }
  // Bundle the current workspace and push it to a peer.
  async pushRepo(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("Peer is not online.");
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open.");
    const wsName = baseName(root) || "repo";
    const bundlePath = await bundleRepo(root);
    try {
      const body = await promises.readFile(bundlePath);
      const resp = await this.peerRequest(peer, "/repo/push", body, { "X-OpenDev-Workspace": wsName });
      const text = await readAll(resp);
      if (resp.statusCode !== 200) {
        throw new Error(`Peer rejected the push (${resp.statusCode}): ${text}`);
      }
      return true;
    } finally {
      try {
        await promises.unlink(bundlePath);
      } catch {
      }
    }
  }
  // Package the agent folder and dispatch it to a peer. Returns the AgentRun
  // immediately; output is relayed to the renderer over IPC.AgentStream as
  // the peer's chunked response arrives.
  async dispatchAgentRun(slug, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("Peer is not online.");
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open.");
    const wsName = baseName(root) || "repo";
    const agentDir = join(root, ".opendev", "agents", slug);
    const manifest2 = JSON.parse(await promises.readFile(join(agentDir, "agent.json"), "utf8"));
    const files = await packDir(agentDir);
    const runId = `ar-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const run = {
      runId,
      agentSlug: slug,
      streamId: runId,
      status: "running",
      startedAt: Date.now(),
      target: peerId
    };
    const body = Buffer.from(JSON.stringify({ runId, manifest: manifest2, files, workspaceName: wsName }));
    this.peerRequest(peer, "/agent/dispatch", body).then((resp) => {
      if (resp.statusCode !== 200) {
        readAll(resp).then((t) => {
          safeSend(IPC.AgentStream, { streamId: runId, chunk: `
[dispatch failed] ${t}
` });
          safeSend(IPC.AgentStream, { streamId: runId, done: true, status: "error" });
        });
        return;
      }
      this.remoteRuns.set(runId, { res: resp });
      resp.on("data", (b) => safeSend(IPC.AgentStream, { streamId: runId, chunk: b.toString("utf8") }));
      resp.on("end", () => {
        this.remoteRuns.delete(runId);
        safeSend(IPC.AgentStream, { streamId: runId, done: true, status: "stopped" });
      });
      resp.on("error", () => {
        this.remoteRuns.delete(runId);
        safeSend(IPC.AgentStream, { streamId: runId, done: true, status: "error" });
      });
    }).catch((err2) => {
      safeSend(IPC.AgentStream, { streamId: runId, chunk: `
[dispatch error] ${err2.message}
` });
      safeSend(IPC.AgentStream, { streamId: runId, done: true, status: "error" });
    });
    return run;
  }
  // Stop a remote run by tearing down its streaming response — the peer
  // sees the socket close (req 'close') and kills the child.
  stopRemoteRun(runId) {
    const r = this.remoteRuns.get(runId);
    if (!r) return false;
    try {
      r.res.destroy();
    } catch {
    }
    this.remoteRuns.delete(runId);
    safeSend(IPC.AgentStream, { streamId: runId, done: true, status: "stopped" });
    return true;
  }
}
function readAll(resp) {
  return new Promise((resolve2) => {
    const chunks = [];
    resp.on("data", (c) => chunks.push(c));
    resp.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
    resp.on("error", () => resolve2(Buffer.concat(chunks).toString("utf8")));
  });
}
const peerManager = new PeerManager();
async function dispatchAgentRun(slug, target) {
  return peerManager.dispatchAgentRun(slug, target);
}
function stopRemoteRun(runId) {
  return peerManager.stopRemoteRun(runId);
}
function registerPeersIpc() {
  void peerManager.init();
  ipcMain.handle(IPC.PeersList, () => peerManager.list());
  ipcMain.handle(IPC.PeersStatus, () => peerManager.status());
  ipcMain.handle(IPC.PeersSetLinkKey, (_e, key) => peerManager.setLinkKey(key));
  ipcMain.handle(IPC.PeersSetEnabled, (_e, enabled) => peerManager.setEnabled(enabled));
  ipcMain.handle(IPC.PeersPushRepo, (_e, peerId) => peerManager.pushRepo(peerId));
}
const peers = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  dispatchAgentRun,
  peerManager,
  registerPeersIpc,
  stopRemoteRun
}, Symbol.toStringTag, { value: "Module" }));
class NodeDebugSession {
  constructor(file, emit) {
    this.file = file;
    this.emit = emit;
  }
  sessionId = `dbg-${randomUUID().slice(0, 8)}`;
  proc = null;
  ws = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  // CDP scriptId -> file path, populated by Debugger.scriptParsed.
  scriptToPath = /* @__PURE__ */ new Map();
  // Breakpoint tracking: `${path}:${line}` -> CDP breakpointId(s).
  bpIdsByLocation = /* @__PURE__ */ new Map();
  // Snapshot of frames at the current pause, keyed by callFrameId — used by
  // getScopes / evaluate to find the right scopeChain.
  currentFrames = /* @__PURE__ */ new Map();
  terminated = false;
  async start() {
    const node = resolveBinPath("node") ?? process.execPath;
    const env = { ...process.env };
    if (node === process.execPath) env.ELECTRON_RUN_AS_NODE = "1";
    this.proc = spawnBin(node, ["--inspect-brk=0", this.file], {
      cwd: workspace.getRoot() ?? dirname(this.file),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.proc.stdout?.on("data", (b) => {
      this.emit({ kind: "output", category: "stdout", text: b.toString("utf8") });
    });
    let stderrBuf = "";
    let urlFound = false;
    const wsUrl = await new Promise((resolve2, reject) => {
      const timer2 = setTimeout(() => {
        if (!urlFound) reject(new Error("Timed out waiting for V8 inspector to start"));
      }, 8e3);
      this.proc.stderr?.on("data", (b) => {
        const t = b.toString("utf8");
        if (!urlFound) {
          stderrBuf += t;
          const m = stderrBuf.match(/ws:\/\/[^\s]+/);
          if (m) {
            urlFound = true;
            clearTimeout(timer2);
            resolve2(m[0]);
            return;
          }
        }
        if (urlFound) this.emit({ kind: "output", category: "stderr", text: t });
      });
      this.proc.on("error", (e) => {
        if (!urlFound) {
          clearTimeout(timer2);
          reject(e);
        }
      });
      this.proc.on("exit", (code) => {
        this.terminated = true;
        if (!urlFound) {
          clearTimeout(timer2);
          reject(new Error(`Node exited before inspector started (code=${code}). stderr: ${stderrBuf.slice(0, 600)}`));
        }
        try {
          this.ws?.close();
        } catch {
        }
        this.emit({ kind: "terminated", exitCode: code });
      });
    });
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve2, reject) => {
      this.ws.once("open", () => resolve2());
      this.ws.once("error", (e) => reject(e));
    });
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("close", () => {
      for (const [, p] of this.pending) p.reject(new Error("Debug socket closed"));
      this.pending.clear();
    });
    await this.cdp("Debugger.enable");
    await this.cdp("Runtime.enable");
    this.emit({ kind: "session-started", sessionId: this.sessionId, lang: "node" });
    await this.cdp("Runtime.runIfWaitingForDebugger");
  }
  cdp(method, params = {}) {
    if (!this.ws || this.terminated) return Promise.reject(new Error("Debug session not connected"));
    return new Promise((resolve2, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve2, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `CDP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") this.handleEvent(msg.method, msg.params);
  }
  handleEvent(method, params) {
    switch (method) {
      case "Debugger.scriptParsed": {
        if (typeof params.url === "string" && params.url.startsWith("file://")) {
          try {
            this.scriptToPath.set(params.scriptId, fileURLToPath(params.url));
          } catch {
          }
        }
        break;
      }
      case "Debugger.paused": {
        this.currentFrames.clear();
        const frames = (params.callFrames || []).map((f) => {
          this.currentFrames.set(f.callFrameId, f);
          const path = this.scriptToPath.get(f.location?.scriptId);
          return {
            id: f.callFrameId,
            name: f.functionName || "(anonymous)",
            path,
            line: (f.location?.lineNumber ?? 0) + 1,
            col: (f.location?.columnNumber ?? 0) + 1
          };
        });
        const reason = params.reason === "other" ? "breakpoint" : params.reason || "paused";
        this.emit({ kind: "paused", reason, threadId: 1, frames });
        break;
      }
      case "Debugger.resumed": {
        this.currentFrames.clear();
        this.emit({ kind: "resumed" });
        break;
      }
      case "Debugger.breakpointResolved": {
        const path = this.scriptToPath.get(params.location?.scriptId);
        if (path) {
          this.emit({
            kind: "breakpoint-resolved",
            path,
            line: (params.location.lineNumber ?? 0) + 1,
            verified: true
          });
        }
        break;
      }
    }
  }
  async request(command, args) {
    if (this.terminated) throw new Error("Debug session terminated");
    switch (command) {
      case "setBreakpoints": {
        const path = String(args.path);
        const lines = Array.isArray(args.lines) ? args.lines : [];
        for (const key of [...this.bpIdsByLocation.keys()]) {
          if (!key.startsWith(path + ":")) continue;
          for (const id of this.bpIdsByLocation.get(key) || []) {
            try {
              await this.cdp("Debugger.removeBreakpoint", { breakpointId: id });
            } catch {
            }
          }
          this.bpIdsByLocation.delete(key);
        }
        const url = pathToFileURL(path).toString();
        for (const line of lines) {
          try {
            const r = await this.cdp("Debugger.setBreakpointByUrl", { url, lineNumber: line - 1 });
            if (r?.breakpointId) this.bpIdsByLocation.set(`${path}:${line}`, [r.breakpointId]);
          } catch {
          }
        }
        return { applied: lines.length };
      }
      case "continue":
        await this.cdp("Debugger.resume");
        return {};
      case "pause":
        await this.cdp("Debugger.pause");
        return {};
      case "stepOver":
        await this.cdp("Debugger.stepOver");
        return {};
      case "stepInto":
        await this.cdp("Debugger.stepInto");
        return {};
      case "stepOut":
        await this.cdp("Debugger.stepOut");
        return {};
      case "getScopes": {
        const frame = this.currentFrames.get(args.frameId);
        if (!frame) return { scopes: [] };
        const scopes = (frame.scopeChain || []).map((s) => ({
          name: capitalize(s.type),
          varsRef: s.object?.objectId || "",
          expensive: s.type === "global"
        })).filter((s) => s.varsRef);
        return { scopes };
      }
      case "getVariables": {
        const r = await this.cdp("Runtime.getProperties", {
          objectId: String(args.varsRef),
          ownProperties: true,
          generatePreview: true
        });
        const vars = (r.result || []).map((p) => ({
          name: p.name,
          value: previewValue(p.value),
          type: p.value?.type,
          varsRef: p.value?.objectId
        }));
        return { variables: vars };
      }
      case "evaluate": {
        const r = await this.cdp("Debugger.evaluateOnCallFrame", {
          callFrameId: String(args.frameId),
          expression: String(args.expression)
        });
        if (r.exceptionDetails) {
          return {
            value: "error: " + (r.exceptionDetails.text || r.exceptionDetails.exception?.description || "eval failed"),
            type: "error"
          };
        }
        return { value: previewValue(r.result), type: r.result?.type, varsRef: r.result?.objectId };
      }
    }
    throw new Error(`Unknown debug command: ${command}`);
  }
  async stop() {
    this.terminated = true;
    try {
      this.ws?.close();
    } catch {
    }
    if (this.proc && this.proc.exitCode == null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
      }
      const proc = this.proc;
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
        }
      }, 2e3);
    }
  }
}
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
class DapClient {
  constructor(handlers) {
    this.handlers = handlers;
  }
  socket = null;
  seq = 1;
  buf = Buffer.alloc(0);
  pending = /* @__PURE__ */ new Map();
  closed = false;
  async connect(host, port, timeoutMs = 8e3) {
    await new Promise((resolve2, reject) => {
      const sock = connect({ host, port });
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Timed out connecting to debugpy at ${host}:${port}`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        this.socket = sock;
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("close", () => {
          if (this.closed) return;
          this.closed = true;
          for (const [, p] of this.pending) p.reject(new Error("DAP socket closed"));
          this.pending.clear();
          this.handlers.onClose("socket closed");
        });
        sock.on("error", () => {
        });
        resolve2();
      });
      sock.once("error", (err2) => {
        clearTimeout(t);
        reject(err2);
      });
    });
  }
  request(command, args = {}) {
    if (this.closed || !this.socket) return Promise.reject(new Error("DAP not connected"));
    const seq = this.seq++;
    const message = { seq, type: "request", command, arguments: args };
    return new Promise((resolve2, reject) => {
      this.pending.set(seq, { resolve: resolve2, reject });
      const json = JSON.stringify(message);
      const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r
\r
${json}`, "utf8");
      this.socket.write(frame);
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf8");
      this.buf = this.buf.subarray(start + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }
  dispatch(msg) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body);
      else p.reject(new Error(msg.message || `DAP ${msg.command} failed`));
    } else if (msg.type === "event") {
      try {
        this.handlers.onEvent(msg.event, msg.body);
      } catch (e) {
        console.error("[dap] event handler threw", e);
      }
    }
  }
  close() {
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
    }
    this.socket = null;
  }
}
async function pickFreePort() {
  return new Promise((resolve2, reject) => {
    const server2 = createServer();
    server2.unref();
    server2.on("error", reject);
    server2.listen(0, "127.0.0.1", () => {
      const addr = server2.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server2.close(() => resolve2(port));
    });
  });
}
class PythonDebugSession {
  constructor(file, interpreterOverride, args, emit) {
    this.file = file;
    this.interpreterOverride = interpreterOverride;
    this.args = args;
    this.emit = emit;
  }
  sessionId = `dbg-${randomUUID().slice(0, 8)}`;
  proc = null;
  dap = null;
  terminated = false;
  // DAP threadId of the currently-paused thread (debugpy reports per-thread
  // stops). Step commands need this; we capture it on each stopped event.
  pausedThreadId = null;
  // Frame metadata for the current pause — frameId is numeric in DAP, but our
  // renderer treats it as a string id. Keep a mapping for getScopes/evaluate.
  currentFrames = /* @__PURE__ */ new Map();
  varsRefCounter = 1;
  numericVarsRefs = /* @__PURE__ */ new Map();
  async start() {
    const interpreter = await this.resolveInterpreter();
    const port = await pickFreePort();
    const root = workspace.getRoot() ?? dirname(this.file);
    this.proc = spawn(interpreter, [
      "-m",
      "debugpy",
      "--listen",
      `127.0.0.1:${port}`,
      "--wait-for-client",
      this.file,
      ...this.args
    ], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.proc.stdout?.on("data", (b) => {
      this.emit({ kind: "output", category: "stdout", text: b.toString("utf8") });
    });
    let stderrBuf = "";
    this.proc.stderr?.on("data", (b) => {
      const t = b.toString("utf8");
      stderrBuf += t;
      this.emit({ kind: "output", category: "stderr", text: t });
    });
    this.proc.on("exit", (code) => {
      this.terminated = true;
      try {
        this.dap?.close();
      } catch {
      }
      if (code !== 0 && /No module named ['"]debugpy['"]/i.test(stderrBuf)) {
        this.emit({
          kind: "output",
          category: "stderr",
          text: `
[opendev] debugpy is not installed in this interpreter. Install via the Packages tab (pip: 'debugpy') or run: ${interpreter} -m pip install debugpy
`
        });
      }
      this.emit({ kind: "terminated", exitCode: code });
    });
    this.dap = new DapClient({
      onEvent: (event, body) => this.handleEvent(event, body),
      onClose: () => {
      }
    });
    await this.connectWithRetry("127.0.0.1", port);
    await this.dap.request("initialize", {
      adapterID: "opendev-python",
      clientID: "opendev-ide",
      clientName: "OpenDev IDE",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsRunInTerminalRequest: false
    });
    await this.dap.request("attach", {
      // debugpy reads the local stop-on-entry preference; we don't want it
      // pausing at module top — let it run until a real breakpoint.
      justMyCode: false
    });
    this.emit({ kind: "session-started", sessionId: this.sessionId, lang: "python" });
    await new Promise((res) => setTimeout(res, 60));
    try {
      await this.dap.request("configurationDone", {});
    } catch (e) {
      console.warn("[python-debug] configurationDone failed (likely benign):", e.message);
    }
  }
  async resolveInterpreter() {
    if (this.interpreterOverride) return this.interpreterOverride;
    try {
      const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
      const sel = await getSelectedInterpreter2();
      if (sel) return sel.path;
    } catch {
    }
    return "python3";
  }
  async connectWithRetry(host, port, attempts = 25) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (this.terminated) throw new Error("debugpy exited before client could connect");
      try {
        await this.dap.connect(host, port, 1500);
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`Could not connect to debugpy at ${host}:${port}: ${lastErr?.message || "unknown error"}`);
  }
  // Convert a numeric DAP variablesReference into a stable string key the
  // renderer can pass back via getVariables. The mapping is per-session and
  // gets rebuilt on each pause (DAP refs aren't stable across stops).
  refToKey(ref) {
    if (!ref) return "";
    const key = String(ref);
    this.numericVarsRefs.set(key, ref);
    return key;
  }
  keyToRef(key) {
    return this.numericVarsRefs.get(key) ?? Number(key) ?? 0;
  }
  handleEvent(event, body) {
    switch (event) {
      case "initialized":
        break;
      case "stopped": {
        this.pausedThreadId = body?.threadId ?? null;
        void this.fetchStack(body?.reason || "paused");
        break;
      }
      case "continued":
        this.currentFrames.clear();
        this.numericVarsRefs.clear();
        this.emit({ kind: "resumed" });
        break;
      case "thread":
        break;
      case "output": {
        const cat = body?.category;
        if (cat === "telemetry") break;
        const target = cat === "stdout" ? "stdout" : "stderr";
        this.emit({ kind: "output", category: target, text: String(body?.output ?? "") });
        break;
      }
      case "terminated":
      case "exited":
        this.terminated = true;
        this.emit({ kind: "terminated", exitCode: typeof body?.exitCode === "number" ? body.exitCode : null });
        break;
      case "breakpoint": {
        const bp = body?.breakpoint;
        if (bp?.verified && bp.source?.path && typeof bp.line === "number") {
          this.emit({ kind: "breakpoint-resolved", path: bp.source.path, line: bp.line, verified: true });
        }
        break;
      }
    }
  }
  async fetchStack(reason) {
    if (!this.dap || this.pausedThreadId == null) return;
    try {
      const r = await this.dap.request("stackTrace", { threadId: this.pausedThreadId, startFrame: 0, levels: 20 });
      this.currentFrames.clear();
      this.numericVarsRefs.clear();
      const frames = (r?.stackFrames || []).map((f) => {
        const id = String(f.id);
        this.currentFrames.set(id, f.id);
        return {
          id,
          name: f.name || "(anonymous)",
          path: f.source?.path,
          line: f.line ?? 0,
          col: f.column ?? 0
        };
      });
      this.emit({ kind: "paused", reason, threadId: this.pausedThreadId, frames });
    } catch (e) {
      console.error("[python-debug] stackTrace failed", e);
      this.emit({ kind: "paused", reason, threadId: this.pausedThreadId, frames: [] });
    }
  }
  async request(command, args) {
    if (this.terminated || !this.dap) throw new Error("Debug session terminated");
    switch (command) {
      case "setBreakpoints": {
        const path = String(args.path);
        if (!isAbsolute(path)) {
          const root = workspace.getRoot();
          if (root) args.path = resolve(root, path);
        }
        const lines = Array.isArray(args.lines) ? args.lines : [];
        const r = await this.dap.request("setBreakpoints", {
          source: { path: args.path || path, name: baseName(args.path || path) },
          breakpoints: lines.map((line) => ({ line })),
          lines
        });
        return { applied: (r?.breakpoints || []).filter((b) => b.verified).length };
      }
      case "continue":
        if (this.pausedThreadId != null) await this.dap.request("continue", { threadId: this.pausedThreadId });
        return {};
      case "pause":
        if (this.pausedThreadId != null) await this.dap.request("pause", { threadId: this.pausedThreadId });
        else {
          const t = await this.dap.request("threads");
          const tid = t?.threads?.[0]?.id;
          if (tid != null) await this.dap.request("pause", { threadId: tid });
        }
        return {};
      case "stepOver":
        if (this.pausedThreadId != null) await this.dap.request("next", { threadId: this.pausedThreadId });
        return {};
      case "stepInto":
        if (this.pausedThreadId != null) await this.dap.request("stepIn", { threadId: this.pausedThreadId });
        return {};
      case "stepOut":
        if (this.pausedThreadId != null) await this.dap.request("stepOut", { threadId: this.pausedThreadId });
        return {};
      case "getScopes": {
        const frameNum = this.currentFrames.get(String(args.frameId));
        if (frameNum == null) return { scopes: [] };
        const r = await this.dap.request("scopes", { frameId: frameNum });
        const scopes = (r?.scopes || []).map((s) => ({
          name: capitalize(s.name || "scope"),
          varsRef: this.refToKey(s.variablesReference),
          expensive: !!s.expensive
        })).filter((s) => s.varsRef);
        return { scopes };
      }
      case "getVariables": {
        const ref = this.keyToRef(String(args.varsRef));
        if (!ref) return { variables: [] };
        const r = await this.dap.request("variables", { variablesReference: ref });
        const vars = (r?.variables || []).map((v) => ({
          name: v.name,
          value: String(v.value ?? ""),
          type: v.type,
          varsRef: v.variablesReference ? this.refToKey(v.variablesReference) : void 0
        }));
        return { variables: vars };
      }
      case "evaluate": {
        const frameNum = this.currentFrames.get(String(args.frameId));
        try {
          const r = await this.dap.request("evaluate", {
            expression: String(args.expression),
            frameId: frameNum,
            context: "repl"
          });
          return {
            value: String(r?.result ?? ""),
            type: r?.type,
            varsRef: r?.variablesReference ? this.refToKey(r.variablesReference) : void 0
          };
        } catch (err2) {
          return { value: "error: " + err2.message, type: "error" };
        }
      }
    }
    void this.varsRefCounter;
    return {};
  }
  async stop() {
    if (this.terminated) return;
    this.terminated = true;
    try {
      await this.dap?.request("disconnect", { terminateDebuggee: true });
    } catch {
    }
    try {
      this.dap?.close();
    } catch {
    }
    if (this.proc && this.proc.exitCode == null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
      }
      const proc = this.proc;
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
        }
      }, 2e3);
    }
  }
}
function previewValue(v) {
  if (!v) return "undefined";
  if (v.unserializableValue) return String(v.unserializableValue);
  if ("value" in v) {
    if (typeof v.value === "string") return JSON.stringify(v.value);
    return String(v.value);
  }
  if (v.description) return String(v.description);
  return v.type || "?";
}
class DebugManager {
  session = null;
  emit = (e) => {
    safeSend(IPC.DebugEvent, e);
    if (e.kind === "terminated") this.session = null;
  };
  async start(config) {
    if (this.session) {
      try {
        await this.session.stop();
      } catch {
      }
      this.session = null;
    }
    if (config.lang === "node") {
      const s = new NodeDebugSession(config.file, this.emit);
      this.session = s;
      try {
        await s.start();
      } catch (err2) {
        this.session = null;
        const msg = `[debug start failed] ${err2.message}
`;
        this.emit({ kind: "output", category: "stderr", text: msg });
        this.emit({ kind: "terminated", exitCode: -1 });
        throw err2;
      }
      return { sessionId: s.sessionId };
    }
    if (config.lang === "python") {
      const s = new PythonDebugSession(config.file, config.interpreter, config.args ?? [], this.emit);
      this.session = s;
      try {
        await s.start();
      } catch (err2) {
        this.session = null;
        const msg = `[debug start failed] ${err2.message}
`;
        this.emit({ kind: "output", category: "stderr", text: msg });
        this.emit({ kind: "terminated", exitCode: -1 });
        throw err2;
      }
      return { sessionId: s.sessionId };
    }
    throw new Error("Java debugging is Milestone 2 — not implemented yet.");
  }
  async request(command, args) {
    if (!this.session) throw new Error("No active debug session");
    return this.session.request(command, args);
  }
  async stop() {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    await s.stop();
  }
}
const debugManager = new DebugManager();
function registerDebugIpc() {
  ipcMain.handle(IPC.DebugStart, (_e, config) => debugManager.start(config));
  ipcMain.handle(IPC.DebugRequest, (_e, command, args) => debugManager.request(command, args));
  ipcMain.handle(IPC.DebugStop, () => debugManager.stop());
}
function nodePlainJs(name) {
  return [
    { path: "package.json", content: JSON.stringify({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { start: "node index.js" }
    }, null, 2) + "\n" },
    { path: "index.js", content: `console.log('Hello from ${name} (Node.js)');
` },
    { path: ".gitignore", content: "node_modules/\n" }
  ];
}
function nodePlainTs(name) {
  return [
    { path: "package.json", content: JSON.stringify({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { start: "tsx index.ts", build: "tsc -p ." },
      devDependencies: { tsx: "^4.19.0", typescript: "^5.6.0", "@types/node": "^22.0.0" }
    }, null, 2) + "\n" },
    { path: "tsconfig.json", content: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist"
      },
      include: ["*.ts", "src/**/*.ts"]
    }, null, 2) + "\n" },
    { path: "index.ts", content: `console.log('Hello from ${name} (TypeScript)');
` },
    { path: ".gitignore", content: "node_modules/\ndist/\n" }
  ];
}
function nodeExpressJs(name) {
  return [
    { path: "package.json", content: JSON.stringify({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { start: "node index.js", dev: "node --watch index.js" },
      dependencies: { express: "^4.21.0" }
    }, null, 2) + "\n" },
    { path: "index.js", content: `import express from 'express';

const app = express();
const port = process.env.PORT ?? 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ ok: true, app: '${name}' });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(port, () => {
  console.log(\`${name} listening on :\${port}\`);
});
` },
    { path: ".gitignore", content: "node_modules/\n" }
  ];
}
function nodeExpressTs(name) {
  return [
    { path: "package.json", content: JSON.stringify({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { start: "tsx index.ts", dev: "tsx --watch index.ts", build: "tsc -p ." },
      dependencies: { express: "^4.21.0" },
      devDependencies: { tsx: "^4.19.0", typescript: "^5.6.0", "@types/express": "^5.0.0", "@types/node": "^22.0.0" }
    }, null, 2) + "\n" },
    { path: "tsconfig.json", content: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist"
      },
      include: ["*.ts", "src/**/*.ts"]
    }, null, 2) + "\n" },
    { path: "index.ts", content: `import express, { type Request, type Response } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get('/', (_req: Request, res: Response) => {
  res.json({ ok: true, app: '${name}' });
});

app.get('/healthz', (_req: Request, res: Response) => res.send('ok'));

app.listen(port, () => {
  console.log(\`${name} listening on :\${port}\`);
});
` },
    { path: ".gitignore", content: "node_modules/\ndist/\n" }
  ];
}
function javaSpringBootMaven(name) {
  const pkg = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const className = name.replace(/[^A-Za-z0-9]/g, "").replace(/^[a-z]/, (c) => c.toUpperCase()) + "Application";
  return [
    { path: "pom.xml", content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
    <relativePath/>
  </parent>

  <groupId>com.example.${pkg}</groupId>
  <artifactId>${name}</artifactId>
  <version>0.1.0</version>
  <name>${name}</name>

  <properties>
    <java.version>17</java.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
` },
    { path: `src/main/java/com/example/${pkg}/${className}.java`, content: `package com.example.${pkg};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class ${className} {
  public static void main(String[] args) {
    SpringApplication.run(${className}.class, args);
  }

  @GetMapping("/")
  public String home() {
    return "Hello from ${name} (Spring Boot)";
  }

  @GetMapping("/healthz")
  public String health() {
    return "ok";
  }
}
` },
    { path: "src/main/resources/application.properties", content: `server.port=8080
spring.application.name=${name}
` },
    { path: ".gitignore", content: "target/\n.idea/\n*.iml\n" }
  ];
}
const TEMPLATES = [
  {
    id: "node-plain-js",
    language: "JavaScript",
    framework: "Plain (Node.js)",
    description: "A minimal Node.js project with index.js and an npm start script.",
    postCreate: "After install completes: `npm start`.",
    kind: "inline",
    files: nodePlainJs,
    postInstall: "npm install"
  },
  {
    id: "node-express-js",
    language: "JavaScript",
    framework: "Express Web API",
    description: "A minimal Express server (JS) with /, /healthz, and a dev script.",
    postCreate: "After install completes: `npm run dev`.",
    kind: "inline",
    files: nodeExpressJs,
    postInstall: "npm install"
  },
  {
    id: "node-plain-ts",
    language: "TypeScript",
    framework: "Plain (Node.js)",
    description: "A minimal TypeScript Node project with tsx + tsc.",
    postCreate: "After install completes: `npm start`.",
    kind: "inline",
    files: nodePlainTs,
    postInstall: "npm install"
  },
  {
    id: "node-express-ts",
    language: "TypeScript",
    framework: "Express Web API",
    description: "A minimal Express server (TypeScript) with tsx + tsc.",
    postCreate: "After install completes: `npm run dev`.",
    kind: "inline",
    files: nodeExpressTs,
    postInstall: "npm install"
  },
  {
    id: "react-vite",
    language: "TypeScript",
    framework: "React + Vite",
    description: "A React + TypeScript single-page app scaffolded by `npm create vite`.",
    postCreate: "After install completes: `npm run dev`.",
    requires: "Requires `npm` on PATH.",
    kind: "cli",
    cli: (name) => ({ cmd: "npm", args: ["create", "vite@latest", name, "--", "--template", "react-ts"], cwd: "parent" }),
    postInstall: "npm install"
  },
  {
    id: "java-spring-boot-maven",
    language: "Java",
    framework: "Spring Boot Web API (Maven)",
    description: "A minimal Spring Boot 3 web service with one controller and two routes.",
    postCreate: "After install completes: `mvn spring-boot:run`.",
    requires: "Requires `mvn` on PATH (Maven 3.6+, JDK 17+).",
    // mvn install -DskipTests fetches all deps + builds, equivalent of npm install.
    kind: "inline",
    files: javaSpringBootMaven,
    postInstall: "mvn install -DskipTests"
  },
  {
    id: "dotnet-webapi",
    language: "C#",
    framework: "ASP.NET Core Web API",
    description: "A minimal ASP.NET Core Web API scaffolded by `dotnet new webapi`.",
    postCreate: "Then: `dotnet run`.",
    requires: "Requires the `dotnet` CLI on PATH.",
    kind: "cli",
    // dotnet new restores by default, so no extra postInstall needed.
    cli: (name, dir) => ({ cmd: "dotnet", args: ["new", "webapi", "-n", name, "-o", join(dir, name)], cwd: "parent" })
  },
  {
    id: "dotnet-console",
    language: "C#",
    framework: "Console",
    description: "A minimal C# console app scaffolded by `dotnet new console`.",
    postCreate: "Then: `dotnet run`.",
    requires: "Requires the `dotnet` CLI on PATH.",
    kind: "cli",
    cli: (name, dir) => ({ cmd: "dotnet", args: ["new", "console", "-n", name, "-o", join(dir, name)], cwd: "parent" })
  }
];
function publicTemplate(t) {
  return {
    id: t.id,
    language: t.language,
    framework: t.framework,
    description: t.description,
    postCreate: t.postCreate,
    requires: t.requires
  };
}
function logLine$1(line) {
  safeSend(IPC.ProjectsCreateLog, line.endsWith("\n") ? line : line + "\n");
}
function looksLikeName(name) {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(name);
}
function runStreamed$1(cmdName, args, cwd) {
  return new Promise((resolveP) => {
    const resolved2 = resolveBinPath(cmdName);
    if (!resolved2) {
      logLine$1(`[error] ${cmdName} not found on PATH.`);
      resolveP({ code: -1, missingTool: cmdName });
      return;
    }
    logLine$1(`$ ${cmdName} ${args.join(" ")}`);
    const proc = spawnBin(resolved2, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    proc.stdout?.on("data", (b) => logLine$1(b.toString("utf8")));
    proc.stderr?.on("data", (b) => logLine$1(b.toString("utf8")));
    proc.on("error", (err2) => {
      logLine$1(`[spawn error] ${err2.message}`);
      resolveP({ code: -1 });
    });
    proc.on("exit", (code) => resolveP({ code }));
  });
}
async function createProject(args) {
  const t = TEMPLATES.find((x) => x.id === args.templateId);
  if (!t) return { ok: false, error: `Unknown template: ${args.templateId}` };
  const name = args.projectName.trim();
  if (!looksLikeName(name)) {
    return { ok: false, error: "Project name must be 1–64 chars: letters, digits, dot, underscore, hyphen." };
  }
  const dest = args.destinationDir;
  try {
    await promises.access(dest);
  } catch {
    return { ok: false, error: `Destination folder does not exist: ${dest}` };
  }
  const projectPath = join(dest, name);
  try {
    await promises.access(projectPath);
    return { ok: false, error: `A folder named "${name}" already exists at the destination.` };
  } catch {
  }
  logLine$1(`Creating ${t.language} / ${t.framework} project "${name}" in ${dest}…`);
  if (t.kind === "inline") {
    try {
      await promises.mkdir(projectPath, { recursive: true });
      for (const f of t.files(name)) {
        const abs = join(projectPath, f.path);
        await promises.mkdir(join(abs, ".."), { recursive: true });
        await promises.writeFile(abs, f.content, "utf8");
        logLine$1(`  + ${f.path}`);
      }
    } catch (err2) {
      return { ok: false, error: `Scaffold failed: ${err2.message}` };
    }
  } else {
    const spec = t.cli(name, dest);
    const cwd = spec.cwd === "parent" ? dest : projectPath;
    const r = await runStreamed$1(spec.cmd, spec.args, cwd);
    if (r.missingTool) {
      return { ok: false, error: `${r.missingTool} is not installed.`, errorCode: "MISSING_TOOL", missingTool: r.missingTool };
    }
    if (r.code !== 0) {
      return { ok: false, error: `${spec.cmd} exited with code ${r.code}.` };
    }
    try {
      await promises.access(projectPath);
    } catch {
      return { ok: false, error: `${spec.cmd} did not create "${projectPath}".` };
    }
  }
  if (t.postInstall) {
    logLine$1("");
    logLine$1("Installing dependencies…");
    const parts = t.postInstall.split(/\s+/);
    const r = await runStreamed$1(parts[0], parts.slice(1), projectPath);
    if (r.missingTool) {
      return {
        ok: false,
        projectPath,
        error: `${r.missingTool} is not installed — needed to install dependencies for this template.`,
        errorCode: "MISSING_TOOL",
        missingTool: r.missingTool
      };
    }
    if (r.code !== 0) {
      logLine$1(`[warn] dependency install failed (exit ${r.code}). The project files are in place; run \`${t.postInstall}\` in ${projectPath} to retry.`);
    } else {
      logLine$1("Dependencies installed.");
    }
  }
  logLine$1("");
  logLine$1(`✓ Project ready at ${projectPath}`);
  return { ok: true, projectPath };
}
function registerProjectsIpc() {
  ipcMain.handle(IPC.ProjectsList, () => TEMPLATES.map(publicTemplate));
  ipcMain.handle(IPC.ProjectsCreate, (_e, args) => createProject(args));
  ipcMain.handle(IPC.ProjectsPickDir, async () => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Choose a destination folder for the new project"
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
}
function logLine(line) {
  safeSend(IPC.PackagesAddLog, line.endsWith("\n") ? line : line + "\n");
}
async function detectProject(dir) {
  let entries;
  try {
    entries = await promises.readdir(dir);
  } catch {
    return null;
  }
  if (entries.includes("pom.xml")) {
    return { type: "maven", projectFile: join(dir, "pom.xml"), label: "Maven (pom.xml)" };
  }
  const csproj = entries.find((e) => e.toLowerCase().endsWith(".csproj"));
  if (csproj) {
    return { type: "dotnet", projectFile: join(dir, csproj), label: csproj };
  }
  return null;
}
function runStreamed(cmdName, args, cwd) {
  return new Promise((resolve2) => {
    const resolved2 = resolveBinPath(cmdName);
    if (!resolved2) {
      logLine(`[error] ${cmdName} not found on PATH — install it and try again.`);
      resolve2({ code: -1 });
      return;
    }
    logLine(`$ ${cmdName} ${args.join(" ")}`);
    const proc = spawnBin(resolved2, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    proc.stdout?.on("data", (b) => logLine(b.toString("utf8")));
    proc.stderr?.on("data", (b) => logLine(b.toString("utf8")));
    proc.on("error", (e) => {
      logLine(`[spawn error] ${e.message}`);
      resolve2({ code: -1 });
    });
    proc.on("exit", (code) => resolve2({ code }));
  });
}
async function addMavenDependency(pomPath, groupId, artifactId, version2) {
  const xml = await promises.readFile(pomPath, "utf8");
  const sigRe = new RegExp(`<groupId>\\s*${escapeRegex(groupId)}\\s*</groupId>\\s*<artifactId>\\s*${escapeRegex(artifactId)}\\s*</artifactId>`);
  if (sigRe.test(xml)) {
    logLine(`[skip] ${groupId}:${artifactId} is already a dependency.`);
    return;
  }
  const block = [
    "    <dependency>",
    `      <groupId>${groupId}</groupId>`,
    `      <artifactId>${artifactId}</artifactId>`,
    ...version2 ? [`      <version>${version2}</version>`] : [],
    "    </dependency>"
  ].join("\n");
  let next;
  if (xml.includes("</dependencies>")) {
    next = xml.replace("</dependencies>", `${block}
  </dependencies>`);
  } else {
    next = xml.replace("</project>", `  <dependencies>
${block}
  </dependencies>
</project>`);
  }
  if (next === xml) {
    throw new Error("Could not find </dependencies> or </project> in pom.xml.");
  }
  await promises.writeFile(pomPath, next, "utf8");
  logLine(`Wrote ${groupId}:${artifactId}${version2 ? "@" + version2 : ""} to pom.xml.`);
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function addPackage(args) {
  const det = await detectProject(args.projectDir);
  if (!det) return { ok: false, error: `No Maven or .NET project found in ${args.projectDir}.` };
  if (det.type !== args.type) return { ok: false, error: `Detected project type (${det.type}) doesn't match requested (${args.type}).` };
  if (det.type === "dotnet") {
    const pkg = args.packageId.trim();
    if (!pkg) return { ok: false, error: "Empty package name." };
    const argv = ["add", det.projectFile, "package", pkg];
    if (args.version) argv.push("--version", args.version.trim());
    const r2 = await runStreamed("dotnet", argv, args.projectDir);
    if (r2.code !== 0) return { ok: false, error: `dotnet exited with code ${r2.code}.` };
    return { ok: true };
  }
  const parts = args.packageId.split(":").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, error: 'Maven package must be "groupId:artifactId" or "groupId:artifactId:version".' };
  }
  const [groupId, artifactId, vFromId] = parts;
  const version2 = args.version?.trim() || vFromId || void 0;
  try {
    await addMavenDependency(det.projectFile, groupId, artifactId, version2);
  } catch (err2) {
    return { ok: false, error: `pom.xml edit failed: ${err2.message}` };
  }
  const r = await runStreamed("mvn", ["install", "-DskipTests"], args.projectDir);
  if (r.code !== 0) {
    return { ok: false, error: `mvn install exited with code ${r.code}. The pom.xml edit was applied; run \`mvn install -DskipTests\` to retry.` };
  }
  return { ok: true };
}
function registerPackagesIpc() {
  ipcMain.handle(IPC.PackagesDetect, (_e, dir) => detectProject(dir));
  ipcMain.handle(IPC.PackagesAdd, (_e, args) => addPackage(args));
}
const MAX_ENTRIES = 200;
function historyPath(kind) {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  return join(root, ".opendev", `${kind}-history.json`);
}
async function readHistory(kind) {
  if (!workspace.getRoot()) return [];
  try {
    const raw = await promises.readFile(historyPath(kind), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}
async function writeHistory(kind, entries) {
  const root = workspace.getRoot();
  if (!root) return;
  await promises.mkdir(join(root, ".opendev"), { recursive: true });
  await promises.writeFile(historyPath(kind), JSON.stringify({ entries }, null, 2), "utf8");
}
async function append(kind, entry) {
  if (!workspace.getRoot()) return [];
  const entries = await readHistory(kind);
  const filtered = entries.filter((e) => !(e.text === entry.text && e.connId === entry.connId));
  filtered.unshift(entry);
  const capped = filtered.slice(0, MAX_ENTRIES);
  await writeHistory(kind, capped);
  return capped;
}
async function clear(kind) {
  if (!workspace.getRoot()) return;
  await writeHistory(kind, []);
}
function registerHistoryIpc() {
  ipcMain.handle(IPC.HistoryRead, (_e, kind) => readHistory(kind));
  ipcMain.handle(IPC.HistoryAppend, (_e, kind, entry) => append(kind, entry));
  ipcMain.handle(IPC.HistoryClear, (_e, kind) => clear(kind));
}
function coerce(v) {
  if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(v)) return Number(v);
  return v;
}
function parseSimpleYaml(text) {
  const out = {};
  let nested = null;
  let nestedKey = "";
  let nestedIndent = -1;
  for (const rawLine of text.split(/\r?\n/)) {
    const noComment = rawLine.replace(/#.*$/, "").replace(/\s+$/, "");
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)[0].length;
    const m = noComment.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2].trim();
    if (nested && (indent <= nestedIndent || rawValue === "")) {
      out[nestedKey] = nested;
      nested = null;
      nestedIndent = -1;
    }
    if (rawValue === "") {
      nested = {};
      nestedKey = key;
      nestedIndent = indent;
      continue;
    }
    if (nested && indent > nestedIndent) {
      nested[key] = coerce(rawValue);
    } else {
      out[key] = coerce(rawValue);
    }
  }
  if (nested) out[nestedKey] = nested;
  return out;
}
function findConfigPath(root) {
  const candidates = [
    join(root, "lora_config.yaml"),
    join(root, "lora_config.yml"),
    join(root, "training", "lora_config.yaml"),
    join(root, "training", "lora_config.yml")
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
function resolveProjectPath(workspaceRoot, configDir, value) {
  if (isAbsolute(value)) return existsSync(value) ? value : null;
  const wsName = basename(workspaceRoot);
  const candidates = [
    join(configDir, value),
    join(workspaceRoot, value),
    // "training/adapters" stripped when workspace IS "training/"
    value.startsWith(wsName + "/") ? join(workspaceRoot, value.slice(wsName.length + 1)) : null,
    join(workspaceRoot, "..", value)
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}
function findPython(workspaceRoot) {
  const venvCandidates = [
    join(workspaceRoot, ".venv", "bin", "python"),
    join(workspaceRoot, "venv", "bin", "python"),
    join(workspaceRoot, "..", ".venv", "bin", "python")
  ];
  for (const c of venvCandidates) {
    if (existsSync(c)) return { python: resolve(c), hasVenv: true };
  }
  return { python: "python3", hasVenv: false };
}
const MLX_AUTO_SERVICE_ID = "auto-mlx-lora-train";
async function detectMlxProject() {
  const root = workspace.getRoot();
  if (!root) return null;
  const configPath = findConfigPath(root);
  if (!configPath) return null;
  let raw = {};
  try {
    const text = await promises.readFile(configPath, "utf8");
    raw = parseSimpleYaml(text);
  } catch {
    return null;
  }
  const configDir = dirname(configPath);
  const adapterPath = typeof raw.adapter_path === "string" ? raw.adapter_path : void 0;
  const dataPath = typeof raw.data === "string" ? raw.data : void 0;
  const lora = raw.lora_parameters || {};
  const { python: python2, hasVenv } = findPython(root);
  const info = {
    configPath,
    model: typeof raw.model === "string" ? raw.model : void 0,
    data: dataPath,
    fineTuneType: typeof raw.fine_tune_type === "string" ? raw.fine_tune_type : void 0,
    numLayers: typeof raw.num_layers === "number" ? raw.num_layers : void 0,
    batchSize: typeof raw.batch_size === "number" ? raw.batch_size : void 0,
    iters: typeof raw.iters === "number" ? raw.iters : void 0,
    learningRate: typeof raw.learning_rate === "number" ? raw.learning_rate : void 0,
    maxSeqLength: typeof raw.max_seq_length === "number" ? raw.max_seq_length : void 0,
    gradCheckpoint: typeof raw.grad_checkpoint === "boolean" ? raw.grad_checkpoint : void 0,
    stepsPerReport: typeof raw.steps_per_report === "number" ? raw.steps_per_report : void 0,
    stepsPerEval: typeof raw.steps_per_eval === "number" ? raw.steps_per_eval : void 0,
    valBatches: typeof raw.val_batches === "number" ? raw.val_batches : void 0,
    saveEvery: typeof raw.save_every === "number" ? raw.save_every : void 0,
    adapterPath,
    loraRank: typeof lora.rank === "number" ? lora.rank : void 0,
    loraScale: typeof lora.scale === "number" ? lora.scale : void 0,
    loraDropout: typeof lora.dropout === "number" ? lora.dropout : void 0,
    raw,
    resolvedAdapterDir: adapterPath ? resolveProjectPath(root, configDir, adapterPath) : null,
    resolvedDataDir: dataPath ? resolveProjectPath(root, configDir, dataPath) : null,
    python: python2,
    hasVenv,
    serviceId: MLX_AUTO_SERVICE_ID
  };
  return info;
}
async function buildTrainCommand(info) {
  const root = workspace.getRoot();
  const cfgRel = isWithin(info.configPath, root) && info.configPath.length > root.length ? toPosix(info.configPath.slice(root.length + 1)) : info.configPath;
  try {
    const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
    const sel = await getSelectedInterpreter2();
    if (sel) {
      const wrapper = join(sel.path, "..", "mlx_lm.lora");
      if (existsSync(wrapper)) return `${quote(rel(root, wrapper))} --config ${quote(cfgRel)}`;
      return `${quote(rel(root, sel.path))} -m mlx_lm.lora --config ${quote(cfgRel)}`;
    }
  } catch {
  }
  const venvLora = join(root, ".venv", "bin", "mlx_lm.lora");
  if (existsSync(venvLora)) {
    return `.venv/bin/mlx_lm.lora --config ${quote(cfgRel)}`;
  }
  const venvPy = join(root, ".venv", "bin", "python");
  if (existsSync(venvPy)) {
    return `.venv/bin/python -m mlx_lm.lora --config ${quote(cfgRel)}`;
  }
  return `python3 -m mlx_lm.lora --config ${quote(cfgRel)}`;
}
function rel(root, p) {
  return isWithin(p, root) && p.length > root.length ? toPosix(p.slice(root.length + 1)) : p;
}
function quote(s) {
  if (/^[A-Za-z0-9._/\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
const ADAPTER_FILE_RE = /^(?:(\d+)_)?adapters\.safetensors$/;
async function listAdapters() {
  const info = await detectMlxProject();
  const dir = info?.resolvedAdapterDir;
  if (!dir) return [];
  let entries = [];
  try {
    entries = await promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const m = name.match(ADAPTER_FILE_RE);
    if (!m) continue;
    const abs = join(dir, name);
    try {
      const st = await promises.stat(abs);
      out.push({
        path: abs,
        name,
        iter: m[1] ? Number(m[1]) : null,
        sizeBytes: st.size,
        modifiedAt: st.mtimeMs,
        isLatestPointer: !m[1]
      });
    } catch {
    }
  }
  out.sort((a, b) => {
    if (a.isLatestPointer && !b.isLatestPointer) return 1;
    if (!a.isLatestPointer && b.isLatestPointer) return -1;
    return (a.iter ?? 0) - (b.iter ?? 0);
  });
  return out;
}
const TRAIN_RE = /^Iter\s+(\d+):\s+Train loss\s+([0-9.]+),\s+Learning Rate\s+([0-9.eE+-]+),\s+It\/sec\s+([0-9.]+),\s+Tokens\/sec\s+([0-9.]+),\s+Trained Tokens\s+(\d+),\s+Peak mem\s+([0-9.]+)\s+GB/;
const VAL_RE = /^Iter\s+(\d+):\s+Val loss\s+([0-9.]+),\s+Val took\s+([0-9.]+)s/;
const SAVED_RE = /^Iter\s+(\d+):\s+Saved adapter weights to\s+(.+?)\.?$/;
function parseTrainLine(line) {
  const ts = Date.now();
  let m;
  if (m = line.match(TRAIN_RE)) {
    return {
      kind: "train",
      iter: Number(m[1]),
      trainLoss: Number(m[2]),
      learningRate: Number(m[3]),
      itPerSec: Number(m[4]),
      tokensPerSec: Number(m[5]),
      trainedTokens: Number(m[6]),
      peakMemGb: Number(m[7]),
      ts
    };
  }
  if (m = line.match(VAL_RE)) {
    return { kind: "val", iter: Number(m[1]), valLoss: Number(m[2]), valTookSec: Number(m[3]), ts };
  }
  if (m = line.match(SAVED_RE)) {
    const paths = m[2].split(/\s+and\s+/).map((p) => p.trim()).filter(Boolean);
    return { kind: "saved", iter: Number(m[1]), paths, ts };
  }
  return null;
}
async function readTrainLog(absPath) {
  const root = workspace.getRoot();
  if (!root) return [];
  let target = absPath;
  if (!target) {
    const candidates = ["train_v2.log", "train.log", "training/train_v2.log", "training/train.log"];
    for (const c of candidates) {
      const abs = join(root, c);
      if (existsSync(abs)) {
        target = abs;
        break;
      }
    }
  }
  if (!target || !existsSync(target)) return [];
  let text;
  try {
    text = await promises.readFile(target, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const raw of text.split(/[\r\n]+/)) {
    if (!raw) continue;
    if (raw.startsWith("Calculating loss")) continue;
    const ev = parseTrainLine(raw);
    if (ev) events.push(ev);
  }
  return events;
}
const MAX_EVENTS = 500;
const liveEvents = [];
let logBuffer = "";
let logSubscribed = false;
function pushEvent(ev) {
  liveEvents.push(ev);
  if (liveEvents.length > MAX_EVENTS) liveEvents.splice(0, liveEvents.length - MAX_EVENTS);
  safeSend(IPC.MlxEvent, ev);
}
function ensureLogSubscription() {
  if (logSubscribed) return;
  logSubscribed = true;
  serviceManager.onLogChunk((id, chunk) => {
    if (id !== MLX_AUTO_SERVICE_ID) return;
    logBuffer += chunk;
    const parts = logBuffer.split(/[\r\n]+/);
    logBuffer = parts.pop() ?? "";
    for (const line of parts) {
      if (!line || line.startsWith("Calculating loss")) continue;
      const ev = parseTrainLine(line);
      if (ev) pushEvent(ev);
    }
  });
  serviceManager.onStatusChange((r) => {
    if (r.id !== MLX_AUTO_SERVICE_ID) return;
    if (r.status === "starting") {
      logBuffer = "";
      pushEvent({ kind: "started", ts: Date.now() });
    } else if (r.status === "stopped" || r.status === "error") {
      pushEvent({ kind: "exited", code: r.status === "error" ? 1 : 0, ts: Date.now() });
    }
  });
}
async function getMlxStatus() {
  const info = await detectMlxProject();
  if (!info) return { detected: false, running: false, events: [] };
  ensureLogSubscription();
  const rt = serviceManager.status(MLX_AUTO_SERVICE_ID);
  const running = rt.status === "running" || rt.status === "starting";
  return { detected: true, info, running, serviceId: MLX_AUTO_SERVICE_ID, events: [...liveEvents] };
}
async function startMlxTraining() {
  ensureLogSubscription();
  await serviceManager.start(MLX_AUTO_SERVICE_ID);
}
async function stopMlxTraining() {
  await serviceManager.stop(MLX_AUTO_SERVICE_ID);
}
function registerMlxIpc() {
  ipcMain.handle(IPC.MlxDetect, () => detectMlxProject());
  ipcMain.handle(IPC.MlxListAdapters, () => listAdapters());
  ipcMain.handle(IPC.MlxReadLog, (_e, path) => readTrainLog(path));
  ipcMain.handle(IPC.MlxStart, () => startMlxTraining());
  ipcMain.handle(IPC.MlxStop, () => stopMlxTraining());
  ipcMain.handle(IPC.MlxStatus, () => getMlxStatus());
}
const mlx = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  MLX_AUTO_SERVICE_ID,
  buildTrainCommand,
  detectMlxProject,
  getMlxStatus,
  listAdapters,
  parseTrainLine,
  readTrainLog,
  registerMlxIpc,
  startMlxTraining,
  stopMlxTraining
}, Symbol.toStringTag, { value: "Module" }));
const pexec = promisify(exec);
function uniqByPath(items) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    out.push(it);
  }
  return out;
}
function addIfExists(out, path, kind, label) {
  if (existsSync(path)) out.push({ path, kind, label });
}
async function listDirSafe(dir) {
  try {
    return await promises.readdir(dir);
  } catch {
    return [];
  }
}
const VENV_BIN = "bin";
const PY_NAMES = ["python", "python3"];
function addVenv(out, dir, label) {
  for (const name of PY_NAMES) addIfExists(out, join(dir, VENV_BIN, name), "venv", label);
}
async function gatherCandidates() {
  const out = [];
  const home = homedir();
  const root = workspace.getRoot();
  if (root) {
    addVenv(out, join(root, ".venv"), ".venv");
    addVenv(out, join(root, "venv"), "venv");
    addVenv(out, join(root, "..", ".venv"), "../.venv");
  }
  await gatherMacCandidates(out, home);
  for (const bin of PY_NAMES) {
    for (const dir of (process.env.PATH || "").split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, bin);
      if (existsSync(p)) out.push({ path: p, kind: "path", label: `PATH (${dir})` });
    }
  }
  return uniqByPath(out);
}
async function gatherMacCandidates(out, home) {
  addIfExists(out, "/opt/homebrew/bin/python3", "homebrew", "Homebrew (arm64)");
  addIfExists(out, "/usr/local/bin/python3", "homebrew", "Homebrew (x86_64)");
  addIfExists(out, "/usr/bin/python3", "system", "System");
  for (const v of await listDirSafe("/Library/Frameworks/Python.framework/Versions")) {
    if (v === "Current") continue;
    addIfExists(out, `/Library/Frameworks/Python.framework/Versions/${v}/bin/python3`, "framework", `python.org ${v}`);
  }
  const pyenvRoot = process.env.PYENV_ROOT || join(home, ".pyenv");
  for (const v of await listDirSafe(join(pyenvRoot, "versions"))) {
    addIfExists(out, join(pyenvRoot, "versions", v, "bin", "python"), "pyenv", `pyenv:${v}`);
  }
  for (const condaRoot of [
    join(home, "miniforge3"),
    join(home, "anaconda3"),
    join(home, "miniconda3"),
    join(home, "mambaforge")
  ]) {
    addIfExists(out, join(condaRoot, "bin", "python"), "conda", `${basename(condaRoot)}:base`);
    for (const env of await listDirSafe(join(condaRoot, "envs"))) {
      addIfExists(out, join(condaRoot, "envs", env, "bin", "python"), "conda", `${basename(condaRoot)}:${env}`);
    }
  }
}
async function probeVersion(interpreterPath) {
  try {
    const { stdout, stderr } = await pexec(`'${interpreterPath.replace(/'/g, `'\\''`)}' -V`, { timeout: 3e3 });
    const out = (stdout.trim() || stderr.trim()).replace(/^Python\s+/, "");
    return out || null;
  } catch {
    return null;
  }
}
let listCache = null;
const LIST_TTL_MS = 3e4;
async function listInterpreters(force = false) {
  const root = workspace.getRoot();
  if (!force && listCache && listCache.root === root && Date.now() - listCache.ts < LIST_TTL_MS) {
    return listCache.result;
  }
  const candidates = await gatherCandidates();
  const versions = await Promise.all(candidates.map((c) => probeVersion(c.path)));
  const result = candidates.map((c, i) => ({
    path: c.path,
    kind: c.kind,
    label: c.label,
    version: versions[i]
  }));
  listCache = { root, result, ts: Date.now() };
  return result;
}
function selectionPath() {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  return join(root, ".opendev", "python.json");
}
async function getSelectedInterpreter() {
  const root = workspace.getRoot();
  if (!root) return null;
  let selectedPath;
  try {
    const raw = await promises.readFile(selectionPath(), "utf8");
    selectedPath = JSON.parse(raw).path;
  } catch {
  }
  const list = await listInterpreters();
  if (selectedPath) {
    const hit = list.find((i) => i.path === selectedPath);
    if (hit) return hit;
  }
  return list.find((i) => i.kind === "venv") ?? list.find((i) => i.kind === "homebrew") ?? list[0] ?? null;
}
async function setSelectedInterpreter(path) {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  await promises.mkdir(join(root, ".opendev"), { recursive: true });
  await promises.writeFile(selectionPath(), JSON.stringify({ path }, null, 2), "utf8");
  const cur = await getSelectedInterpreter();
  safeSend(IPC.PythonChanged, cur);
  try {
    const lsp$1 = await Promise.resolve().then(() => lsp);
    if (typeof lsp$1.restartPyright === "function") {
      lsp$1.restartPyright();
    }
  } catch (e) {
    console.warn("[python] could not restart pyright:", e.message);
  }
  return cur;
}
async function createVenv(opts) {
  const root = workspace.getRoot();
  if (!root) throw new Error("No workspace open");
  const dirName2 = opts.dirName || ".venv";
  const target = join(root, dirName2);
  if (existsSync(target)) throw new Error(`${dirName2} already exists`);
  safeSend(IPC.PythonVenvLog, `[opendev] $ ${opts.basePython} -m venv ${dirName2}
`);
  const proc = spawn(opts.basePython, ["-m", "venv", dirName2], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const push = (b) => safeSend(IPC.PythonVenvLog, b.toString("utf8"));
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);
  const code = await new Promise((resolve2) => proc.on("exit", (c) => resolve2(c ?? 1)));
  if (code !== 0) throw new Error(`venv creation failed with exit ${code}`);
  listCache = null;
  const newPython = join(target, VENV_BIN, PY_NAMES[0]);
  return setSelectedInterpreter(newPython);
}
function registerPythonIpc() {
  ipcMain.handle(IPC.PythonList, (_e, force) => listInterpreters(!!force));
  ipcMain.handle(IPC.PythonGet, () => getSelectedInterpreter());
  ipcMain.handle(IPC.PythonSet, (_e, path) => setSelectedInterpreter(path));
  ipcMain.handle(IPC.PythonCreateVenv, (_e, opts) => createVenv(opts));
}
function invalidatePythonCache() {
  listCache = null;
}
const python = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  createVenv,
  getSelectedInterpreter,
  invalidatePythonCache,
  listInterpreters,
  registerPythonIpc,
  setSelectedInterpreter
}, Symbol.toStringTag, { value: "Module" }));
const LOG_TAIL = 4e3;
class RunManager {
  // Persisted definitions.
  async storePath() {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    return join(root, ".opendev", "run-configs.json");
  }
  async list() {
    const root = workspace.getRoot();
    if (!root) return [];
    try {
      const raw = await promises.readFile(await this.storePath(), "utf8");
      return JSON.parse(raw).items ?? [];
    } catch {
      return [];
    }
  }
  async save(cfg) {
    const list = await this.list();
    const out = { ...cfg, id: cfg.id || randomUUID() };
    const idx = list.findIndex((c) => c.id === out.id);
    if (idx >= 0) list[idx] = out;
    else list.push(out);
    await this.write(list);
    safeSend(IPC.RunsChanged);
    return out;
  }
  async delete(id) {
    const next = (await this.list()).filter((c) => c.id !== id);
    await this.write(next);
    safeSend(IPC.RunsChanged);
  }
  async write(items) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    await promises.mkdir(join(root, ".opendev"), { recursive: true });
    await promises.writeFile(await this.storePath(), JSON.stringify({ items }, null, 2), "utf8");
  }
  // Live sessions. One run = one ChildProcess. We keep the log as a string
  // buffer (capped) so a panel mount can replay the recent tail.
  sessions = /* @__PURE__ */ new Map();
  liveSessions() {
    return [...this.sessions.values()].map((r) => r.session);
  }
  log(id) {
    return this.sessions.get(id)?.log ?? "";
  }
  // Run a transient (unsaved) configuration. Used by the "Run current file"
  // button so we don't pollute the persisted run-config list with one-off
  // entries every time the user clicks ▶ on a .py file.
  async startAdHoc(spec) {
    return this.startWithConfig({ ...spec, id: `adhoc-${randomUUID()}` });
  }
  async start(configId) {
    const cfg = (await this.list()).find((c) => c.id === configId);
    if (!cfg) throw new Error(`Run config ${configId} not found`);
    return this.startWithConfig(cfg);
  }
  async startWithConfig(cfg) {
    const root = workspace.getRoot();
    if (!root) throw new Error("No workspace open");
    let interpreter = cfg.interpreter;
    if (!interpreter) {
      try {
        const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
        const sel = await getSelectedInterpreter2();
        interpreter = sel?.path;
      } catch {
      }
    }
    if (!interpreter) interpreter = "python3";
    const args = cfg.mode === "module" ? ["-m", cfg.target, ...cfg.args] : [resolveTarget(root, cfg.target), ...cfg.args];
    const cwd = cfg.cwd ? isAbsolute(cfg.cwd) ? cfg.cwd : resolve(root, cfg.cwd) : root;
    const id = randomUUID();
    const session = {
      id,
      configId: cfg.id,
      configName: cfg.name,
      status: "starting",
      startedAt: Date.now()
    };
    let log = `[opendev] $ ${interpreter} ${args.join(" ")}
[opendev] cwd: ${cwd}
`;
    const broadcast2 = () => safeSend(IPC.RunsStatus, session);
    const proc = spawn(interpreter, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", ...cfg.env },
      stdio: ["ignore", "pipe", "pipe"],
      // Detached so SIGTERM hits the whole tree (subprocesses, threads).
      detached: true
    });
    session.pid = proc.pid;
    this.sessions.set(id, { proc, session, log });
    safeSend(IPC.RunsLog, { id, chunk: log });
    const pushLog = (chunk) => {
      try {
        const s = chunk.toString("utf8");
        const entry = this.sessions.get(id);
        if (!entry) return;
        entry.log = (entry.log + s).slice(-LOG_TAIL * 1e3);
        safeSend(IPC.RunsLog, { id, chunk: s });
        if (entry.session.status === "starting") {
          entry.session.status = "running";
          broadcast2();
        }
      } catch {
      }
    };
    proc.stdout?.on("data", pushLog);
    proc.stderr?.on("data", pushLog);
    proc.on("exit", (code, signal) => {
      const entry = this.sessions.get(id);
      if (!entry) return;
      const final = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
      entry.session.status = final;
      entry.session.exitCode = code;
      if (final === "error") entry.session.lastError = signal ? `signal ${signal}` : `exit code ${code}`;
      broadcast2();
    });
    proc.on("error", (err2) => {
      const entry = this.sessions.get(id);
      if (!entry) return;
      entry.session.status = "error";
      entry.session.lastError = err2.message;
      entry.log += `
[spawn error] ${err2.message}
`;
      safeSend(IPC.RunsLog, { id, chunk: `
[spawn error] ${err2.message}
` });
      broadcast2();
    });
    broadcast2();
    return session;
  }
  async stop(id, opts = {}) {
    const entry = this.sessions.get(id);
    if (!entry) return;
    const pid = entry.proc.pid;
    const killGroup = (sig) => {
      try {
        if (pid) process.kill(-pid, sig);
      } catch {
        try {
          entry.proc.kill(sig);
        } catch {
        }
      }
    };
    if (entry.proc.exitCode == null) killGroup("SIGTERM");
    const waitMs = opts.waitMs ?? 3e3;
    await new Promise((res) => {
      if (entry.proc.exitCode != null) return res();
      const t = setTimeout(() => {
        killGroup("SIGKILL");
        res();
      }, waitMs);
      entry.proc.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
  }
  async stopAll(waitMs = 2500) {
    const ids = [...this.sessions.keys()];
    if (ids.length === 0) return;
    console.log(`[runs] stopping ${ids.length} on shutdown`);
    await Promise.all(ids.map((id) => this.stop(id, { waitMs })));
  }
}
function resolveTarget(root, target) {
  if (isAbsolute(target)) return target;
  return resolve(root, target);
}
const runManager = new RunManager();
onShutdown(() => runManager.stopAll());
function registerRunConfigsIpc() {
  ipcMain.handle(IPC.RunConfigsList, () => runManager.list());
  ipcMain.handle(IPC.RunConfigsSave, (_e, cfg) => runManager.save(cfg));
  ipcMain.handle(IPC.RunConfigsDelete, (_e, id) => runManager.delete(id));
  ipcMain.handle(IPC.RunsStart, (_e, configId) => runManager.start(configId));
  ipcMain.handle(IPC.RunsStartAdHoc, (_e, spec) => runManager.startAdHoc(spec));
  ipcMain.handle(IPC.RunsStop, (_e, sessionId) => runManager.stop(sessionId));
  ipcMain.handle(IPC.RunsList, () => runManager.liveSessions());
  ipcMain.handle("runs:log-replay", (_e, id) => runManager.log(id));
}
async function selectedPython() {
  const { getSelectedInterpreter: getSelectedInterpreter2 } = await Promise.resolve().then(() => python);
  const sel = await getSelectedInterpreter2();
  if (!sel) throw new Error("No Python interpreter selected. Pick one from the Python chip in the Project panel.");
  return sel.path;
}
function runPip(py, args, onLine) {
  return new Promise((resolve2) => {
    const proc = spawn(py, ["-m", "pip", "--disable-pip-version-check", ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (b) => {
      const s = b.toString("utf8");
      stdout += s;
      if (onLine) onLine(s);
    });
    proc.stderr?.on("data", (b) => {
      const s = b.toString("utf8");
      stderr += s;
      if (onLine) onLine(s);
    });
    proc.on("exit", (code) => resolve2({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", (err2) => resolve2({ stdout, stderr: stderr + `
[spawn error] ${err2.message}
`, code: 1 }));
  });
}
let busy = false;
function setBusy(v) {
  if (busy === v) return;
  busy = v;
  safeSend(IPC.PipBusy, busy);
}
async function listInstalled() {
  const py = await selectedPython();
  const r = await runPip(py, ["list", "--format=json"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `pip list failed (exit ${r.code})`);
  try {
    const arr = JSON.parse(r.stdout);
    return arr.map((p) => ({ name: p.name, version: p.version, latest: void 0 }));
  } catch (e) {
    throw new Error(`Could not parse pip list output: ${e.message}`);
  }
}
async function listOutdated() {
  const py = await selectedPython();
  const r = await runPip(py, ["list", "--outdated", "--format=json", "--timeout", "10"]);
  if (r.code !== 0) return {};
  try {
    const arr = JSON.parse(r.stdout);
    const out = {};
    for (const p of arr) if (p.latest_version) out[p.name.toLowerCase()] = p.latest_version;
    return out;
  } catch {
    return {};
  }
}
const stream$1 = (chunk) => safeSend(IPC.PipLog, chunk);
async function installSpec(spec) {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream$1(`[opendev] $ ${py} -m pip install ${spec}
`);
    const r = await runPip(py, ["install", spec], stream$1);
    if (r.code !== 0) throw new Error(`pip install failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}
async function uninstall(name) {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream$1(`[opendev] $ ${py} -m pip uninstall -y ${name}
`);
    const r = await runPip(py, ["uninstall", "-y", name], stream$1);
    if (r.code !== 0) throw new Error(`pip uninstall failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}
async function upgrade(name) {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream$1(`[opendev] $ ${py} -m pip install --upgrade ${name}
`);
    const r = await runPip(py, ["install", "--upgrade", name], stream$1);
    if (r.code !== 0) throw new Error(`pip install --upgrade failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}
function parseRequirementName(line) {
  const stripped = line.split("#")[0].trim();
  if (!stripped) return null;
  if (stripped.startsWith("-")) return null;
  if (/^[a-z]+:\/\//i.test(stripped)) return null;
  if (stripped.startsWith("git+")) return null;
  const m = stripped.match(/^([A-Za-z0-9_\-.]+)/);
  return m ? m[1].toLowerCase() : null;
}
async function readRequirements(path) {
  const root = workspace.getRoot();
  if (!root) return null;
  const candidates = path ? [path] : ["requirements.txt", "training/requirements.txt", "requirements/base.txt"].map((p) => join(root, p));
  let target = null;
  let text = null;
  for (const c of candidates) {
    try {
      text = await promises.readFile(c, "utf8");
      target = c;
      break;
    } catch {
    }
  }
  if (!text || !target) return null;
  const installed = await listInstalled().catch(() => []);
  const map = new Map(installed.map((p) => [p.name.toLowerCase(), p.version]));
  const requirements = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = rawLine.split("#")[0].trim();
    if (!stripped) continue;
    const name = parseRequirementName(stripped);
    const version2 = name ? map.get(name) : void 0;
    requirements.push({
      spec: stripped,
      name,
      installed: !!version2,
      installedVersion: version2 || null
    });
  }
  return { path: target, requirements };
}
async function installRequirements(path) {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream$1(`[opendev] $ ${py} -m pip install -r ${path}
`);
    const r = await runPip(py, ["install", "-r", path], stream$1);
    if (r.code !== 0) throw new Error(`pip install -r failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}
function registerPipIpc() {
  ipcMain.handle(IPC.PipList, () => listInstalled());
  ipcMain.handle(IPC.PipOutdated, () => listOutdated());
  ipcMain.handle(IPC.PipInstall, (_e, spec) => installSpec(spec));
  ipcMain.handle(IPC.PipUninstall, (_e, name) => uninstall(name));
  ipcMain.handle(IPC.PipUpgrade, (_e, name) => upgrade(name));
  ipcMain.handle(IPC.PipReadRequirements, (_e, path) => readRequirements(path));
  ipcMain.handle(IPC.PipInstallRequirements, (_e, path) => installRequirements(path));
}
function registerIpc() {
  ipcMain.on("__opendev_version__", (e) => {
    e.returnValue = app.getVersion();
  });
  ipcMain.handle(IPC.WorkspaceCurrent, () => workspace.getRoot());
  ipcMain.handle(IPC.WorkspaceOpen, async (_e, p) => {
    await workspace.open(p);
    return workspace.getRoot();
  });
  ipcMain.handle(IPC.WorkspacePick, async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return null;
    await workspace.open(r.filePaths[0]);
    return workspace.getRoot();
  });
  ipcMain.handle(IPC.WorkspaceClose, () => workspace.close());
  ipcMain.handle(IPC.FsReveal, (_e, p) => {
    shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle(IPC.SettingsGet, () => loadSettings());
  ipcMain.handle(IPC.SettingsSet, (_e, patch) => patchSettings(patch));
  ipcMain.handle(IPC.AppRelaunch, () => {
    app.exit(0);
  });
  ipcMain.handle(IPC.SystemFreeMemory, async () => {
    const { killAllLspServers: killAllLspServers2 } = await Promise.resolve().then(() => lsp);
    const before = process.memoryUsage().rss;
    const lspsKilled = killAllLspServers2();
    await new Promise((r) => setTimeout(r, 250));
    const after = process.memoryUsage().rss;
    return { lspsKilled, mainRssBefore: before, mainRssAfter: after };
  });
  registerFsIpc();
  registerSearchIpc();
  registerLspIpc();
  registerAiIpc();
  registerServicesIpc();
  registerTasksIpc();
  registerPortsIpc();
  registerDbIpc();
  registerGitIpc();
  registerTerminalIpc();
  registerBrowserIpc();
  registerSessionIpc();
  registerToolsIpc();
  registerAgentsIpc();
  registerPeersIpc();
  registerDebugIpc();
  registerProjectsIpc();
  registerPackagesIpc();
  registerHistoryIpc();
  registerRestIpc();
  registerAiLocalIpc();
  registerMlxIpc();
  registerPythonIpc();
  registerRunConfigsIpc();
  registerPipIpc();
  registerLocalModelsIpc();
  registerMcpIpc();
  loadSettings().then((s) => {
    if (s.mcpEnabled === false) {
      console.log("[mcp] disabled via settings — not starting HTTP server");
      return;
    }
    startIdeMcpServer().catch((err2) => console.error("mcp start failed", err2));
  }).catch(() => {
    startIdeMcpServer().catch((err2) => console.error("mcp start failed", err2));
  });
  ipcMain.handle(IPC.WindowPopoutFile, async (_e, path) => {
    const { createPopoutWindow } = await import("./windows.mjs");
    createPopoutWindow(path);
    return true;
  });
  ipcMain.handle(IPC.WindowPopoutAi, async (_e, opts = {}) => {
    const { createPopoutAiWindow } = await import("./windows.mjs");
    createPopoutAiWindow(opts);
    return true;
  });
}
let resolved = false;
function commonBinDirs() {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    join(home, ".nvm", "versions", "node", "current", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".local", "bin")
  ];
}
function dedupePath(parts) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(delimiter);
}
function pathFromLoginShell() {
  const shell2 = process.env.SHELL || "/bin/zsh";
  try {
    const r = spawnSync(shell2, ["-ilc", "echo __ODPATH__$PATH"], {
      timeout: 4e3,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8"
    });
    const stdout = r.stdout ?? "";
    const m = stdout.match(/__ODPATH__(.+)/);
    if (m) return m[1].trim();
  } catch {
  }
  return null;
}
function hydrateShellPath() {
  if (resolved) return;
  resolved = true;
  const original = process.env.PATH ?? "";
  const loginPath = pathFromLoginShell();
  const fallback = commonBinDirs().filter((p) => p && existsSync(p));
  const merged = dedupePath([
    ...loginPath ? loginPath.split(delimiter) : [],
    ...fallback,
    ...original.split(delimiter)
  ]);
  process.env.PATH = merged;
  if (process.env.OPENDEV_VERBOSE === "1") {
    console.log("[shell-env] hydrated PATH:", merged);
  }
}
let stream = null;
function getLogPath() {
  return join(app.getPath("logs"), "main.log");
}
function initFileLogger() {
  try {
    const dir = app.getPath("logs");
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(join(dir, "main.log"), { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
    const wrap = (level, orig) => (...args) => {
      try {
        stream?.write(`[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] ${args.map(stringify).join(" ")}
`);
      } catch {
      }
      try {
        orig(...args);
      } catch {
      }
    };
    console.log = wrap("info", console.log.bind(console));
    console.warn = wrap("warn", console.warn.bind(console));
    console.error = wrap("error", console.error.bind(console));
  } catch {
  }
}
function stringify(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
async function listing(target, filesToo) {
  const home = homedir();
  const settings = await loadSettings().catch(() => ({ recentWorkspaces: [] }));
  const shortcuts = [
    { label: "Home", path: home },
    { label: "Desktop", path: join(home, "Desktop") },
    { label: "Documents", path: join(home, "Documents") },
    ...(settings.recentWorkspaces || []).slice(0, 5).map((p) => ({ label: p.split("/").pop() || p, path: p }))
  ];
  const path = resolve(target || home);
  const parent = path === "/" ? null : dirname(path);
  try {
    const dirents = await promises.readdir(path, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      const isDir = d.isDirectory() || d.isSymbolicLink() && await isDirLink(join(path, d.name));
      if (!isDir && !filesToo) continue;
      entries.push({ name: d.name, path: join(path, d.name), isDir });
    }
    entries.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
    return { path, parent, entries, home, shortcuts };
  } catch (err2) {
    return { path, parent, entries: [], home, shortcuts, error: err2?.message || String(err2) };
  }
}
async function isDirLink(p) {
  try {
    return (await promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
function registerRemoteFilesIpc() {
  ipcMain.handle("web:list-dir", (_e, path, filesToo) => listing(path || homedir(), !!filesToo));
  ipcMain.handle("web:home", () => homedir());
}
const SAMPLE_INTERVAL_MS = 2e3;
let timer = null;
let prevCpu = null;
let lastBroadcast = null;
function snapshotCpu() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}
function computeCpuPct() {
  const cur = snapshotCpu();
  if (!prevCpu) {
    prevCpu = cur;
    return 0;
  }
  const idleDelta = cur.idle - prevCpu.idle;
  const totalDelta = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDelta <= 0) return 0;
  const usage = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(100, Math.round(usage * 1e3) / 10));
}
const isDarwin = platform() === "darwin";
let lastDarwinUsedBytes = null;
let fdLimit = 0;
function probeFdLimit() {
  execFile("/bin/sh", ["-c", "ulimit -Sn"], { timeout: 1500 }, (err2, stdout) => {
    if (err2) return;
    const n = parseInt(String(stdout).trim(), 10);
    if (Number.isFinite(n) && n > 0) fdLimit = n;
  });
}
let gpuCount = 0;
let gpuCores = 0;
function probeGpuInfo() {
  if (!isDarwin) return;
  execFile("/usr/sbin/system_profiler", ["SPDisplaysDataType"], { timeout: 4e3 }, (err2, stdout) => {
    if (err2 || !stdout) return;
    const blocks = stdout.split(/\n(?=\s{4}\S)/);
    let count = 0;
    let cores = 0;
    for (const b of blocks) {
      if (!/^\s+Type:\s+GPU\b/m.test(b)) continue;
      count += 1;
      const m = b.match(/Total Number of Cores:\s+(\d+)/);
      if (m) cores += Number(m[1]);
    }
    gpuCount = count;
    gpuCores = cores;
  });
}
function readFdCount() {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return 0;
  }
}
function refreshDarwinUsedBytes() {
  execFile("/usr/bin/vm_stat", { timeout: 1500 }, (err2, stdout) => {
    if (err2 || !stdout) return;
    const pageMatch = stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
    const read2 = (label) => {
      const m = stdout.match(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m"));
      return m ? Number(m[1]) : 0;
    };
    const wired = read2("Pages wired down");
    const active = read2("Pages active");
    const compressed = read2("Pages occupied by compressor");
    const used = (wired + active + compressed) * pageSize;
    if (Number.isFinite(used) && used > 0) lastDarwinUsedBytes = used;
  });
}
function tick() {
  try {
    const memTotal = totalmem();
    let memUsed;
    if (isDarwin) {
      refreshDarwinUsedBytes();
      memUsed = lastDarwinUsedBytes ?? Math.max(0, memTotal - freemem());
    } else {
      memUsed = Math.max(0, memTotal - freemem());
    }
    const stats = {
      memUsedBytes: memUsed,
      memTotalBytes: memTotal,
      cpuPct: computeCpuPct(),
      loadAvg: loadavg(),
      fdCount: readFdCount(),
      fdLimit,
      gpuCount,
      gpuCores
    };
    lastBroadcast = stats;
    safeSend(IPC.SystemStats, stats);
  } catch {
  }
}
function startSystemStatsBroadcaster() {
  if (timer) return;
  prevCpu = snapshotCpu();
  if (isDarwin) refreshDarwinUsedBytes();
  probeFdLimit();
  probeGpuInfo();
  setTimeout(tick, 250);
  timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);
const PORT = Number(flag("port", process.env.OPENDEV_WEB_PORT || "5199"));
const HOST = flag("host", process.env.OPENDEV_WEB_HOST || "127.0.0.1");
const WEB_ROOT = resolve(flag("web-root", process.env.OPENDEV_WEB_ROOT || join(app.getAppPath(), "out-web", "renderer")));
let TOKEN = "";
async function loadToken() {
  const fromEnvOrFlag = flag("token", process.env.OPENDEV_WEB_TOKEN);
  if (fromEnvOrFlag) return fromEnvOrFlag;
  const tokenFile = join(getStorageDir(), "web-token");
  try {
    const saved = (await promises.readFile(tokenFile, "utf8")).trim();
    if (saved) return saved;
  } catch {
  }
  const fresh = randomBytes(24).toString("hex");
  await promises.writeFile(tokenFile, fresh, { mode: 384 });
  return fresh;
}
function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "od_token") return decodeURIComponent(v.join("="));
  }
  return null;
}
const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
function authed(req, url) {
  const cookie = cookieToken(req);
  if (cookie && timingSafeEqual(cookie, TOKEN)) return "ok";
  const q = url.searchParams.get("token");
  if (q && timingSafeEqual(q, TOKEN)) return "query";
  return "no";
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};
function serveFile(res, file) {
  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    // Hashed asset filenames are immutable; index.html must not be cached or
    // a rebuild leaves stale script tags behind.
    "cache-control": file.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable"
  });
  const stream2 = createReadStream(file);
  stream2.on("error", () => res.end());
  stream2.pipe(res);
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function deny(res, code, message) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>OpenDev Web</title>
<body style="background:#1e1e1e;color:#d4d4d4;font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:48px">
<h2 style="color:#f48771;margin:0 0 8px">${code}</h2><p>${message}</p></body>`);
}
async function main() {
  hydrateShellPath();
  initFileLogger();
  await initStorage();
  TOKEN = await loadToken();
  registerIpc();
  registerRemoteFilesIpc();
  startSystemStatsBroadcaster();
  startMemoryWatchdog();
  const clients = /* @__PURE__ */ new Set();
  setBroadcaster((channel, args) => {
    const frame = JSON.stringify({ t: "ev", ch: channel, args });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(frame);
        } catch {
        }
      }
    }
  });
  const http2 = createServer$1((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const auth = authed(req, url);
    if (auth === "no") {
      deny(res, 401, "Missing or invalid access token. Open the URL printed by <code>npm run web</code>.");
      return;
    }
    if (auth === "query") {
      url.searchParams.delete("token");
      res.writeHead(302, {
        "set-cookie": `od_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        location: url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : ""),
        "cache-control": "no-store"
      });
      res.end();
      return;
    }
    const rel2 = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(WEB_ROOT, rel2);
    if (!file.startsWith(WEB_ROOT)) {
      deny(res, 403, "Forbidden");
      return;
    }
    if (!isFile(file)) file = join(WEB_ROOT, "index.html");
    if (!existsSync(file)) {
      deny(res, 500, "Web bundle not found. Run <code>npm run web:build</code> first.");
      return;
    }
    serveFile(res, file);
  });
  const wss = new WebSocketServer({ noServer: true });
  http2.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/rpc" || authed(req, url) === "no" || !sameOrigin(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ t: "hello", version: app.getVersion(), platform: process.platform }));
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === "call" && msg.ch) {
        try {
          const value = await dispatchInvoke(msg.ch, msg.args || []);
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: true, v: value ?? null }));
        } catch (err2) {
          ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, e: err2?.message || String(err2) }));
        }
        return;
      }
      if (msg.t === "sync" && msg.ch) {
        let value = null;
        try {
          value = dispatchSync(msg.ch, msg.args || []) ?? null;
        } catch {
        }
        ws.send(JSON.stringify({ t: "res", id: msg.id, ok: true, v: value }));
      }
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  http2.listen(PORT, HOST, () => {
    const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
    const url = `http://${shown}:${PORT}/?token=${TOKEN}`;
    console.log("");
    console.log(`  OpenDev Web ${app.getVersion()}`);
    console.log(`  ${url}`);
    console.log(`  serving ${WEB_ROOT}`);
    console.log(`  log ${getLogPath()}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      console.log("");
      console.log("  ! Bound beyond loopback. Anyone who reaches this port and has the");
      console.log("    token gets a shell on this machine. Put it behind a VPN or TLS proxy.");
    }
    console.log("");
    if (hasFlag("open")) {
      import("child_process").then(({ spawn: spawn2 }) => {
        const opener = "open";
        spawn2(opener, [url], { stdio: "ignore", detached: true }).unref();
      });
    }
  });
  let quitting = false;
  const stop = async () => {
    if (quitting) return;
    quitting = true;
    console.log("\nshutting down…");
    const cap = setTimeout(() => process.exit(0), 6e3);
    try {
      await shutdownAll();
    } catch (err2) {
      console.error("shutdown error", err2);
    }
    clearTimeout(cap);
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
      }
    }
    http2.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
function startMemoryWatchdog() {
  let lastLevel = "ok";
  const timer2 = setInterval(() => {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const level = rss > LIMITS.rssCriticalBytes ? "critical" : rss > LIMITS.rssWarnBytes ? "warn" : "ok";
    if (level === lastLevel) return;
    lastLevel = level;
    const mb = (n) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
    if (level !== "ok") console.warn(`[memory ${level}] rss=${mb(rss)}`);
    safeSend(IPC.MemoryWarning, {
      level,
      rss,
      heapUsed,
      heapTotal,
      message: level === "critical" ? `Memory pressure critical (${mb(rss)} RSS). Close some tabs/services or restart the server.` : level === "warn" ? `Memory usage high (${mb(rss)} RSS). Consider closing unused tabs.` : ""
    });
  }, 3e4);
  timer2.unref?.();
}
main().catch((err2) => {
  console.error("[opendev-web] failed to start", err2);
  process.exit(1);
});
export {
  BrowserWindow as B,
  app as a,
  baseName as b
};
