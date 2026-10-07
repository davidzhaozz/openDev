export type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
  gitInfo?: { repoName?: string; branch?: string };
};

export type FileChange = {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
};

export type TabInfo = {
  id: string;
  path: string;
  name: string;
  modified: boolean;
};

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export type Diagnostic = {
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string | number;
};

export type GrepHit = {
  /** Generation of the search that produced it; lets a stale stream be dropped. */
  token?: string;
  path: string;
  line: number;
  col: number;
  preview: string;
};

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatAttachment =
  | { kind: 'selection'; path: string; range: { from: number; to: number }; text: string }
  | { kind: 'picked-element'; cssPath: string; outerHTML: string; styles: Record<string, string>; screenshotDataUrl?: string }
  | { kind: 'file'; name: string; mimeType: string; size: number; text?: string; dataUrl?: string };

export type ChatProvider = 'claude' | 'codex' | 'opencode';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  attachments?: ChatAttachment[];
  createdAt: number;
  // Which AI produced this assistant message. Set at write time and never
  // mutated — so the chat history keeps the original provider label even
  // when the user later switches the composer to a different transport.
  provider?: ChatProvider;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  // Set only on list summaries, whose `messages` is left empty.
  messageCount?: number;
  workspaceRoot?: string;
  // Claude Code CLI session id captured from the first stream-json `init`
  // event. Reusing it on subsequent turns via `--resume <id>` lets the AI
  // keep context — answer follow-up questions, refer to earlier proposals,
  // etc. — instead of starting fresh each message.
  claudeSessionId?: string;
};

export type ServiceDef = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  port?: number;
  url?: string;
};

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error';

export type ServiceRuntime = {
  id: string;
  status: ServiceStatus;
  pid?: number;
  startedAt?: number;
  lastError?: string;
};

export type ListeningPort = {
  port: number;
  pid: number;
  command: string;
  protocol: 'tcp' | 'udp';
};

export type TaskItem = {
  id: string;
  title: string;
  done: boolean;
  notes?: string;
  createdAt: number;
};

/* ------------------------------------------------------------------- jira */

/** Lifecycle of the AI run attached to a ticket. */
export type JiraRunState = 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'stopped';

/** The fields we pull from Atlassian. `description` is flattened out of ADF. */
export type JiraIssueRef = {
  key: string;              // BYZ-89
  title: string;            // Jira `summary`
  status?: string;          // Jira status name, e.g. "In Progress"
  issueType?: string;
  priority?: string;
  assignee?: string;
  url?: string;             // browse link
  description?: string;     // plain text, fed to the model
  fetchedAt?: number;
};

/** A ticket parked in the JIRA panel, plus the state of its AI run. */
export type JiraTask = JiraIssueRef & {
  id: string;
  addedAt: number;
  state: JiraRunState;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Last meaningful line of run output — the "↳ writing X" line in the UI. */
  lastLine?: string;
  /** Set once we've posted the completion comment, so a rerun doesn't double-post. */
  reportedAt?: number;
  reportError?: string;
};

/**
 * One ticket board — a `jira*.json` file in `.opendev` the panel can load.
 * A workspace usually has several, one per parent ticket.
 */
export type JiraBoard = {
  file: string;    // "jira-accounting-byz89.json"
  label: string;   // "accounting-byz89", or "jira" for the default board
  count: number;   // tickets parked in it
  active: boolean; // the board the panel is currently working in
};

/** What the model is asked to produce, and what gets posted back to Jira. */
export type JiraReport = {
  summary: string;
  testing: string;
};

export type DbDriver = 'mysql' | 'postgres' | 'elasticsearch';

export type DbConnectionProfile = {
  id: string;
  name: string;
  driver: DbDriver;
  host: string;
  port: number;
  user: string;
  database?: string;
  readOnly?: boolean;
  ssl?: boolean;             // ES/OpenSearch: use https
  allowSelfSigned?: boolean; // ES/OpenSearch: accept self-signed TLS
};

export type DbColumn = { name: string; type: string; nullable: boolean; key?: string };
export type DbTable = { name: string; type: 'table' | 'view'; columns: DbColumn[] };
export type DbSchema = { name: string; tables: DbTable[] };
export type DbResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  truncated?: boolean;
};

// Used by the editable row grid. Each entry is one row-level UPDATE:
// SET the `set` columns where the `where` columns match.
export type DbRowUpdate = {
  where: Record<string, unknown>;
  set: Record<string, unknown>;
};
export type DbUpdateResult = {
  applied: number;
  errors: Array<{ index: number; message: string }>;
};

export type GitFileStatus = {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
};

export type WorktreeInfo = {
  id: string;
  path: string;
  branch: string;
  createdAt: number;
  devPort?: number;
};

export type AppSettings = {
  workspaceRoot?: string;
  recentWorkspaces: string[];
  anthropicApiKey?: string;
  claudeCliPath?: string;
  openaiApiKey?: string;
  codexCliPath?: string;
  openaiModel?: string;
  anthropicModel?: string;
  theme: 'dark' | 'light';
  themeId?: string;             // preset id from themes.ts
  displayFontSize?: number;     // pt for general UI, default 12
  editorFontSize?: number;      // pt for code editor, default 13
  displayFontFamily?: string;   // CSS font-family list for UI
  editorFontFamily?: string;    // CSS font-family list for editor/terminal (monospace)
  windowOpacity?: number;       // 0..1 background opacity (1 = solid, 0.1 = mostly see-through). Text remains solid.
  fontColor?: string;           // hex for foreground text (UI + editor default)
  // LAN machine-linking (see peers.ts). linkKey is the shared secret two
  // machines must match to discover + trust each other; it is never sent
  // on the wire in cleartext (only HMAC'd). Linking is opt-in.
  linkKey?: string;
  linkingEnabled?: boolean;

  // Local AI (OpenCode CLI). When enabled, the AIChat transport dropdown
  // adds "OpenCode (local)" and uses the configured binary + base URL +
  // model. OpenCode itself reads ~/.config/opencode/config.toml; these
  // fields are passed as --base-url / --model / --api-key overrides on
  // every invocation, so the IDE's setting is authoritative.
  aiLocalEnabled?: boolean;
  aiLocalBinPath?: string;       // absolute path to the opencode binary, or "opencode" to use PATH
  aiLocalBaseUrl?: string;       // OpenAI-compatible endpoint, e.g. http://localhost:11434/v1
  aiLocalModel?: string;         // e.g. "llama3:8b", "qwen2.5-coder:14b"
  aiLocalApiKey?: string;        // optional — Ollama doesn't need one

  // Sticky transport pick — last AI provider the user selected in the
  // chat composer dropdown. Restored when a fresh chat tab opens so we
  // don't keep snapping back to Claude after each session restart.
  lastAiTransport?: 'claude-cli' | 'codex-cli' | 'opencode-cli';
  // Sticky Claude Code model + reasoning effort picks from the composer.
  // Passed as `--model` / `--effort`; empty = let the CLI use its default.
  claudeCliModel?: string;
  claudeCliEffort?: string;
  // Let the chat use claude.ai connector tools that act as you outside the
  // IDE — sending email / Slack messages, forwarding, deleting, calendar
  // changes. Off by default: reading and drafting are always allowed.
  aiAllowOutbound?: boolean;

  // MCP HTTP server (127.0.0.1:53825) that lets an external Claude/Codex
  // CLI introspect IDE state. Default on for the standard workflow;
  // memory-constrained users (e.g. about to start MLX training) can flip
  // it off to reclaim ~20-30 MB without losing in-app AI chat.
  mcpEnabled?: boolean;
  // Bind the MCP server on 0.0.0.0 instead of 127.0.0.1 so other machines
  // on the LAN can reach it. Non-loopback clients must present
  // `Authorization: Bearer <mcpAccessKey>` to call tools. Default false.
  mcpExposeOnLan?: boolean;
  // Bearer token for remote MCP clients. Auto-generated on first MCP
  // start; user can rotate it from Settings → AI. Loopback clients
  // bypass auth (the local IDE chat needs no token).
  mcpAccessKey?: string;

  // Atlassian Jira Cloud. The panel pulls real issues over the REST API and
  // posts a completion comment back when an AI run finishes. Token is a Jira
  // API token (id.atlassian.com → Security → API tokens), not a password.
  jiraSite?: string;            // "byz.atlassian.net" or the full https URL
  jiraEmail?: string;           // Atlassian account email (Basic auth user)
  jiraApiToken?: string;
  jiraJql?: string;             // default issue query for the Refresh button
  // Status the ticket is moved to when its run finishes. Matched against the
  // issue's available transitions by name, case-insensitively.
  jiraDoneStatus?: string;      // default "In Progress"
  // Which board file (`.opendev/jira*.json`) the JIRA panel is working in,
  // keyed by workspace root. Kept here rather than in the board file so the
  // files themselves stay plain ticket lists that can be committed.
  jiraBoards?: Record<string, string>;

  // Slack bridge: a Socket Mode app (no public URL) that relays DMs to the
  // IDE chat and posts replies + notifications back. Only messages from
  // slackUserId are acted on — the chat runs tools without approval, so the
  // bot answers to exactly one person.
  slackEnabled?: boolean;
  slackAppToken?: string;       // xapp-… (connections:write), opens the socket
  slackBotToken?: string;       // xoxb-…, posts and updates messages
  slackUserId?: string;         // your Slack member ID, e.g. U012AB3CD
  slackNotifyAi?: boolean;      // long AI turns started in the IDE (default on)
  slackNotifyServices?: boolean; // a service crashing (default on)
  slackNotifyJira?: boolean;    // a Jira ticket run finishing (default on)

  // Modifier+click chords that trigger LSP navigation in the editor.
  // Values: 'meta' (⌘/Ctrl), 'ctrl' (literal Control on Mac), 'alt' (⌥),
  // 'meta+shift', 'ctrl+shift', 'alt+shift'. The mouse-click itself is
  // implicit. Defaults: gotoDef = meta, findRef = meta+shift.
  editorGotoDefChord?: string;
  editorFindRefChord?: string;
};

/** Slack bridge connection state, for the Settings tab. */
export type SlackStatus = {
  state: 'off' | 'unconfigured' | 'connecting' | 'connected' | 'error';
  detail?: string;
};

// ── AI Agents ──────────────────────────────────────────────────────────
// An "agent" is a self-contained Node.js app stored per-workspace at
// .opendev/agents/<slug>/ that operates on the workspace codebase.

export type AgentRuntime = 'node' | 'tsx';
export type AgentCreatedBy = 'ai' | 'import' | 'builtin';

// .opendev/agents/<slug>/agent.json
export type AgentManifest = {
  slug: string;
  name: string;
  description: string;
  entry: string;             // path relative to the agent folder, e.g. "index.js"
  runtime: AgentRuntime;     // node => .js/.mjs ; tsx => .ts
  createdBy: AgentCreatedBy;
  createdAt: number;
};

// What agents.list() returns — the manifest plus the absolute folder path.
export type AgentInfo = AgentManifest & { dir: string };

export type AgentRunStatus = 'running' | 'stopped' | 'error';

// 'local' runs in this process; any other string is a peerId (Milestone 3).
export type AgentRunTarget = 'local' | string;

export type AgentRun = {
  runId: string;
  agentSlug: string;
  streamId: string;          // channel key the renderer filters AgentStream on
  status: AgentRunStatus;
  startedAt: number;
  exitCode?: number;
  target: AgentRunTarget;
};

// Stream event payload (main -> renderer) over IPC.AgentStream.
export type AgentStreamMsg = {
  streamId: string;
  chunk?: string;            // stdout/stderr text
  done?: boolean;            // process exited
  status?: AgentRunStatus;   // sent with done
  exitCode?: number;
};

// ── LAN peers ──────────────────────────────────────────────────────────

export type PeerInfo = {
  machineId: string;
  name: string;
  address: string;
  httpPort: number;
  lastSeen: number;
  online: boolean;
};

export type PeersStatus = {
  machineId: string;
  machineName: string;
  linkingEnabled: boolean;
  hasLinkKey: boolean;
  httpPort?: number;
};

// ── Debugger ───────────────────────────────────────────────────────────
// A protocol-agnostic vocabulary the renderer consumes. NodeDebugSession
// (CDP) and JavaDebugSession (JDWP) both translate into these shapes.

export type DebugLang = 'node' | 'java' | 'python';
export type DebugStatus = 'starting' | 'running' | 'paused' | 'terminated';

export type StackFrame = {
  id: string;            // opaque frame id (CDP callFrameId, etc.)
  name: string;          // function / method name
  path?: string;         // absolute source path, if resolvable
  line: number;          // 1-indexed
  col: number;           // 1-indexed
};

export type Scope = {
  name: string;          // "Local", "Closure", "Global", …
  varsRef: string;       // opaque ref to expand via getVariables
  expensive?: boolean;
};

export type DebugVar = {
  name: string;
  value: string;
  type?: string;
  varsRef?: string;      // present when the value is expandable
};

export type DebugStartConfig =
  | { lang: 'node'; file: string }                                              // M1: debug a JS file
  | { lang: 'java'; serviceId: string }                                         // M2: debug a Maven/Gradle service
  | { lang: 'python'; file: string; args?: string[]; interpreter?: string };    // M3: debug a Python file via debugpy

export type DebugEventMsg =
  | { kind: 'session-started'; sessionId: string; lang: DebugLang }
  | { kind: 'paused'; reason: string; threadId: number; frames: StackFrame[] }
  | { kind: 'resumed' }
  | { kind: 'output'; category: 'stdout' | 'stderr'; text: string }
  | { kind: 'breakpoint-resolved'; path: string; line: number; verified: boolean }
  | { kind: 'terminated'; exitCode: number | null };

// ── New-project wizard ────────────────────────────────────────────────
// Each template lives in src/main/projects.ts and either writes inline
// files to disk or shells out to a CLI (npm create vite, dotnet new …).

export type ProjectTemplate = {
  id: string;
  language: string;             // 'JavaScript' | 'TypeScript' | 'Java' | 'C#'
  framework: string;            // 'Plain', 'Express Web API', 'Spring Boot', …
  description: string;
  // Hint for the wizard about extra steps the user will need to do.
  postCreate?: string;          // e.g. "Run `npm install` then `npm start`."
  requires?: string;            // e.g. "Requires the `dotnet` CLI on PATH."
};

export type CreateProjectArgs = {
  templateId: string;
  destinationDir: string;       // parent directory the project folder is created INSIDE
  projectName: string;          // becomes the folder name
};

export type CreateProjectResult = {
  ok: boolean;
  projectPath?: string;         // absolute path to the created project folder
  error?: string;
  // Set when a required CLI is missing — the modal uses this to offer an
  // "Install X for me" button.
  errorCode?: 'MISSING_TOOL';
  missingTool?: string;         // 'dotnet' | 'mvn' | 'tsx' | 'node' | …
};

// Tools the IDE knows how to install via brew.
export type InstallableTool = 'node' | 'dotnet' | 'mvn' | 'java' | 'tsx';
export type ToolInstallResult = {
  ok: boolean;
  error?: string;
};

// Add-package wizard.
export type PackageProjectType = 'maven' | 'dotnet';

export type DetectedProject = {
  type: PackageProjectType;
  // For dotnet, the .csproj file path; for maven, the pom.xml path.
  projectFile: string;
  // Display label, e.g. "Maven (pom.xml)" or "WebApp.csproj".
  label: string;
};

export type AddPackageArgs = {
  projectDir: string;
  type: PackageProjectType;
  // Maven: "groupId:artifactId" or "groupId:artifactId:version".
  // .NET: "PackageName" (NuGet package id), with `version` optional.
  packageId: string;
  version?: string;
};

export type AddPackageResult = {
  ok: boolean;
  error?: string;
};

// ── Query history ─────────────────────────────────────────────────────
// Persistent per-workspace history for the SQL and ES workspaces. Saved
// to .opendev/<key>-history.json (key='sql'|'es'), capped to the most
// recent N entries.

export type QueryHistoryKind = 'sql' | 'es' | 'rest';

export type QueryHistoryEntry = {
  id: string;
  text: string;            // the full query / request
  runAt: number;           // epoch ms
  ok: boolean;             // false if the run errored
  durationMs?: number;
  rowCount?: number;       // SQL
  status?: number;         // ES/REST HTTP status
  connId?: string;         // connection used (SQL/ES); for REST this carries the saved request id when applicable
  esMethod?: string;       // ES — for the dropdown preview
  esPath?: string;
  restMethod?: string;     // REST — for the dropdown preview
  restUrl?: string;
};

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export type RestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RestAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string }
  // Borrow the bearer token the browser panel last sent. Resolved in main at
  // send time, so the saved request never holds the token and keeps working
  // after the app refreshes it. `origin` pins one API host; omitted = match
  // the request URL's origin, falling back to the most recent capture.
  | { kind: 'browser'; origin?: string };

export type RestHeader = { key: string; value: string; enabled?: boolean };
export type RestParam = { key: string; value: string; enabled?: boolean };

export type RestBody =
  | { kind: 'none' }
  | { kind: 'json'; text: string }
  | { kind: 'text'; text: string; contentType?: string }
  | { kind: 'form'; fields: Array<{ key: string; value: string; enabled?: boolean }> };

export type RestRequestSpec = {
  method: RestMethod;
  url: string;
  headers: RestHeader[];
  params: RestParam[];
  body: RestBody;
  auth: RestAuth;
  /** Documentation only — what the endpoint does. Never sent. */
  description?: string;
};

export type RestSavedRequest = RestRequestSpec & {
  id: string;
  name: string;
  folder?: string;
  updatedAt: number;
};

/** A bearer token seen in the browser panel's traffic or storage. */
export type BrowserTokenInfo = {
  /** Origin of the API the token was sent to (or the page, for storage hits). */
  origin: string;
  /** Last URL it was seen on. */
  url: string;
  seenAt: number;
  source: 'header' | 'storage';
  /** First/last few characters only — the raw token stays in main. */
  preview: string;
  /** JWT `exp` in ms, when the token is a decodable JWT. */
  expiresAt?: number;
};

export type RestResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;           // raw text; renderer pretty-prints JSON when content-type allows
  contentType?: string;
  durationMs: number;
  sizeBytes: number;
  url: string;            // final URL after query-string assembly
};

export type RestResult = RestResponse | { error: string };

// ---------------------------------------------------------------------------
// System stats (whole-machine memory + CPU, broadcast every ~2s)
// ---------------------------------------------------------------------------

export type SystemStats = {
  // Whole-system memory in bytes. On macOS, `used` is wired + active +
  // compressed (matches Activity Monitor); on other platforms it's total - free.
  memUsedBytes: number;
  memTotalBytes: number;
  // 0..100 — average across all logical cores in the last sample window.
  cpuPct: number;
  // 3-tuple: 1-min, 5-min, 15-min load average.
  loadAvg: [number, number, number];
  // Main-process file-descriptor count and the soft RLIMIT_NOFILE under
  // which the app is running. Lets the bottom-bar warn before fd
  // exhaustion bites (the IDE has been bitten by this before via chokidar
  // watching too many files on Finder-launched builds, capped at 256).
  fdCount: number;
  fdLimit: number;
  // GPU info probed once at startup (system_profiler on macOS). 0/0 when
  // unknown (non-Mac, probe failed, or chip doesn't expose core count).
  gpuCount: number;
  gpuCores: number;
};

// ---------------------------------------------------------------------------
// Local LLM models (mlx_lm.server only — Ollama support removed in v0.6.22)
// ---------------------------------------------------------------------------

export type MlxServerStatus = {
  running: boolean;
  pid?: number;
  port?: number;
  // The model id and adapter path the running server was started with —
  // null when no server has been started yet (or the last run was cleared).
  model?: string | null;
  adapter?: string | null;
  startedAt?: number;
  lastError?: string;
};

// ---------------------------------------------------------------------------
// Pip / Python packages
// ---------------------------------------------------------------------------

export type PipPackage = {
  name: string;
  version: string;
  // Populated by the outdated check; null when at the latest or unchecked.
  latest?: string | null;
};

export type PipRequirement = {
  // Raw requirement spec from requirements.txt (e.g. "torch>=2.1,<3").
  spec: string;
  // Parsed package name, or null when the line is a URL/path/editable install.
  name: string | null;
  // Whether the requirement appears to be currently installed (loose match).
  installed: boolean;
  // The installed version if `installed` is true; null otherwise.
  installedVersion: string | null;
};

// ---------------------------------------------------------------------------
// Run configurations (PyCharm-style)
// ---------------------------------------------------------------------------

export type PythonRunConfig = {
  id: string;
  name: string;
  // Either a script path (relative to workspace OR absolute) for "python script.py",
  // or a module spec for "python -m module" (when mode='module').
  mode: 'script' | 'module';
  target: string;                  // script path or module name
  args: string[];                  // additional argv after the target
  cwd?: string;                    // relative to workspace; default '.'
  env?: Record<string, string>;
  // Per-config interpreter override. When unset, the workspace's selected
  // interpreter (via python.ts) is used.
  interpreter?: string;
};

export type RunStatus = 'starting' | 'running' | 'stopped' | 'error';

export type RunSession = {
  id: string;                      // unique per-spawn
  configId: string;                // referenced PythonRunConfig.id
  configName: string;              // captured at spawn so the panel survives deletes
  status: RunStatus;
  pid?: number;
  startedAt: number;
  exitCode?: number | null;
  lastError?: string;
};

// ---------------------------------------------------------------------------
// Python interpreter
// ---------------------------------------------------------------------------

export type PythonInterpreterKind = 'venv' | 'pyenv' | 'conda' | 'homebrew' | 'system' | 'path' | 'framework';

export type PythonInterpreter = {
  // Absolute path to the python/python3 binary.
  path: string;
  // Source category — used by the UI to badge the entry (e.g. "venv", "pyenv:3.11").
  kind: PythonInterpreterKind;
  // Human-readable label (e.g. ".venv", "Homebrew (arm64)", "pyenv:3.11.6").
  label?: string;
  // Result of `<path> -V` minus the "Python " prefix; null if probe failed.
  version?: string | null;
};

// ---------------------------------------------------------------------------
// MLX / ML project
// ---------------------------------------------------------------------------

export type MlxProjectInfo = {
  // Absolute path to the lora_config.yaml that anchors this project.
  configPath: string;
  // Parsed config — only fields the IDE knows how to display. Anything
  // else from the yaml is preserved in `raw` so power users can inspect.
  model?: string;
  data?: string;                     // dataset directory (config-relative)
  fineTuneType?: string;             // 'lora' | 'dora' | 'full' etc
  numLayers?: number;
  batchSize?: number;
  iters?: number;
  learningRate?: number;
  maxSeqLength?: number;
  gradCheckpoint?: boolean;
  stepsPerReport?: number;
  stepsPerEval?: number;
  valBatches?: number;
  saveEvery?: number;
  adapterPath?: string;              // config-relative
  loraRank?: number;
  loraScale?: number;
  loraDropout?: number;
  raw?: Record<string, unknown>;

  // Resolved on-disk locations (best-effort; null when the file/dir
  // referenced by the config can't be found anywhere reasonable).
  resolvedAdapterDir?: string | null;
  resolvedDataDir?: string | null;
  // Python interpreter we'll use to run training. Prefers a .venv next
  // to the workspace; falls back to `python3` on PATH.
  python?: string;
  hasVenv?: boolean;
  // Auto-registered service id. Stable so the UI can subscribe to its
  // logs and call services.start/stop without a separate spawn channel.
  serviceId?: string;
};

export type MlxAdapter = {
  path: string;                      // absolute
  name: string;                      // file basename
  iter: number | null;               // parsed from "0001200_adapters.safetensors", null for the latest pointer
  sizeBytes: number;
  modifiedAt: number;                // epoch ms
  isLatestPointer: boolean;          // true for the plain "adapters.safetensors"
};

// One parsed event from the MLX training stdout stream.
export type MlxTrainEvent =
  | {
      kind: 'train';
      iter: number;
      trainLoss: number;
      learningRate: number;
      itPerSec: number;
      tokensPerSec: number;
      trainedTokens: number;
      peakMemGb: number;
      ts: number;
    }
  | { kind: 'val'; iter: number; valLoss: number; valTookSec: number; ts: number }
  | { kind: 'saved'; iter: number; paths: string[]; ts: number }
  | { kind: 'started'; ts: number }
  | { kind: 'exited'; code: number | null; ts: number };

export type MlxStatus = {
  detected: boolean;
  info?: MlxProjectInfo;
  // Live training state — replayed to a new MlxPanel mount via mlx:status
  // so we don't lose the metrics history when the user toggles tabs.
  running: boolean;
  serviceId?: string;
  events: MlxTrainEvent[];          // capped to the most recent N (~500)
};

/* ------------------------------------------------------- Claude account (AI) */

/**
 * Who the IDE's AI is signed in as. Read from `claude auth status --json`,
 * always against the credential store cliChildEnv pins — the same one the
 * chat's CLI children use, which is not necessarily the one a terminal tab
 * or a shell profile would select.
 */
export type ClaudeAuthStatus = {
  loggedIn: boolean;
  /** Absolute path of the CLI we ran, so the UI can say what it probed. */
  binPath?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
  apiProvider?: string;
  configDirectory?: string;
  /** Set when we couldn't get an answer at all (missing CLI, crash, timeout). */
  error?: string;
};

/** Streamed to the renderer while a `claude auth login` is in flight. */
export type ClaudeLoginEvent =
  | { kind: 'output'; chunk: string }
  | { kind: 'url'; url: string }
  | { kind: 'done'; code: number; status: ClaudeAuthStatus };

/** The clock pages in the browser panel see. `now` is its reading at the time of the call. */
export type BrowserClock = {
  fake: boolean;
  now: number;
  frozen: boolean;
};

/** What reloading browser-panel tabs for the AI (ide_browser_refresh) came to. */
export type BrowserReloadResult = {
  tabs?: { name: string; url: string; title: string; loadError?: string }[];
  error?: string;
};

/** A saved browser login, as shown in a list — never carries the password. */
export type SavedLogin = {
  id: string;
  /** Scheme + host + port, e.g. https://github.com */
  origin: string;
  username: string;
  updatedAt: number;
};

/** A saved login with its password, handed out one origin at a time for autofill. */
export type SavedLoginSecret = {
  id: string;
  origin: string;
  username: string;
  password: string;
};

export type PasswordStoreStatus = {
  /** False when the OS offers no credential encryption; saving is refused. */
  encryptionAvailable: boolean;
  count: number;
  neverSave: string[];
};

/* ------------------------------------------------------------- network log */

/** Where a captured call came from: the IDE's own HTTP, or the browser panel. */
export type NetSource = 'ide' | 'browser';

/**
 * What the NETWORK list shows. Deliberately body-free — a few hundred of
 * these live in the renderer at once, and the bodies are fetched one at a
 * time when a row is opened.
 */
export type NetEntrySummary = {
  id: string;
  source: NetSource;
  /** Subsystem that made the call: rest, jira, es, llm, ai, browser, http. */
  origin: string;
  method: string;
  url: string;
  /** Split out so the list can show a short path and keep the host as context. */
  host: string;
  path: string;
  status?: number;
  statusText?: string;
  startedAt: number;
  durationMs?: number;
  /** True between "request sent" and "response finished". */
  pending: boolean;
  responseSize?: number;
  contentType?: string;
  /** Browser rows only — xhr, fetch, document, eventsource. */
  resourceType?: string;
  error?: string;
};

/** A row with its bodies and headers, loaded on demand. */
export type NetEntry = NetEntrySummary & {
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyTruncated?: boolean;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
};

/* ------------------------------------------------------------ screen recorder */

/** One capturable surface — a whole display or a single window. */
export type CaptureSource = {
  /** Opaque id handed back to getUserMedia as `chromeMediaSourceId`. */
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** PNG data URL preview, small enough to sit in the picker grid. */
  thumbnail: string;
};

/** Handle returned when main has opened the output file for a new recording. */
export type RecordingHandle = {
  id: string;
  path: string;
};

/** Result of finalizing a recording. */
export type RecordingResult = {
  path: string;
  bytes: number;
  /** Wall-clock length the renderer measured, in milliseconds. */
  durationMs: number;
};

/** One tool call in a chat response, for the optional Activity log. Sent
 *  more than once per call (target known, then finished); upsert on uid=1050623(d.zhao) gid=1049089 groups=1049089. */
export type AiActivityMsg = {
  streamId: string;
  id: string;
  tool: string;
  target?: string;
  status: 'running' | 'ok' | 'error';
};
