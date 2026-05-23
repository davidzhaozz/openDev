export const IPC = {
  // workspace
  WorkspaceOpen: 'workspace:open',
  WorkspacePick: 'workspace:pick',
  WorkspaceCurrent: 'workspace:current',
  WorkspaceChanged: 'workspace:changed',
  WorkspaceClose: 'workspace:close',
  MenuEvent: 'menu:event',

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
  AiConversations: 'ai:conversations',
  AiConversationGet: 'ai:conversation-get',
  AiConversationDelete: 'ai:conversation-delete',
  AiCancel: 'ai:cancel',
  AiLocalListModels: 'ai-local:list-models',
  AiLocalPickBinary: 'ai-local:pick-binary',

  // mcp
  McpStatus: 'mcp:status',

  // browser
  BrowserScreenshotRect: 'browser:screenshot-rect',
  BrowserPicked: 'browser:picked',

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
  SessionSave: 'session:save',
  SessionLoad: 'session:load',
  WindowPopoutFile: 'window:popout-file',
  WindowPopoutAi: 'window:popout-ai',
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

  // memory watchdog (main → renderer)
  MemoryWarning: 'memory:warning'
} as const;

export type IpcChannel = typeof IPC[keyof typeof IPC];
