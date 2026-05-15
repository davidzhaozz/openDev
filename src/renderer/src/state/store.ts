import { create } from 'zustand';
import type { ChatAttachment, ChatMessage, Conversation, DbColumn, DebugLang, DebugStatus, ServiceDef, ServiceRuntime, StackFrame } from '../../../shared/types';

// Renderer-side memory caps. Kept in sync with src/main/limits.ts — the
// main process is authoritative but we re-cap here so a runaway stream
// doesn't blow up the React tree before the IPC ever gets cancelled.
const MAX_STREAMING_TEXT = 4 * 1024 * 1024;
const MAX_CONVERSATION_MESSAGES = 500;
function capTail<T>(arr: T[], max: number): T[] {
  return arr.length <= max ? arr : arr.slice(arr.length - max);
}

// When the SQL result grid is the live view of a known table (clicked from
// the DB tree), this carries enough info for the editable grid to build
// safe UPDATE statements. Cleared the moment the user hand-edits the SQL.
export type SqlSource = {
  driver: 'mysql' | 'postgres';
  schema?: string;
  table: string;
  columns: DbColumn[];
};

export type DesignProposal = { name: string; html: string };

export type CenterTab =
  | { kind: 'file'; id: string; path: string; name: string; content: string; modified: boolean; dirtyContent?: string }
  | { kind: 'terminal'; id: string; name: string; termId?: string; cwd: string }
  | { kind: 'browser'; id: string; name: string; url: string }
  | { kind: 'sql'; id: string; name: string }
  | { kind: 'es'; id: string; name: string }
  | { kind: 'diff'; id: string; name: string; filePath: string; hash?: string; diff: string }
  | { kind: 'ai-task'; id: string; name: string }
  | { kind: 'ai'; id: string; name: string; conversationId?: string; initialPrompt?: string }
  | { kind: 'design-proposals'; id: string; name: string; proposals: DesignProposal[]; targetPath?: string }
  | { kind: 'agent-run'; id: string; name: string; runId: string; agentSlug: string; target: string };

export type BottomTabKey = 'terminal' | 'problems' | 'ports' | 'tasks' | 'browser' | 'search';
export type RightTabKey = 'ai' | 'db' | 'es' | 'log' | 'debug';

export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';
export type LogBubble = {
  id: string;
  serviceId: string;
  ts: number;
  severity: LogSeverity;
  text: string;
};
export type ModalKind = null | 'fuzzy' | 'find' | 'service-edit' | 'db-edit' | 'workspace-pick' | 'new-project' | 'add-package';

type Store = {
  workspaceRoot?: string;
  setWorkspaceRoot: (root?: string) => void;

  centerTabs: CenterTab[];
  activeCenterId?: string;
  openFileTab: (path: string, content: string) => void;
  openTerminalTab: (opts?: { cwd?: string; name?: string }) => void;
  openBrowserTab: (url: string, name?: string) => void;
  openSqlTab: () => void;
  openEsTab: () => void;
  openDiffTab: (opts: { filePath: string; hash?: string; diff: string }) => void;
  openAiTaskTab: (opts?: { goal?: string; priorities?: string[] }) => void;
  openAiChatTab: (opts?: { conversationId?: string; name?: string; focusIfOpen?: boolean; initialPrompt?: string }) => string;
  setAiTabConversation: (tabId: string, conversationId: string, name?: string) => void;
  openDesignProposalsTab: (opts: { proposals: DesignProposal[]; targetPath?: string; name?: string }) => string;
  openAgentRunTab: (opts: { runId: string; agentSlug: string; name: string; target?: string }) => string;
  aiTaskGoal: string;
  aiTaskPriorities: string[];
  aiTaskOutput: string;
  aiTaskRunning: boolean;
  aiTaskStreamId?: string;
  setAiTaskGoal: (s: string) => void;
  setAiTaskPriorities: (p: string[]) => void;
  setAiTaskOutput: (s: string | ((prev: string) => string)) => void;
  setAiTaskRunning: (r: boolean) => void;
  setAiTaskStreamId: (id: string | undefined) => void;
  renameCenterTab: (id: string, name: string) => void;
  closeCenterTab: (id: string) => void;
  setActiveCenterTab: (id: string) => void;
  updateFileContent: (id: string, content: string) => void;
  markFileSaved: (id: string) => void;

  bottomTab: BottomTabKey;
  setBottomTab: (t: BottomTabKey) => void;

  rightTab: RightTabKey;
  setRightTab: (t: RightTabKey) => void;

  rightCollapsed: boolean;
  toggleRight: () => void;
  bottomCollapsed: boolean;
  toggleBottom: () => void;

  modal: ModalKind;
  modalPayload?: unknown;
  setModal: (m: ModalKind, payload?: unknown) => void;

  services: ServiceDef[];
  serviceStatuses: Record<string, ServiceRuntime>;
  serviceLogs: Record<string, string>;
  setServices: (s: ServiceDef[]) => void;
  setServiceStatus: (r: ServiceRuntime) => void;
  appendServiceLog: (id: string, chunk: string) => void;

  // Unified application log timeline — every line of stdout/stderr from
  // any running service becomes one bubble. Capped to keep memory bounded.
  logBubbles: LogBubble[];
  clearLogBubbles: () => void;

  conversationId?: string;
  conversationMessages: ChatMessage[];
  streamingText: string;
  streamingId?: string;
  setConversation: (c: Conversation | null) => void;
  appendUserMessage: (text: string, attachments?: ChatAttachment[]) => void;
  appendStreamingChunk: (chunk: string) => void;
  finalizeAssistantMessage: (full: string) => void;
  chatAttachments: ChatAttachment[];
  addAttachment: (a: ChatAttachment) => void;
  removeAttachment: (index: number) => void;
  clearAttachments: () => void;

  toast?: string;
  showToast: (msg: string, ms?: number) => void;

  layout: { leftW: number; rightW: number; bottomH: number; servicesH: number; sqlSplit: number; agentsH: number };
  setLayout: (patch: Partial<Store['layout']>) => void;

  pendingServiceDraft?: { name: string; command: string; cwd: string };
  setPendingServiceDraft: (d: Store['pendingServiceDraft']) => void;

  sqlText: string;
  setSqlText: (s: string, opts?: { keepSource?: boolean }) => void;
  sqlSource?: SqlSource;
  setSqlSource: (s: SqlSource | undefined) => void;
  sqlConnId?: string;
  setSqlConnId: (id?: string) => void;
  sqlResult?: { columns: string[]; rows: unknown[][]; rowCount: number; durationMs: number; truncated?: boolean } | { error: string };
  setSqlResult: (r: Store['sqlResult']) => void;
  sqlRunRequest: number;
  triggerSqlRun: () => void;

  pendingJump?: { path: string; line: number; col: number; nonce: number };
  setPendingJump: (j: { path: string; line: number; col: number } | undefined) => void;

  references?: { symbol?: string; items: Array<{ path: string; line: number; col: number; preview?: string }> };
  setReferences: (r: Store['references']) => void;

  esText: string;
  setEsText: (s: string) => void;
  esResult?: { status: number; body: any; durationMs: number } | { error: string };
  setEsResult: (r: Store['esResult']) => void;
  esRunRequest: number;
  triggerEsRun: () => void;

  // Debugger — breakpoints are kept per file (1-indexed lines) so they
  // survive tab switches and editor remount; the rest is per-active-session.
  breakpoints: Record<string, number[]>;
  toggleBreakpoint: (path: string, line: number) => void;
  clearBreakpointsForFile: (path: string) => void;
  debugSession?: { sessionId: string; lang: DebugLang; status: DebugStatus };
  setDebugSession: (s: Store['debugSession']) => void;
  debugPaused?: { reason: string; frames: StackFrame[] };
  setDebugPaused: (p: Store['debugPaused']) => void;
  debugSelectedFrameId?: string;
  selectDebugFrame: (id: string | undefined) => void;
  debugConsole: string;
  appendDebugConsole: (chunk: string) => void;
  clearDebugConsole: () => void;
  debugWatches: string[];
  addDebugWatch: (expr: string) => void;
  removeDebugWatch: (i: number) => void;
};

const LAYOUT_KEY = 'opendev:layout:v1';
function readLayout(): Store['layout'] {
  try {
    const s = localStorage.getItem(LAYOUT_KEY);
    if (s) return { leftW: 260, rightW: 320, bottomH: 220, servicesH: 240, sqlSplit: 240, agentsH: 220, ...JSON.parse(s) };
  } catch {}
  return { leftW: 260, rightW: 320, bottomH: 220, servicesH: 240, sqlSplit: 240, agentsH: 220 };
}
function writeLayout(l: Store['layout']) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch {}
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

let tabCounter = 0;
const nextTabId = () => `t-${++tabCounter}-${Date.now()}`;

export const useStore = create<Store>((set, get) => ({
  setWorkspaceRoot: (root) => set((s) => {
    // Workspace changed → wipe everything that's per-project so panels from
    // the previous workspace don't leak into the new one. The persisted
    // state (services.json, conversations/, db-connections.json, *-history,
    // agents/) is already per-workspace on disk, so the renderer just needs
    // to clear its in-memory caches.
    if (s.workspaceRoot === root) return { workspaceRoot: root };
    return {
      workspaceRoot: root,
      // AI chat
      conversationId: undefined,
      conversationMessages: [],
      streamingText: '',
      streamingId: undefined,
      chatAttachments: [],
      // Logs / services state (services array re-fetches per workspace anyway)
      logBubbles: [],
      services: [],
      serviceStatuses: {},
      serviceLogs: {},
      // Debugger
      breakpoints: {},
      debugSession: undefined,
      debugPaused: undefined,
      debugSelectedFrameId: undefined,
      debugConsole: '',
      debugWatches: [],
      // SQL / ES editor state (per-project queries shouldn't leak)
      sqlConnId: undefined,
      sqlResult: undefined,
      sqlSource: undefined,
      sqlText: 'SELECT 1;',
      esResult: undefined,
      esText: 'GET /_search\n{\n  "query": { "match_all": {} },\n  "size": 10\n}',
      // Editor/jump state
      references: undefined,
      pendingJump: undefined
    };
  }),

  centerTabs: [],
  openFileTab: (path, content) => set((s) => {
    const existing = s.centerTabs.find(t => t.kind === 'file' && t.path === path);
    if (existing) return { activeCenterId: existing.id };
    const id = nextTabId();
    const name = path.split('/').pop() || path;
    const tab: CenterTab = { kind: 'file', id, path, name, content, modified: false };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id };
  }),
  openTerminalTab: (opts) => set((s) => {
    const id = nextTabId();
    const cwd = opts?.cwd || s.workspaceRoot || '/';
    const fallbackName = `Terminal ${s.centerTabs.filter(t => t.kind === 'terminal').length + 1}`;
    const name = opts?.name || (opts?.cwd ? (opts.cwd.split('/').filter(Boolean).pop() || fallbackName) : fallbackName);
    const tab: CenterTab = { kind: 'terminal', id, name, cwd };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id };
  }),
  openBrowserTab: (url, name) => set((s) => {
    // Open a fresh browser tab — duplicates allowed, each tab is independent.
    const id = nextTabId();
    let tabName = name;
    if (!tabName) {
      try { const u = new URL(url); tabName = u.port ? `:${u.port}` : u.hostname; }
      catch { tabName = 'Browser'; }
    }
    const tab: CenterTab = { kind: 'browser', id, name: tabName, url };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id };
  }),
  openSqlTab: () => set((s) => {
    // Singleton — at most one SQL workspace tab at a time.
    const existing = s.centerTabs.find(t => t.kind === 'sql');
    if (existing) return { activeCenterId: existing.id };
    const id = nextTabId();
    const tab: CenterTab = { kind: 'sql', id, name: 'SQL' };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id };
  }),
  openEsTab: () => set((s) => {
    const existing = s.centerTabs.find(t => t.kind === 'es');
    if (existing) return { activeCenterId: existing.id };
    const id = nextTabId();
    const tab: CenterTab = { kind: 'es', id, name: 'ES' };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id };
  }),
  openDiffTab: (opts) => set((s) => {
    const id = nextTabId();
    const file = opts.filePath.split('/').pop() || 'diff';
    const name = opts.hash ? `${file} @ ${opts.hash.slice(0, 7)}` : `${file} (diff)`;
    const tab: CenterTab = { kind: 'diff', id, name, filePath: opts.filePath, hash: opts.hash, diff: opts.diff };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id };
  }),
  openAiChatTab: (opts) => {
    const state = get();
    // If asked for a specific conversation that's already open, focus it
    // instead of creating a duplicate. Brand-new tabs (no conversationId)
    // always get a fresh tab.
    if (opts?.conversationId) {
      const existing = state.centerTabs.find(t => t.kind === 'ai' && t.conversationId === opts.conversationId);
      if (existing) {
        set({ activeCenterId: existing.id });
        return existing.id;
      }
    } else if (opts?.focusIfOpen) {
      const existing = state.centerTabs.find(t => t.kind === 'ai');
      if (existing) {
        set({ activeCenterId: existing.id });
        return existing.id;
      }
    }
    const id = nextTabId();
    const aiCount = state.centerTabs.filter(t => t.kind === 'ai').length;
    const name = opts?.name || (opts?.conversationId ? 'Chat' : `New chat${aiCount > 0 ? ` ${aiCount + 1}` : ''}`);
    const tab: CenterTab = { kind: 'ai', id, name, conversationId: opts?.conversationId, initialPrompt: opts?.initialPrompt };
    set((s) => ({ centerTabs: [...s.centerTabs, tab], activeCenterId: id }));
    return id;
  },
  setAiTabConversation: (tabId, conversationId, name) => set((s) => ({
    centerTabs: s.centerTabs.map(t => {
      if (t.id !== tabId || t.kind !== 'ai') return t;
      return { ...t, conversationId, name: name || t.name };
    })
  })),
  openDesignProposalsTab: (opts) => {
    const id = nextTabId();
    const name = opts.name || (opts.targetPath ? `Designs · ${opts.targetPath.split('/').pop()}` : 'Designs');
    const tab: CenterTab = { kind: 'design-proposals', id, name, proposals: opts.proposals, targetPath: opts.targetPath };
    set((s) => ({ centerTabs: [...s.centerTabs, tab], activeCenterId: id }));
    return id;
  },
  openAgentRunTab: (opts) => {
    // Always a fresh tab — each Run is its own output surface.
    const id = nextTabId();
    const tab: CenterTab = {
      kind: 'agent-run', id, name: opts.name,
      runId: opts.runId, agentSlug: opts.agentSlug, target: opts.target ?? 'local'
    };
    set((s) => ({ centerTabs: [...s.centerTabs, tab], activeCenterId: id }));
    return id;
  },
  openAiTaskTab: (opts) => set((s) => {
    // Singleton — at most one Task workspace at a time so the form/output
    // state in the store stays unambiguous.
    const existing = s.centerTabs.find(t => t.kind === 'ai-task');
    const patches: Partial<Store> = {};
    if (opts?.goal) patches.aiTaskGoal = opts.goal;
    if (opts?.priorities) patches.aiTaskPriorities = opts.priorities;
    if (existing) return { activeCenterId: existing.id, ...patches };
    const id = nextTabId();
    const tab: CenterTab = { kind: 'ai-task', id, name: 'Task' };
    return { centerTabs: [...s.centerTabs, tab], activeCenterId: id, ...patches };
  }),
  aiTaskGoal: '',
  aiTaskPriorities: [],
  aiTaskOutput: '',
  aiTaskRunning: false,
  setAiTaskGoal: (s) => set({ aiTaskGoal: s }),
  setAiTaskPriorities: (p) => set({ aiTaskPriorities: p }),
  setAiTaskOutput: (s) => set((prev) => ({ aiTaskOutput: typeof s === 'function' ? s(prev.aiTaskOutput) : s })),
  setAiTaskRunning: (r) => set({ aiTaskRunning: r }),
  setAiTaskStreamId: (id) => set({ aiTaskStreamId: id }),
  renameCenterTab: (id, name) => set((s) => ({
    centerTabs: s.centerTabs.map(t => {
      // File tabs are anchored to a real path — leave them alone.
      if (t.id !== id || t.kind === 'file') return t;
      return { ...t, name };
    })
  })),
  closeCenterTab: (id) => set((s) => {
    const tabs = s.centerTabs.filter(t => t.id !== id);
    const active = s.activeCenterId === id ? tabs[tabs.length - 1]?.id : s.activeCenterId;
    return { centerTabs: tabs, activeCenterId: active };
  }),
  setActiveCenterTab: (id) => set({ activeCenterId: id }),
  updateFileContent: (id, content) => set((s) => ({
    centerTabs: s.centerTabs.map(t => t.id === id && t.kind === 'file'
      ? { ...t, dirtyContent: content, modified: content !== t.content }
      : t)
  })),
  markFileSaved: (id) => set((s) => ({
    centerTabs: s.centerTabs.map(t => t.id === id && t.kind === 'file'
      ? { ...t, content: t.dirtyContent ?? t.content, dirtyContent: undefined, modified: false }
      : t)
  })),

  bottomTab: 'ports',
  setBottomTab: (t) => set({ bottomTab: t }),
  rightTab: 'ai',
  setRightTab: (t) => set({ rightTab: t }),

  rightCollapsed: false,
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  bottomCollapsed: false,
  toggleBottom: () => set((s) => ({ bottomCollapsed: !s.bottomCollapsed })),

  modal: null,
  setModal: (m, payload) => set({ modal: m, modalPayload: payload }),

  services: [],
  serviceStatuses: {},
  serviceLogs: {},
  setServices: (s) => set({ services: s }),
  setServiceStatus: (r) => set((s) => ({ serviceStatuses: { ...s.serviceStatuses, [r.id]: r } })),
  appendServiceLog: (id, chunk) => set((s) => {
    const prev = s.serviceLogs[id] || '';
    const next = (prev + chunk).slice(-50_000);
    // Split the chunk into lines and emit a bubble per non-empty line.
    // Partial last lines are buffered until a newline arrives. We re-use
    // the same serviceLogs trail as the raw string buffer, so the regex
    // here only looks at the new chunk.
    const out = chunk.split('\n');
    const ts = Date.now();
    const newBubbles: LogBubble[] = [];
    for (let i = 0; i < out.length; i++) {
      const line = out[i];
      // Skip the trailing empty fragment (when chunk ends with \n).
      if (i === out.length - 1 && line.length === 0) continue;
      const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!trimmed.trim()) continue;
      let severity: LogSeverity = 'info';
      if (/\b(error|fail|fatal|exception|✗|✘)\b/i.test(trimmed)) severity = 'error';
      else if (/\b(warn|warning|deprecat)\b/i.test(trimmed)) severity = 'warn';
      else if (/\b(debug|trace)\b/i.test(trimmed)) severity = 'debug';
      newBubbles.push({
        id: `lb-${ts}-${Math.random().toString(36).slice(2, 8)}-${i}`,
        serviceId: id,
        ts,
        severity,
        text: trimmed.slice(0, 1200) // hard cap per line so a giant blob doesn't blow up the UI
      });
    }
    const combined = [...s.logBubbles, ...newBubbles];
    // Keep the most recent 2000.
    const bubbles = combined.length > 2000 ? combined.slice(combined.length - 2000) : combined;
    return { serviceLogs: { ...s.serviceLogs, [id]: next }, logBubbles: bubbles };
  }),

  logBubbles: [],
  clearLogBubbles: () => set({ logBubbles: [] }),

  conversationMessages: [],
  streamingText: '',
  setConversation: (c) => set({
    conversationId: c?.id,
    conversationMessages: capTail(c?.messages ?? [], MAX_CONVERSATION_MESSAGES),
    streamingText: ''
  }),
  appendUserMessage: (text, attachments) => set((s) => ({
    conversationMessages: capTail([...s.conversationMessages, {
      id: `local-${Date.now()}`, role: 'user', text, attachments, createdAt: Date.now()
    }], MAX_CONVERSATION_MESSAGES),
    chatAttachments: []
  })),
  appendStreamingChunk: (chunk) => set((s) => {
    const next = s.streamingText + chunk;
    // Past the cap: stop appending and drop a marker so the user sees why
    // the live view stopped growing. Main process also caps independently.
    if (next.length > MAX_STREAMING_TEXT) {
      if (s.streamingText.endsWith('[…truncated…]')) return {};
      return { streamingText: next.slice(0, MAX_STREAMING_TEXT) + '[…truncated…]' };
    }
    return { streamingText: next };
  }),
  finalizeAssistantMessage: (full) => set((s) => ({
    conversationMessages: capTail([...s.conversationMessages, {
      id: `local-${Date.now()}`, role: 'assistant', text: full || s.streamingText, createdAt: Date.now()
    }], MAX_CONVERSATION_MESSAGES),
    streamingText: '',
    streamingId: undefined
  })),
  chatAttachments: [],
  addAttachment: (a) => set((s) => ({ chatAttachments: [...s.chatAttachments, a] })),
  removeAttachment: (index) => set((s) => ({ chatAttachments: s.chatAttachments.filter((_, i) => i !== index) })),
  clearAttachments: () => set({ chatAttachments: [] }),

  showToast: (msg, ms = 2500) => {
    set({ toast: msg });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: undefined }), ms);
  },

  layout: readLayout(),
  setLayout: (patch) => set((s) => {
    const next = { ...s.layout, ...patch };
    writeLayout(next);
    return { layout: next };
  }),

  setPendingServiceDraft: (d) => set({ pendingServiceDraft: d }),

  sqlText: 'SELECT 1;',
  // Hand-edits should disconnect the result from any "this is the live
  // contents of table X" assumption — once the SQL is anything but the
  // exact preview we set, we can't safely build UPDATE statements.
  // Callers that want to retain the source (the DB tree "preview" flow)
  // must pass `keepSource: true` and call `setSqlSource` afterwards.
  setSqlText: (s, opts) => set(opts?.keepSource ? { sqlText: s } : { sqlText: s, sqlSource: undefined }),
  setSqlSource: (s) => set({ sqlSource: s }),
  setSqlConnId: (id) => set({ sqlConnId: id }),
  setSqlResult: (r) => set({ sqlResult: r }),
  sqlRunRequest: 0,
  triggerSqlRun: () => set((s) => ({ sqlRunRequest: s.sqlRunRequest + 1 })),

  setPendingJump: (j) => set((s) => ({
    pendingJump: j ? { ...j, nonce: (s.pendingJump?.nonce ?? 0) + 1 } : undefined
  })),
  setReferences: (r) => set({ references: r }),

  esText: 'GET /_search\n{\n  "query": { "match_all": {} },\n  "size": 10\n}',
  setEsText: (s) => set({ esText: s }),
  setEsResult: (r) => set({ esResult: r }),
  esRunRequest: 0,
  triggerEsRun: () => set((s) => ({ esRunRequest: s.esRunRequest + 1 })),

  breakpoints: {},
  toggleBreakpoint: (path, line) => set((s) => {
    const cur = s.breakpoints[path] ?? [];
    const next = cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b);
    const all = { ...s.breakpoints };
    if (next.length === 0) delete all[path];
    else all[path] = next;
    return { breakpoints: all };
  }),
  clearBreakpointsForFile: (path) => set((s) => {
    if (!s.breakpoints[path]) return {};
    const all = { ...s.breakpoints };
    delete all[path];
    return { breakpoints: all };
  }),
  setDebugSession: (sess) => set({ debugSession: sess }),
  setDebugPaused: (p) => set((prev) => ({
    debugPaused: p,
    debugSelectedFrameId: p?.frames?.[0]?.id ?? prev.debugSelectedFrameId
  })),
  selectDebugFrame: (id) => set({ debugSelectedFrameId: id }),
  debugConsole: '',
  appendDebugConsole: (chunk) => set((s) => {
    const next = (s.debugConsole + chunk).slice(-200_000);
    return { debugConsole: next };
  }),
  clearDebugConsole: () => set({ debugConsole: '' }),
  debugWatches: [],
  addDebugWatch: (expr) => set((s) => ({ debugWatches: [...s.debugWatches, expr] })),
  removeDebugWatch: (i) => set((s) => ({ debugWatches: s.debugWatches.filter((_, j) => j !== i) }))
}));
