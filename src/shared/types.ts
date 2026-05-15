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

export type ChatProvider = 'claude' | 'codex';

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

export type DebugLang = 'node' | 'java';
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
  | { lang: 'node'; file: string }          // M1: debug a JS file
  | { lang: 'java'; serviceId: string };    // M2: debug a Maven/Gradle service

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
