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
