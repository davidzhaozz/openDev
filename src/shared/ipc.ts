export const IPC = {
  // workspace
  WorkspaceOpen: 'workspace:open',
  WorkspacePick: 'workspace:pick',
  WorkspaceCurrent: 'workspace:current',
  WorkspaceChanged: 'workspace:changed',
  WorkspaceClose: 'workspace:close',
  MenuEvent: 'menu:event',
  // The application menu is invisible on the frameless (non-macOS) chrome —
  // Windows renders a menu bar into the native frame, and there isn't one.
  // These let the renderer draw the bar itself and pop the real submenus,
  // so there is still exactly one menu definition.
  MenuTopLevel: 'menu:top-level',
  MenuPopup: 'menu:popup',

  // fs
  FsList: 'fs:list',
  FsRead: 'fs:read',
  FsWrite: 'fs:write',
  FsRename: 'fs:rename',
  FsDelete: 'fs:delete',
  FsCreate: 'fs:create',
  FsReveal: 'fs:reveal',
  FsWatchEvent: 'fs:watch-event',
  FsWatch: 'fs:watch',
  FsUnwatch: 'fs:unwatch',
  // Per-open-file change detection (editor reload-on-disk-change).
  FsWatchFile: 'fs:watch-file',
  FsUnwatchFile: 'fs:unwatch-file',
  FsFileChanged: 'fs:file-changed',

  // search
  SearchFuzzy: 'search:fuzzy',
  SearchGrep: 'search:grep',
  SearchGrepHit: 'search:grep-hit',
  SearchGrepDone: 'search:grep-done',

  // lsp
  LspRequest: 'lsp:request',
  LspNotify: 'lsp:notify',
  LspDiagnostics: 'lsp:diagnostics',

  // ai
  AiSend: 'ai:send',
  AiStream: 'ai:stream',
  AiActivity: 'ai:activity',
  AiConversations: 'ai:conversations',
  AiConversationGet: 'ai:conversation-get',
  AiConversationDelete: 'ai:conversation-delete',
  AiConversationRename: 'ai:conversation-rename',
  AiCancel: 'ai:cancel',
  AiLocalListModels: 'ai-local:list-models',
  AiLocalPickBinary: 'ai-local:pick-binary',

  // Claude account (Settings -> AI). The IDE's AI children run against a
  // pinned credential store (see cliChildEnv), so signing in has to happen
  // against that same store — these drive `claude auth` there rather than in
  // whatever account a terminal tab or shell profile would pick up.
  AiAuthStatus: 'ai-auth:status',
  AiAuthLoginStart: 'ai-auth:login-start',
  AiAuthLoginSubmit: 'ai-auth:login-submit',
  AiAuthLoginCancel: 'ai-auth:login-cancel',
  AiAuthLogout: 'ai-auth:logout',
  AiAuthLoginEvent: 'ai-auth:login-event',
  AiAuthOpenUrl: 'ai-auth:open-url',

  // mcp
  McpStatus: 'mcp:status',
  McpRestart: 'mcp:restart',
  McpRegenerateKey: 'mcp:regenerate-key',

  // app lifecycle
  AppRelaunch: 'app:relaunch',

  // browser
  BrowserScreenshotRect: 'browser:screenshot-rect',
  BrowserCaptureReady: 'browser:capture-ready',
  BrowserPicked: 'browser:picked',
  BrowserClockGet: 'browser:clock-get',
  BrowserClockSet: 'browser:clock-set',
  BrowserClockSync: 'browser:clock-sync',

  // services
  ServicesList: 'services:list',
  ServicesSave: 'services:save',
  ServicesDelete: 'services:delete',
  ServicesStart: 'services:start',
  ServicesStop: 'services:stop',
  ServicesRestart: 'services:restart',
  ServicesDeriveFromDir: 'services:derive-from-dir',
  ServicesStatus: 'services:status',
  ServicesLog: 'services:log',
  ServicesPorts: 'services:ports',
  ServicesChanged: 'services:changed',

  // ports
  PortsList: 'ports:list',
  PortsFree: 'ports:free',

  // tasks
  TasksList: 'tasks:list',
  TasksSave: 'tasks:save',
  TasksDelete: 'tasks:delete',

  // jira
  JiraList: 'jira:list',
  JiraAdd: 'jira:add',
  JiraRemove: 'jira:remove',
  JiraRefresh: 'jira:refresh',
  JiraSearch: 'jira:search',
  JiraStart: 'jira:start',
  JiraStop: 'jira:stop',
  JiraLog: 'jira:log',
  JiraTestConnection: 'jira:test-connection',
  // slack bridge
  SlackStatus: 'slack:status',
  SlackTest: 'slack:test',
  SlackStatusChanged: 'slack:status-changed',
  JiraConfigured: 'jira:configured',
  JiraBoards: 'jira:boards',
  JiraSelectBoard: 'jira:select-board',
  JiraCreateBoard: 'jira:create-board',
  JiraRenameBoard: 'jira:rename-board',
  // main → renderer
  JiraChanged: 'jira:changed',
  JiraLogChunk: 'jira:log-chunk',

  // db
  DbConnectionsList: 'db:connections-list',
  DbConnectionsSave: 'db:connections-save',
  DbConnectionsDelete: 'db:connections-delete',
  DbConnect: 'db:connect',
  DbTest: 'db:test',
  DbListDatabases: 'db:list-databases',
  DbSwitchDatabase: 'db:switch-database',
  DbEsRequest: 'db:es-request',
  DbDisconnect: 'db:disconnect',
  DbSchema: 'db:schema',
  DbQuery: 'db:query',
  DbUpdateRows: 'db:update-rows',

  // git
  PasswordsStatus: 'passwords:status',
  PasswordsList: 'passwords:list',
  PasswordsForOrigin: 'passwords:for-origin',
  PasswordsSave: 'passwords:save',
  PasswordsDelete: 'passwords:delete',
  PasswordsNeverSave: 'passwords:never-save',
  PasswordsAllowSave: 'passwords:allow-save',

  GitStatus: 'git:status',
  GitDiff: 'git:diff',
  GitStage: 'git:stage',
  GitUnstage: 'git:unstage',
  GitCommit: 'git:commit',
  GitPush: 'git:push',
  GitPull: 'git:pull',
  GitBranch: 'git:branch',
  GitCheckout: 'git:checkout',
  GitBranchesAt: 'git:branches-at',
  GitCheckoutAt: 'git:checkout-at',
  GitLog: 'git:log',
  GitBlame: 'git:blame',
  GitFileLog: 'git:file-log',
  GitShow: 'git:show',
  GitFileAt: 'git:file-at',
  SessionSave: 'session:save',
  SessionLoad: 'session:load',
  WindowPopoutFile: 'window:popout-file',
  WindowPopoutAi: 'window:popout-ai',
  // Frameless-window controls. macOS draws its own traffic lights over the
  // titlebar; every other platform gets buttons the renderer draws and these
  // channels drive.
  WindowMinimize: 'window:minimize',
  WindowMaximizeToggle: 'window:maximize-toggle',
  WindowClose: 'window:close',
  WindowSetOverlayColors: 'window:set-overlay-colors',
  WindowMaximizedChanged: 'window:maximized-changed',
  GitWorktreeCreate: 'git:worktree-create',
  GitWorktreeList: 'git:worktree-list',
  GitWorktreeRemove: 'git:worktree-remove',
  GitWorktreeMerge: 'git:worktree-merge',

  // terminal
  TermCreate: 'term:create',
  TermWrite: 'term:write',
  TermResize: 'term:resize',
  TermKill: 'term:kill',
  TermData: 'term:data',
  TermExit: 'term:exit',

  // settings
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',

  // ai agents
  AgentsList: 'agents:list',
  AgentsCreate: 'agents:create',
  AgentsImport: 'agents:import',
  AgentsImportPick: 'agents:import-pick',
  AgentsRun: 'agents:run',
  AgentsStop: 'agents:stop',
  AgentsDelete: 'agents:delete',
  AgentStream: 'agents:stream',     // main → renderer
  AgentsChanged: 'agents:changed',  // main → renderer

  // lan peers
  PeersList: 'peers:list',
  PeersStatus: 'peers:status',
  PeersSetLinkKey: 'peers:set-link-key',
  PeersSetEnabled: 'peers:set-enabled',
  PeersPushRepo: 'peers:push-repo',
  PeersChanged: 'peers:changed',    // main → renderer

  // debugger
  DebugStart: 'debug:start',
  DebugRequest: 'debug:request',
  DebugStop: 'debug:stop',
  DebugEvent: 'debug:event',        // main → renderer

  // new-project wizard
  ProjectsList: 'projects:list',
  ProjectsCreate: 'projects:create',
  ProjectsCreateLog: 'projects:create-log',  // main → renderer (progress)
  ProjectsPickDir: 'projects:pick-dir',

  // add-package wizard
  PackagesDetect: 'packages:detect',
  PackagesAdd: 'packages:add',
  PackagesAddLog: 'packages:add-log',     // main → renderer (progress)

  // query history (sql + es + rest)
  HistoryRead: 'history:read',
  HistoryAppend: 'history:append',
  HistoryClear: 'history:clear',

  // rest client
  RestSend: 'rest:send',
  RestListSaved: 'rest:list-saved',
  RestSave: 'rest:save',
  RestDelete: 'rest:delete',
  RestBrowserTokens: 'rest:browser-tokens',
  RestBrowserTokenReveal: 'rest:browser-token-reveal',
  RestChanged: 'rest:changed',              // main → renderer (collection mutated)

  // run configurations (PyCharm-style)
  RunConfigsList: 'run-configs:list',
  RunConfigsSave: 'run-configs:save',
  RunConfigsDelete: 'run-configs:delete',
  RunsStart: 'runs:start',
  RunsStartAdHoc: 'runs:start-adhoc',
  RunsStop: 'runs:stop',
  RunsList: 'runs:list',
  RunsLog: 'runs:log',                  // main → renderer (stdout/stderr chunk)
  RunsStatus: 'runs:status',            // main → renderer (state change)
  RunsChanged: 'runs:changed',          // main → renderer (config list mutated)

  // local LLM models (mlx_lm.server). Ollama support was removed in
  // v0.6.22 — users who run ollama can point any OpenAI-compat client at
  // it directly; the IDE focuses on what it can drive end-to-end.
  LlmMlxStart: 'llm:mlx-start',
  LlmMlxStop: 'llm:mlx-stop',
  LlmMlxStatus: 'llm:mlx-status',
  LlmMlxStatusChanged: 'llm:mlx-status-changed',         // main → renderer
  LlmMlxLog: 'llm:mlx-log',                              // main → renderer

  // pip / python packages
  PipList: 'pip:list',
  PipOutdated: 'pip:outdated',
  PipInstall: 'pip:install',
  PipUninstall: 'pip:uninstall',
  PipUpgrade: 'pip:upgrade',
  PipReadRequirements: 'pip:read-requirements',
  PipInstallRequirements: 'pip:install-requirements',
  PipLog: 'pip:log',                       // main → renderer (streaming pip output)
  PipBusy: 'pip:busy',                     // main → renderer (true while an operation runs)

  // python interpreter
  PythonList: 'python:list',
  PythonGet: 'python:get',
  PythonSet: 'python:set',
  PythonCreateVenv: 'python:create-venv',
  PythonVenvLog: 'python:venv-log',         // main → renderer (venv creation log lines)
  PythonChanged: 'python:changed',          // main → renderer (selected interpreter changed)

  // mlx / ml project
  MlxDetect: 'mlx:detect',
  MlxListAdapters: 'mlx:list-adapters',
  MlxReadLog: 'mlx:read-log',
  MlxStart: 'mlx:start',
  MlxStop: 'mlx:stop',
  MlxStatus: 'mlx:status',
  MlxEvent: 'mlx:event',                  // main → renderer (parsed training events)

  // network log. The list carries summaries only; bodies are pulled one row
  // at a time so a few hundred captured calls don't sit in renderer memory.
  NetworkList: 'network:list',
  NetworkGet: 'network:get',
  NetworkClear: 'network:clear',
  NetworkSetCapture: 'network:set-capture',
  NetworkCaptureState: 'network:capture-state',
  NetworkEntry: 'network:entry',       // main → renderer (new or updated row)
  NetworkCleared: 'network:cleared',   // main → renderer

  // screen recorder. The video never crosses IPC in one piece — main opens
  // the output file up front and the renderer appends MediaRecorder chunks
  // as they arrive, so a long capture costs no renderer memory.
  RecorderSources: 'recorder:sources',
  RecorderStart: 'recorder:start',
  RecorderChunk: 'recorder:chunk',
  RecorderFinish: 'recorder:finish',
  RecorderCancel: 'recorder:cancel',

  // memory watchdog (main → renderer)
  MemoryWarning: 'memory:warning',

  // system stats (main → renderer, broadcast every ~2s)
  SystemStats: 'system:stats',
  // explicit memory-reclaim trigger from the UI
  SystemFreeMemory: 'system:free-memory'
} as const;

export type IpcChannel = typeof IPC[keyof typeof IPC];
