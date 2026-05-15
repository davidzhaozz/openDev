import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  AgentInfo,
  AgentRun,
  AgentRunTarget,
  AgentStreamMsg,
  AddPackageArgs,
  AddPackageResult,
  AppSettings,
  ChatAttachment,
  Conversation,
  CreateProjectArgs,
  CreateProjectResult,
  DetectedProject,
  DbConnectionProfile,
  DbResult,
  DbRowUpdate,
  DbSchema,
  DbUpdateResult,
  DebugEventMsg,
  DebugStartConfig,
  ProjectTemplate,
  FileChange,
  FileNode,
  GitFileStatus,
  GrepHit,
  ListeningPort,
  PeerInfo,
  PeersStatus,
  ServiceDef,
  ServiceRuntime,
  TaskItem,
  WorktreeInfo
} from '../shared/types.js';

const onMap = new Map<string, Set<(...args: any[]) => void>>();
function on(channel: string, cb: (...args: any[]) => void): () => void {
  let set = onMap.get(channel);
  if (!set) { set = new Set(); onMap.set(channel, set); }
  set.add(cb);
  const listener = (_: unknown, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); set!.delete(cb); };
}

// Cheap synchronous read of the bundled package version. process.versions
// is exposed to renderers by Electron's preload; the app version is in
// process.env after the main process sets it via app.setVersion (and is also
// available via the @electron/remote bridge if enabled). We bake it here.
const versionInfo: { version: string } = (() => {
  try {
    const v = process.env.npm_package_version || ipcRenderer.sendSync('__opendev_version__');
    return { version: typeof v === 'string' ? v : '0.0.0' };
  } catch { return { version: '0.0.0' }; }
})();

const api = {
  app: { version: () => versionInfo.version },
  workspace: {
    current: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.WorkspaceCurrent),
    open: (p: string): Promise<string | undefined> => ipcRenderer.invoke(IPC.WorkspaceOpen, p),
    pick: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.WorkspacePick),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.WorkspaceClose),
    onChanged: (cb: (p?: string) => void) => on(IPC.WorkspaceChanged, cb)
  },
  menu: {
    onEvent: (cb: (action: string) => void) => on(IPC.MenuEvent, cb)
  },
  fs: {
    list: (dir?: string): Promise<FileNode[]> => ipcRenderer.invoke(IPC.FsList, dir),
    read: (path: string): Promise<string> => ipcRenderer.invoke(IPC.FsRead, path),
    write: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsWrite, path, content),
    rename: (from: string, to: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsRename, from, to),
    delete: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsDelete, path),
    create: (path: string, isDir: boolean): Promise<boolean> => ipcRenderer.invoke(IPC.FsCreate, path, isDir),
    reveal: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsReveal, path),
    onWatch: (cb: (ev: FileChange) => void) => on(IPC.FsWatchEvent, cb),
    watch: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsWatch, path),
    unwatch: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsUnwatch, path)
  },
  search: {
    fuzzy: (q: string, limit?: number): Promise<Array<{ path: string; score: number; relative?: string }>> =>
      ipcRenderer.invoke(IPC.SearchFuzzy, q, limit),
    grep: (q: string, opts?: { glob?: string; caseSensitive?: boolean }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.SearchGrep, q, opts),
    onHit: (cb: (h: GrepHit) => void) => on(IPC.SearchGrepHit, cb),
    onDone: (cb: () => void) => on(IPC.SearchGrepDone, cb)
  },
  lsp: {
    request: <T = unknown>(method: string, params: unknown): Promise<T | null> =>
      ipcRenderer.invoke(IPC.LspRequest, method, params),
    notify: (method: string, params: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC.LspNotify, method, params),
    onDiagnostics: (cb: (p: any) => void) => on(IPC.LspDiagnostics, cb)
  },
  ai: {
    send: (args: { conversationId?: string; text: string; attachments?: ChatAttachment[]; transport?: 'claude-sdk' | 'claude-cli' | 'openai-sdk' | 'codex-cli' | 'sdk' | 'cli'; context?: unknown }):
      Promise<{ conversationId: string; streamId: string }> => ipcRenderer.invoke(IPC.AiSend, args),
    cancel: (streamId: string): Promise<boolean> => ipcRenderer.invoke(IPC.AiCancel, streamId),
    onStream: (cb: (msg: { streamId: string; chunk?: string; done?: boolean; full?: string }) => void) =>
      on(IPC.AiStream, cb),
    conversations: (): Promise<Conversation[]> => ipcRenderer.invoke(IPC.AiConversations),
    conversation: (id: string): Promise<Conversation | null> => ipcRenderer.invoke(IPC.AiConversationGet, id),
    deleteConversation: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.AiConversationDelete, id)
  },
  mcp: {
    status: (): Promise<{ running: boolean; url?: string; port?: number; error?: string }> => ipcRenderer.invoke(IPC.McpStatus),
    pushEditorSnapshot: (snap: unknown): Promise<boolean> => ipcRenderer.invoke('mcp:editor-snapshot', snap),
    onCommand: (cb: (cmd: { kind: string; path?: string; line?: number; col?: number }) => void) => on('mcp:command', cb)
  },
  browser: {
    screenshot: (rect: { x: number; y: number; width: number; height: number }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.BrowserScreenshotRect, rect)
  },
  services: {
    list: (): Promise<ServiceDef[]> => ipcRenderer.invoke(IPC.ServicesList),
    save: (def: ServiceDef): Promise<ServiceDef> => ipcRenderer.invoke(IPC.ServicesSave, def),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ServicesDelete, id),
    start: (id: string): Promise<ServiceRuntime> => ipcRenderer.invoke(IPC.ServicesStart, id),
    stop: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ServicesStop, id),
    restart: (id: string): Promise<ServiceRuntime> => ipcRenderer.invoke(IPC.ServicesRestart, id),
    deriveFromDir: (absPath: string): Promise<{ name: string; command: string; cwd: string }> =>
      ipcRenderer.invoke(IPC.ServicesDeriveFromDir, absPath),
    statuses: (): Promise<ServiceRuntime[]> => ipcRenderer.invoke(IPC.ServicesStatus),
    log: (id: string): Promise<string> => ipcRenderer.invoke(IPC.ServicesLog, id),
    ports: (): Promise<Record<string, number[]>> => ipcRenderer.invoke(IPC.ServicesPorts),
    onChanged: (cb: () => void) => on(IPC.ServicesChanged, cb),
    onStatus: (cb: (r: ServiceRuntime) => void) => on(IPC.ServicesStatus, cb),
    onLog: (cb: (m: { id: string; chunk: string }) => void) => on(IPC.ServicesLog, cb)
  },
  ports: {
    list: (): Promise<ListeningPort[]> => ipcRenderer.invoke(IPC.PortsList),
    free: (port: number): Promise<{ killed: number[]; error?: string }> => ipcRenderer.invoke(IPC.PortsFree, port)
  },
  tasks: {
    list: (): Promise<TaskItem[]> => ipcRenderer.invoke(IPC.TasksList),
    save: (t: Partial<TaskItem>): Promise<TaskItem> => ipcRenderer.invoke(IPC.TasksSave, t),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.TasksDelete, id)
  },
  db: {
    list: (): Promise<DbConnectionProfile[]> => ipcRenderer.invoke(IPC.DbConnectionsList),
    save: (p: DbConnectionProfile & { password?: string }): Promise<DbConnectionProfile> =>
      ipcRenderer.invoke(IPC.DbConnectionsSave, p),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.DbConnectionsDelete, id),
    connect: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.DbConnect, id),
    test: (p: DbConnectionProfile & { password?: string }): Promise<{ ok: true; serverInfo?: string; viaRelay?: boolean } | { ok: false; error: string; hint?: string }> =>
      ipcRenderer.invoke(IPC.DbTest, p),
    listDatabases: (id: string): Promise<{ databases: string[]; current?: string }> =>
      ipcRenderer.invoke(IPC.DbListDatabases, id),
    switchDatabase: (id: string, dbName: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.DbSwitchDatabase, id, dbName),
    esRequest: (id: string, payload: { method?: string; path?: string; body?: unknown }): Promise<{ status: number; body: any; durationMs: number }> =>
      ipcRenderer.invoke(IPC.DbEsRequest, id, payload),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke(IPC.DbDisconnect, id),
    schema: (id: string): Promise<DbSchema[]> => ipcRenderer.invoke(IPC.DbSchema, id),
    query: (id: string, sql: string): Promise<DbResult> => ipcRenderer.invoke(IPC.DbQuery, id, sql),
    updateRows: (args: { connId: string; schema?: string; table: string; updates: DbRowUpdate[] }): Promise<DbUpdateResult> => ipcRenderer.invoke(IPC.DbUpdateRows, args)
  },
  git: {
    status: (): Promise<GitFileStatus[]> => ipcRenderer.invoke(IPC.GitStatus),
    diff: (path?: string): Promise<string> => ipcRenderer.invoke(IPC.GitDiff, path),
    stage: (paths: string[]): Promise<boolean> => ipcRenderer.invoke(IPC.GitStage, paths),
    unstage: (paths: string[]): Promise<boolean> => ipcRenderer.invoke(IPC.GitUnstage, paths),
    commit: (msg: string): Promise<string> => ipcRenderer.invoke(IPC.GitCommit, msg),
    push: (): Promise<boolean | { error: string }> => ipcRenderer.invoke(IPC.GitPush),
    pull: (): Promise<boolean | { error: string }> => ipcRenderer.invoke(IPC.GitPull),
    branches: (): Promise<any> => ipcRenderer.invoke(IPC.GitBranch),
    checkout: (b: string): Promise<boolean> => ipcRenderer.invoke(IPC.GitCheckout, b),
    branchesAt: (absPath: string): Promise<{ current: string; all: string[] } | { error: string }> =>
      ipcRenderer.invoke(IPC.GitBranchesAt, absPath),
    checkoutAt: (absPath: string, branch: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.GitCheckoutAt, absPath, branch),
    blame: (filePath: string): Promise<{ lines: Array<{ line: number; hash: string; author?: string; date?: string; summary?: string }> } | { error: string }> =>
      ipcRenderer.invoke(IPC.GitBlame, filePath),
    fileLog: (filePath: string, limit?: number): Promise<{ commits: Array<{ hash: string; date: string; message: string; author_name?: string }> } | { error: string }> =>
      ipcRenderer.invoke(IPC.GitFileLog, filePath, limit),
    show: (dir: string, hash: string): Promise<{ diff: string } | { error: string }> =>
      ipcRenderer.invoke(IPC.GitShow, dir, hash),
    log: (limit?: number): Promise<any> => ipcRenderer.invoke(IPC.GitLog, limit),
    worktreeCreate: (opts: { name?: string; branch?: string }): Promise<WorktreeInfo> =>
      ipcRenderer.invoke(IPC.GitWorktreeCreate, opts),
    worktreeList: (): Promise<WorktreeInfo[]> => ipcRenderer.invoke(IPC.GitWorktreeList),
    worktreeRemove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.GitWorktreeRemove, id),
    worktreeMerge: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.GitWorktreeMerge, id)
  },
  term: {
    create: (opts: { cwd?: string; cols?: number; rows?: number }): Promise<{ id: string; cwd: string }> =>
      ipcRenderer.invoke(IPC.TermCreate, opts),
    write: (id: string, data: string): Promise<boolean> => ipcRenderer.invoke(IPC.TermWrite, id, data),
    resize: (id: string, cols: number, rows: number): Promise<boolean> => ipcRenderer.invoke(IPC.TermResize, id, cols, rows),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.TermKill, id),
    onData: (cb: (m: { id: string; data: string }) => void) => on(IPC.TermData, cb),
    onExit: (cb: (m: { id: string; code: number }) => void) => on(IPC.TermExit, cb)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SettingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.SettingsSet, patch)
  },
  agents: {
    list: (): Promise<AgentInfo[]> => ipcRenderer.invoke(IPC.AgentsList),
    create: (args: { name: string; description: string }): Promise<AgentInfo> =>
      ipcRenderer.invoke(IPC.AgentsCreate, args),
    importFrom: (srcPath: string): Promise<AgentInfo> => ipcRenderer.invoke(IPC.AgentsImport, srcPath),
    importPick: (): Promise<AgentInfo | null> => ipcRenderer.invoke(IPC.AgentsImportPick),
    run: (slug: string, target: AgentRunTarget = 'local'): Promise<AgentRun> =>
      ipcRenderer.invoke(IPC.AgentsRun, { slug, target }),
    stop: (runId: string): Promise<boolean> => ipcRenderer.invoke(IPC.AgentsStop, runId),
    delete: (slug: string): Promise<boolean> => ipcRenderer.invoke(IPC.AgentsDelete, slug),
    onStream: (cb: (m: AgentStreamMsg) => void) => on(IPC.AgentStream, cb),
    onChanged: (cb: () => void) => on(IPC.AgentsChanged, cb)
  },
  peers: {
    list: (): Promise<PeerInfo[]> => ipcRenderer.invoke(IPC.PeersList),
    status: (): Promise<PeersStatus> => ipcRenderer.invoke(IPC.PeersStatus),
    setLinkKey: (key: string): Promise<boolean> => ipcRenderer.invoke(IPC.PeersSetLinkKey, key),
    setEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(IPC.PeersSetEnabled, enabled),
    pushRepo: (peerId: string): Promise<boolean> => ipcRenderer.invoke(IPC.PeersPushRepo, peerId),
    onChanged: (cb: () => void) => on(IPC.PeersChanged, cb)
  },
  debug: {
    start: (config: DebugStartConfig): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke(IPC.DebugStart, config),
    request: <T = unknown>(command: string, args?: unknown): Promise<T> =>
      ipcRenderer.invoke(IPC.DebugRequest, command, args),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.DebugStop),
    onEvent: (cb: (e: DebugEventMsg) => void) => on(IPC.DebugEvent, cb)
  },
  projects: {
    list: (): Promise<ProjectTemplate[]> => ipcRenderer.invoke(IPC.ProjectsList),
    create: (args: CreateProjectArgs): Promise<CreateProjectResult> =>
      ipcRenderer.invoke(IPC.ProjectsCreate, args),
    pickDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.ProjectsPickDir),
    onLog: (cb: (line: string) => void) => on(IPC.ProjectsCreateLog, cb)
  },
  packages: {
    detect: (dir: string): Promise<DetectedProject | null> => ipcRenderer.invoke(IPC.PackagesDetect, dir),
    add: (args: AddPackageArgs): Promise<AddPackageResult> => ipcRenderer.invoke(IPC.PackagesAdd, args),
    onLog: (cb: (line: string) => void) => on(IPC.PackagesAddLog, cb)
  },
  window: {
    popoutFile: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.WindowPopoutFile, path)
  },
  tools: {
    check: (): Promise<{ npm: boolean; node: boolean; brew: boolean; git: boolean; npmVersion?: string; nodeVersion?: string }> =>
      ipcRenderer.invoke('tools:check'),
    installNode: (): Promise<{ ok: boolean; output?: string; error?: string }> =>
      ipcRenderer.invoke('tools:install-node'),
    onInstallLog: (cb: (chunk: string) => void) => on('tools:install-log', cb)
  },
  session: {
    save: (state: unknown): Promise<boolean> => ipcRenderer.invoke(IPC.SessionSave, state),
    load: (): Promise<{
      tabs: Array<{ kind: string; path?: string; name?: string; cwd?: string; url?: string; conversationId?: string }>;
      activeIndex?: number;
      rightTab?: 'ai' | 'db' | 'es';
      sqlConnId?: string;
      sqlText?: string;
      esText?: string;
    } | null> => ipcRenderer.invoke(IPC.SessionLoad)
  },
  system: {
    onMemoryWarning: (cb: (m: { level: 'ok' | 'warn' | 'critical'; rss: number; heapUsed: number; heapTotal: number; message: string }) => void) => on(IPC.MemoryWarning, cb)
  }
};

contextBridge.exposeInMainWorld('opendev', api);
export type OpenDevApi = typeof api;
