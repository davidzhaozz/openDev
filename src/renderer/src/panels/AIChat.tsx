import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, type DesignProposal } from '../state/store';
import type { AiActivityMsg, ChatAttachment, ChatMessage } from '../../../shared/types';
import { ModelCapabilityNote } from '../components/ModelCapabilityNote';
import { Markdown } from '../components/ChatMarkdown';

// Parses ```html-proposal:NAME blocks out of an assistant message. The
// matching is line-anchored on the fence so we don't trip on stray ``` in
// the prose. Returns [] when none are present.
function extractDesignProposals(text: string): DesignProposal[] {
  const out: DesignProposal[] = [];
  const re = /```html-proposal:([^\n`]+)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1].trim();
    const html = m[2].trim();
    if (name && html) out.push({ name, html });
  }
  return out;
}

// Chat text size, shared by every chat tab and remembered per machine.
const CHAT_FONT_KEY = 'opendev.chatFontSize';
const CHAT_FONT_MIN = 13;
const CHAT_FONT_MAX = 24;
function loadChatFontSize(): number {
  try {
    const n = Number(localStorage.getItem(CHAT_FONT_KEY));
    if (n >= CHAT_FONT_MIN && n <= CHAT_FONT_MAX) return n;
  } catch {}
  return 16;
}

const MAX_BYTES = 4 * 1024 * 1024; // 4MB per file
const TEXTUAL_EXTS = /\.(?:ts|tsx|js|jsx|json|md|mdx|css|scss|html|htm|txt|log|ya?ml|toml|sh|bash|zsh|fish|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sql|csv|tsv|env|gitignore|gitattributes|prettierrc|eslintrc|properties|conf|ini)$/i;

async function readAsAttachment(file: File): Promise<ChatAttachment | null> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 4 MB.`);
  const isImage = file.type.startsWith('image/');
  const isText = file.type.startsWith('text/') || TEXTUAL_EXTS.test(file.name) || file.type === '' || file.type.includes('javascript') || file.type.includes('json');
  if (isImage) {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    return { kind: 'file', name: file.name, mimeType: file.type, size: file.size, dataUrl };
  }
  if (isText) {
    const text = await file.text();
    return { kind: 'file', name: file.name, mimeType: file.type || 'text/plain', size: file.size, text };
  }
  return null;
}

type Props = {
  tabId: string;
  initialConversationId?: string;
  active?: boolean;
  // When set, this prompt is auto-sent once on mount (e.g. the "+ New agent"
  // flow opens a chat tab pre-loaded with the agent-authoring prompt).
  initialPrompt?: string;
};

// Renders a single AI conversation. Designed to be instantiated per
// center-tab so the user can have N concurrent sessions in parallel — each
// component holds its own messages/streaming/convId state and filters the
// global onStream events by its own streamId.
export function AIChat({ tabId, initialConversationId, active, initialPrompt }: Props) {
  const [convId, setConvId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState('');
  // Mirror for the stream listener, which subscribes once and would otherwise
  // only ever see the initial empty string.
  const streamingRef = useRef('');
  streamingRef.current = streaming;
  const [text, setText] = useState('');
  const [transport, setTransportState] = useState<'claude-cli' | 'codex-cli' | 'opencode-cli'>('claude-cli');
  const providerLabel = transport === 'codex-cli' ? 'Codex' : transport === 'opencode-cli' ? 'OpenCode' : 'Claude';
  // Local-AI gate — only show the OpenCode transport when the user has
  // enabled it in Settings → Local AI. Polled on mount + whenever the
  // settings storage event fires (saving in the Settings panel triggers
  // an immediate re-read for any open chat tabs).
  const [aiLocalEnabled, setAiLocalEnabled] = useState(false);
  const [aiLocalModel, setAiLocalModel] = useState('');
  // Claude Code model + reasoning effort. '' = CLI default.
  const [claudeModel, setClaudeModelState] = useState('');
  const [claudeEffort, setClaudeEffortState] = useState('');
  useEffect(() => {
    const load = () => window.opendev.settings.get().then(s => {
      setAiLocalEnabled(!!s.aiLocalEnabled);
      setAiLocalModel(s.aiLocalModel || '');
      setClaudeModelState(s.claudeCliModel || '');
      setClaudeEffortState(s.claudeCliEffort || '');
      // First-load: adopt the last-used transport so a fresh chat tab
      // defaults to whatever the user picked last, instead of always
      // snapping to Claude. Guarded by `!loadedTransport.current` so
      // later settings-changed events (e.g. enabling Local AI) don't
      // overwrite an in-flight user pick.
      if (!loadedTransport.current && s.lastAiTransport) {
        const t = s.lastAiTransport;
        if (t === 'claude-cli' || t === 'codex-cli' || (t === 'opencode-cli' && s.aiLocalEnabled)) {
          setTransportState(t);
        }
      }
      loadedTransport.current = true;
    });
    load();
    // Settings.tsx dispatches this on every persist, so a toggle in the
    // settings panel propagates to the dropdown immediately.
    const onChange = () => load();
    window.addEventListener('opendev:settings-changed', onChange);
    // Also re-read when the window regains focus, for the cross-window case.
    window.addEventListener('focus', onChange);
    return () => {
      window.removeEventListener('opendev:settings-changed', onChange);
      window.removeEventListener('focus', onChange);
    };
  }, []);
  const loadedTransport = useRef(false);
  // Wrap setter so every user pick is persisted to settings. The settings
  // write also broadcasts via opendev:settings-changed, but we guard our
  // own load to avoid feedback loops.
  const setTransport = (t: typeof transport) => {
    setTransportState(t);
    window.opendev.settings.set({ lastAiTransport: t });
  };
  const setClaudeModel = (m: string) => {
    setClaudeModelState(m);
    window.opendev.settings.set({ claudeCliModel: m });
  };
  const setClaudeEffort = (e: string) => {
    setClaudeEffortState(e);
    window.opendev.settings.set({ claudeCliEffort: e });
  };
  // If the user disabled local AI while the chat had it selected, drop back
  // to Claude so the next send doesn't fire into a disabled transport.
  useEffect(() => {
    if (!aiLocalEnabled && transport === 'opencode-cli') setTransport('claude-cli');
  }, [aiLocalEnabled, transport]);
  const [sending, setSending] = useState(false);
  const [fontSize, setFontSizeState] = useState(loadChatFontSize);
  const setFontSize = (n: number) => {
    const v = Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, n));
    setFontSizeState(v);
    try { localStorage.setItem(CHAT_FONT_KEY, String(v)); } catch {}
  };
  const streamIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Picker / global attachments still live on the store so the BrowserPanel
  // can stash them before focus comes back. We mirror to local state below.
  const globalAttachments = useStore(s => s.chatAttachments);
  const clearGlobalAttachments = useStore(s => s.clearAttachments);
  const removeGlobalAttachment = useStore(s => s.removeAttachment);
  const showToast = useStore(s => s.showToast);
  const setAiTabConversation = useStore(s => s.setAiTabConversation);

  // Local attachment list — initialized from the global buffer the first
  // time this tab becomes active, then this tab owns them.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);

  // When this tab becomes active and there's a global pending attachment
  // (e.g. from the browser picker), absorb it into our local list and clear
  // the global buffer so a second AI tab doesn't pick up the same thing.
  useEffect(() => {
    if (!active) return;
    if (globalAttachments.length === 0) return;
    setAttachments(prev => [...prev, ...globalAttachments]);
    clearGlobalAttachments();
  }, [active, globalAttachments, clearGlobalAttachments]);

  // Load conversation messages from disk whenever convId changes.
  useEffect(() => {
    let cancelled = false;
    if (!convId) {
      setMessages([]);
      return;
    }
    window.opendev.ai.conversation(convId).then(c => {
      if (cancelled) return;
      if (!c) return;
      // Legacy conversations pre-date the per-message `provider` tag —
      // codex support was added afterwards, so any assistant message
      // without a provider must have come from claude. Backfill so the
      // label doesn't flip when the user switches the dropdown.
      setMessages(c.messages.map(m =>
        m.role === 'assistant' && !m.provider ? { ...m, provider: 'claude' as const } : m
      ));
    });
    return () => { cancelled = true; };
  }, [convId]);

  // Capture the transport used for the in-flight request so the assistant
  // message we append on `done` is stamped with the provider that actually
  // produced it — not whatever the dropdown happens to be set to when the
  // response lands.
  const inFlightProviderRef = useRef<'claude' | 'codex' | 'opencode'>('claude');

  // Stream listener — only consumes events targeted at THIS tab's request.
  useEffect(() => {
    const off = window.opendev.ai.onStream(({ streamId, chunk: c, done, full }) => {
      if (streamIdRef.current !== streamId) return;
      if (c) setStreaming(s => s + c);
      if (done) {
        const finalText = full || streamingRef.current;
        // Append final assistant message to local list.
        setMessages(prev => [...prev, {
          id: `local-${Date.now()}`,
          role: 'assistant',
          text: finalText,
          createdAt: Date.now(),
          provider: inFlightProviderRef.current
        }]);
        setStreaming('');
        setSending(false);
        streamIdRef.current = null;
        setActivity(settleActivity);
        // Auto-open design proposals if the assistant emitted them.
        const proposals = extractDesignProposals(finalText);
        if (proposals.length >= 2) {
          const tabs = useStore.getState().centerTabs;
          const active = tabs.find(t => t.id === useStore.getState().activeCenterId);
          const targetPath = active?.kind === 'file' ? active.path : undefined;
          useStore.getState().openDesignProposalsTab({ proposals, targetPath, name: `Designs (${proposals.length})` });
          useStore.getState().showToast(`${proposals.length} designs ready — pick one in the center tab.`, 3500);
        }
      }
    });
    return off;
  // intentionally exclude `streaming` from deps — we want the latest in
  // the finalize block but don't want to resubscribe on every chunk.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Activity log: one row per tool call, fed by a side channel so the chat
  // text is unaffected. Hidden unless the user opens it.
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    const off = window.opendev.ai.onActivity((m: AiActivityMsg) => {
      if (streamIdRef.current !== m.streamId) return;
      setActivity(prev => {
        const i = prev.findIndex(r => r.id === m.id);
        if (i < 0) {
          if (!m.tool) return prev;
          return [...prev, { id: m.id, tool: m.tool, target: m.target, status: m.status }].slice(-ACTIVITY_MAX);
        }
        const r = prev[i];
        const next = prev.slice();
        next[i] = {
          ...r,
          tool: m.tool || r.tool,
          target: m.target ?? r.target,
          // A late 'running' must not undo a finished call.
          status: m.status === 'running' ? r.status : m.status
        };
        return next;
      });
    });
    return off;
  }, []);

  // Auto-scroll: stay pinned to the bottom unless the user has scrolled up.
  // Scrolling once per render isn't enough — bubbles keep growing after
  // commit (markdown/code layout, images loading), and a hidden tab has no
  // layout at all until it becomes active — so a ResizeObserver on the list
  // and every bubble re-pins whenever the content height changes.
  const pinnedRef = useRef(true);
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const onListScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [messages, streaming, sending]);

  useEffect(() => {
    if (!active) return;
    pinnedRef.current = true;
    scrollToBottom();
    const raf = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (pinnedRef.current) scrollToBottom(); });
    ro.observe(el);
    Array.from(el.children).forEach(c => ro.observe(c));
    const mo = new MutationObserver(records => {
      for (const r of records) r.addedNodes.forEach(n => { if (n instanceof Element) ro.observe(n); });
      if (pinnedRef.current) scrollToBottom();
    });
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  // When user clicks "Choose this" on a design proposal: pre-fill composer
  // in the active AI tab. We gate on `active` so only the visible tab grabs
  // the message (otherwise multiple tabs would all duplicate it).
  useEffect(() => {
    if (!active) return;
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail as { name: string; targetPath?: string };
      const tail = detail.targetPath ? ` Apply it to ${detail.targetPath}.` : ' Apply it to the current file.';
      setText(`I picked "${detail.name}".${tail} Please write the real code now (don't show more previews).`);
    };
    window.addEventListener('opendev:design-chosen', h);
    return () => window.removeEventListener('opendev:design-chosen', h);
  }, [active]);

  const send = async (override?: string) => {
    // `override` lets callers (e.g. the auto-send of an initialPrompt) push
    // a message without it first living in the composer's `text` state.
    const body = override ?? text;
    if (!body.trim() && !attachments.length) return;
    // If a previous stream is still running, cancel it first so the user
    // is never trapped waiting for a hung response. Their new message
    // becomes the next user turn in the (now-resumable) session.
    if (sending && streamIdRef.current) {
      try { await window.opendev.ai.cancel(streamIdRef.current); } catch {}
      streamIdRef.current = null;
      setStreaming('');
      setActivity(settleActivity);
    }
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text: body,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now()
    };
    // Sending always jumps back to the bottom, even if the user had scrolled up.
    pinnedRef.current = true;
    setMessages(prev => [...prev, userMsg]);
    setSending(true);
    // Separate this request's calls from the previous one's.
    setActivity(prev => prev.length && !prev[prev.length - 1].divider
      ? [...prev, { id: `turn-${Date.now()}`, tool: '', status: 'ok', divider: true }]
      : prev);
    try {
      const root = useStore.getState().workspaceRoot;
      const tabs = useStore.getState().centerTabs;
      const activeId = useStore.getState().activeCenterId;
      const activeTab = tabs.find(t => t.id === activeId);
      const context = {
        workspaceRoot: root,
        activeTab: activeTab && activeTab.kind !== 'ai' ? {
          kind: activeTab.kind, name: activeTab.name,
          path: activeTab.kind === 'file' ? activeTab.path : undefined,
          contentPreview: activeTab.kind === 'file'
            ? (activeTab.dirtyContent ?? activeTab.content).slice(0, 16000)
            : undefined
        } : null,
        openTabs: tabs.filter(t => t.kind !== 'ai').map(t => ({
          kind: t.kind, name: t.name,
          path: t.kind === 'file' ? t.path : undefined,
          active: t.id === activeId
        }))
      };
      inFlightProviderRef.current = transport === 'codex-cli' ? 'codex' : transport === 'opencode-cli' ? 'opencode' : 'claude';
      const r = await window.opendev.ai.send({ conversationId: convId, text: body, attachments, transport, context, model: claudeModel || undefined, effort: claudeEffort || undefined });
      streamIdRef.current = r.streamId;
      // If main came back with a different id (it does when our convId was
      // stale and main recovered into a fresh conversation), or we had no
      // id at all, adopt the returned one and refresh the tab title.
      if (!convId || r.conversationId !== convId) {
        setConvId(r.conversationId);
        // Pull the saved conversation so the title is real (server uses
        // the first 60 chars of the message as title).
        const c = await window.opendev.ai.conversation(r.conversationId);
        if (c) {
          setAiTabConversation(tabId, r.conversationId, c.title || 'Chat');
        } else {
          setAiTabConversation(tabId, r.conversationId);
        }
      }
      setText('');
      setAttachments([]);
    } catch (e: any) {
      showToast(`AI send failed: ${e?.message || e}`, 5000);
      setMessages(prev => [...prev, {
        id: `local-err-${Date.now()}`,
        role: 'assistant',
        text: `[error] ${e?.message || e}`,
        createdAt: Date.now()
      }]);
      setSending(false);
    }
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const att = await readAsAttachment(f);
        if (att) setAttachments(prev => [...prev, att]);
        else showToast(`Skipped ${f.name}: unsupported file type.`, 3000);
      } catch (e: any) {
        showToast(`Couldn't read ${f.name}: ${e?.message || e}`, 4000);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(180, Math.max(44, el.scrollHeight)) + 'px';
  }, [text]);

  // Auto-send an initialPrompt exactly once on a fresh tab (the "+ New agent"
  // flow uses this to hand the agent-authoring prompt straight to the AI).
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (initialPromptSent.current) return;
    if (!initialPrompt || initialConversationId) return;
    initialPromptSent.current = true;
    void send(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    const h = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    window.addEventListener('opendev:focus-chat', h);
    return () => window.removeEventListener('opendev:focus-chat', h);
  }, [active]);

  const removeAttachment = (i: number) => setAttachments(prev => prev.filter((_, idx) => idx !== i));
  const clearAttachments = () => setAttachments([]);

  const attachLabel = (a: ChatAttachment) => {
    if (a.kind === 'picked-element') return `📐 ${a.cssPath}`;
    if (a.kind === 'selection') return `✂︎ ${a.path}`;
    if (a.kind === 'file') return `${a.dataUrl ? '🖼' : '📄'} ${a.name}`;
    return '';
  };

  const canStop = sending && !!streamIdRef.current;

  // All attachments visible in the composer: the local list plus any
  // global ones (only the active tab will absorb them on next render).
  const visibleAttachments = useMemo(
    () => active ? [...attachments, ...globalAttachments] : attachments,
    [active, attachments, globalAttachments]
  );

  const focusComposer = () => {
    // Don't yank focus to the composer mid-selection — focus shift cancels
    // the in-progress text selection and the user can't copy chat content.
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    textareaRef.current?.focus();
  };

  return (
    <div className="panel chat chat-center" style={{ ['--chat-font-size' as string]: `${fontSize}px` }}>
      {sending && (
        <div className="chat-banner">
          <span className="chat-banner-status">
            <span className="chat-banner-dot" aria-hidden />
            {providerLabel} is responding{streaming ? '' : ' (waiting for first chunk)'}…
          </span>
          <span className="chat-banner-hint">
            Type a follow-up below and press Enter — it will interrupt the current response and continue the same conversation.
          </span>
        </div>
      )}
      <div className="chat-list" ref={scrollRef} onScroll={onListScroll} onClick={focusComposer}>
        {messages.map(m => <ChatBubble key={m.id} message={m} fallbackProviderLabel={providerLabel} />)}
        {streaming && <ChatBubble key="streaming" message={{
          id: 'streaming', role: 'assistant', text: streaming, createdAt: Date.now(),
          provider: inFlightProviderRef.current
        }} streaming fallbackProviderLabel={providerLabel} />}
        {!messages.length && !streaming && (
          <div className="chat-empty">
            <div className="chat-empty-title">New conversation</div>
            <div className="chat-empty-sub">Press Enter to send · Shift+Enter for newline · + to attach files</div>
          </div>
        )}
      </div>

      {activityOpen && <ActivityLog rows={activity} onClose={() => setActivityOpen(false)} />}

      <div className="composer">
        {transport === 'opencode-cli' && aiLocalModel && (
          <ModelCapabilityNote model={aiLocalModel} variant="compact" />
        )}
        {visibleAttachments.length > 0 && (
          <div className="composer-chips">
            {visibleAttachments.map((a, i) => {
              const isGlobal = active && i >= attachments.length;
              return (
                <span key={i} className={`composer-chip ${a.kind === 'picked-element' ? 'picked' : ''}`}>
                  {a.kind === 'picked-element' && a.screenshotDataUrl && (
                    <img className="chip-thumb" src={a.screenshotDataUrl} alt="picked element" />
                  )}
                  {attachLabel(a)}
                  <button
                    className="chip-x"
                    onClick={() => isGlobal ? removeGlobalAttachment(i - attachments.length) : removeAttachment(i)}
                    title="Remove this attachment"
                  >×</button>
                </span>
              );
            })}
            {(attachments.length > 1 || (active && globalAttachments.length > 0 && visibleAttachments.length > 1)) && (
              <button className="composer-chip-clearall" onClick={() => { clearAttachments(); if (active) clearGlobalAttachments(); }}>
                clear all ({visibleAttachments.length})
              </button>
            )}
          </div>
        )}
        {visibleAttachments.some(a => a.kind === 'picked-element') && (
          <div className="composer-hint">
            Element attached. Type what you want {providerLabel} to do with it (e.g. "make this button bigger", "match the colors to the design at …").
          </div>
        )}

        <div className="composer-input">
          <textarea
            ref={textareaRef}
            value={text}
            placeholder={sending ? `${providerLabel} is responding — type to send a follow-up (will interrupt)` : `Ask ${providerLabel}…`}
            rows={1}
            // NEVER disable: the user must always be able to type and
            // queue/replace the next message, especially when Claude has
            // asked a question and the user needs to answer.
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>

        <div className="composer-row">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => onPickFiles(e.target.files)}
          />
          <button
            className="composer-btn ghost"
            title="Attach file (text or image)"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Attach"
          >+</button>

          <select
            className="composer-transport"
            value={transport}
            onChange={(e) => setTransport(e.target.value as typeof transport)}
            title="AI provider"
          >
            <option value="claude-cli">Claude Code</option>
            <option value="codex-cli">Codex</option>
            {aiLocalEnabled && (
              <option value="opencode-cli">{aiLocalModel ? `OpenCode · ${aiLocalModel}` : 'OpenCode (local)'}</option>
            )}
          </select>

          {transport === 'claude-cli' && (
            <>
              <select
                className="composer-transport"
                value={claudeModel}
                onChange={(e) => setClaudeModel(e.target.value)}
                title="Claude model"
              >
                <option value="">Model: default</option>
                <option value="claude-fable-5-1">Fable 5.1</option>
                <option value="claude-opus-5-5">Opus 5.5</option>
                <option value="claude-sonnet-5">Sonnet 5</option>
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
              </select>
              <select
                className="composer-transport"
                value={claudeEffort}
                onChange={(e) => setClaudeEffort(e.target.value)}
                title="Reasoning effort"
              >
                <option value="">Reasoning: default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
                <option value="max">Max</option>
              </select>
            </>
          )}

          <span className="composer-spacer" />

          {activity.some(r => !r.divider) && (
            <button
              className={`composer-activity${activityOpen ? ' on' : ''}`}
              onClick={() => setActivityOpen(o => !o)}
              title={activityOpen ? 'Hide the activity log' : 'Show which files and tools the AI is using'}
              aria-expanded={activityOpen}
            >
              {sending && activity.some(r => r.status === 'running') && <span className="composer-activity-dot" aria-hidden />}
              Activity {activity.filter(r => !r.divider).length}
            </button>
          )}

          <span className="composer-size">
            <button onClick={() => setFontSize(fontSize - 1)} disabled={fontSize <= CHAT_FONT_MIN} title="Smaller chat text" aria-label="Smaller text">A−</button>
            <button onClick={() => setFontSize(fontSize + 1)} disabled={fontSize >= CHAT_FONT_MAX} title="Bigger chat text" aria-label="Bigger text">A+</button>
          </span>

          {canStop && (
            <button
              className="composer-btn stop"
              onClick={() => {
                if (streamIdRef.current) window.opendev.ai.cancel(streamIdRef.current);
                streamIdRef.current = null;
                setSending(false);
                setStreaming('');
                setActivity(settleActivity);
              }}
              title="Stop the current response"
              aria-label="Stop"
            >■ Stop</button>
          )}

          <button
            className="composer-btn send"
            onClick={() => send()}
            // Always allow send — if a stream is running, send() will
            // cancel it first. Only block when there's nothing to send.
            disabled={!text.trim() && visibleAttachments.length === 0}
            title={sending ? 'Interrupt current response and send this' : 'Send (Enter)'}
            aria-label="Send"
          >
            {sending ? '↑!' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Activity log — the optional per-tab list of tool calls and their targets.
// =====================================================================

type ActivityRow = {
  id: string;
  tool: string;
  target?: string;
  status: AiActivityMsg['status'] | 'stopped';
  divider?: boolean;
};
const ACTIVITY_MAX = 300;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// When a response ends, anything still "running" never reported back.
function settleActivity(rows: ActivityRow[]): ActivityRow[] {
  return rows.some(r => r.status === 'running')
    ? rows.map(r => r.status === 'running' ? { ...r, status: 'stopped' } : r)
    : rows;
}

function relativeTo(root: string | null | undefined, p: string): string {
  if (!root) return p;
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const r = norm(root).replace(/\/+$/, '') + '/';
  return norm(p).startsWith(r) ? p.slice(r.length) : p;
}

function ActivityLog({ rows, onClose }: { rows: ActivityRow[]; onClose: () => void }) {
  const root = useStore(s => s.workspaceRoot);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [rows]);
  const open = async (path: string) => {
    try {
      const content = await window.opendev.fs.read(path);
      useStore.getState().openFileTab(path, content);
    } catch (e: any) {
      useStore.getState().showToast(`Couldn't open ${path}: ${e?.message || e}`, 3000);
    }
  };
  return (
    <div className="chat-activity">
      <div className="chat-activity-head">
        <span>Activity</span>
        <button onClick={onClose} title="Hide" aria-label="Hide activity log">×</button>
      </div>
      <div
        className="chat-activity-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
        }}
      >
        {rows.map(r => {
          if (r.divider) return <div key={r.id} className="chat-activity-divider" />;
          const isFile = FILE_TOOLS.has(r.tool) && !!r.target;
          const icon = r.status === 'running' ? '…' : r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '–';
          return (
            <div key={r.id} className={`chat-activity-row ${r.status}`}>
              <span className="chat-activity-icon" aria-label={r.status}>{icon}</span>
              <span className="chat-activity-tool">{r.tool}</span>
              {r.target && (isFile
                ? <button className="chat-activity-target file" onClick={() => open(r.target!)} title={`Open ${r.target}`}>{relativeTo(root, r.target)}</button>
                : <span className="chat-activity-target" title={r.target}>{r.target}</span>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =====================================================================
// ChatBubble — renders one message with role-distinct visual style. The
// markdown itself lives in components/ChatMarkdown.
// =====================================================================

// Memoized: during a stream only the live bubble changes, so the settled
// history must not re-parse its markdown on every flushed chunk.
const ChatBubble = memo(function ChatBubble({ message, streaming, fallbackProviderLabel }: { message: ChatMessage; streaming?: boolean; fallbackProviderLabel: string }) {
  const isUser = message.role === 'user';
  // Prefer the provider stamped on the message itself (so old turns retain
  // their original label after the user switches transports). Fall back to
  // the composer's current label for legacy messages without `provider`.
  const messageProviderLabel = message.provider === 'codex' ? 'Codex' :
    message.provider === 'claude' ? 'Claude' :
    message.provider === 'opencode' ? 'OpenCode' : fallbackProviderLabel;
  const isError = !isUser && message.text.startsWith('[error]');
  return (
    <div className={`bubble-row ${isUser ? 'user' : 'assistant'}`}>
      <div className={`bubble-avatar${isUser ? '' : ` provider-${messageProviderLabel.toLowerCase()}`}`} aria-hidden>
        {isUser ? 'You' : messageProviderLabel.slice(0, 1)}
      </div>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}${isError ? ' bubble-error' : ''}`}>
        <div className="bubble-meta">
          <span className="bubble-role">{isUser ? 'You' : messageProviderLabel}</span>
          <span className="bubble-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {streaming && <span className="bubble-streaming">● writing</span>}
        </div>
        <div className="bubble-body">
          <Markdown text={message.text} />
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="bubble-attachments">
            {message.attachments.map((a, i) => (
              <span key={i} className="bubble-attachment">
                {a.kind === 'selection' && `✂︎ ${a.path}`}
                {a.kind === 'picked-element' && `📐 ${a.cssPath}`}
                {a.kind === 'file' && `${a.dataUrl ? '🖼' : '📄'} ${a.name}`}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
