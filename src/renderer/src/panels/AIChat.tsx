import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type DesignProposal } from '../state/store';
import type { ChatAttachment, ChatMessage } from '../../../shared/types';

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
  const [text, setText] = useState('');
  const [transport, setTransport] = useState<'claude-cli' | 'codex-cli'>('claude-cli');
  const providerLabel = transport === 'codex-cli' ? 'Codex' : 'Claude';
  const [sending, setSending] = useState(false);
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
  const inFlightProviderRef = useRef<'claude' | 'codex'>('claude');

  // Stream listener — only consumes events targeted at THIS tab's request.
  useEffect(() => {
    const off = window.opendev.ai.onStream(({ streamId, chunk: c, done, full }) => {
      if (streamIdRef.current !== streamId) return;
      if (c) setStreaming(s => s + c);
      if (done) {
        const finalText = full || streaming;
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

  // Auto-scroll on new content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming]);

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
    }
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text: body,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);
    setSending(true);
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
      inFlightProviderRef.current = transport === 'codex-cli' ? 'codex' : 'claude';
      const r = await window.opendev.ai.send({ conversationId: convId, text: body, attachments, transport, context });
      streamIdRef.current = r.streamId;
      if (!convId) {
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

  const focusComposer = () => textareaRef.current?.focus();

  return (
    <div className="panel chat chat-center">
      {sending && (
        <div className="chat-banner">
          <span>
            {providerLabel} is responding{streaming ? '' : ' (waiting for first chunk)'}…
          </span>
          <span className="chat-banner-hint">
            Type a follow-up below and press Enter — it will interrupt the current response and continue the same conversation.
          </span>
        </div>
      )}
      <div className="chat-list" ref={scrollRef} onClick={focusComposer}>
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

      <div className="composer">
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
          </select>

          <span className="composer-spacer" />

          {canStop && (
            <button
              className="composer-btn stop"
              onClick={() => {
                if (streamIdRef.current) window.opendev.ai.cancel(streamIdRef.current);
                streamIdRef.current = null;
                setSending(false);
                setStreaming('');
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
// ChatBubble — renders one message with role-distinct visual style and a
// light markdown pass (code fences, inline code, bold/italic, lists).
// =====================================================================

function ChatBubble({ message, streaming, fallbackProviderLabel }: { message: ChatMessage; streaming?: boolean; fallbackProviderLabel: string }) {
  const isUser = message.role === 'user';
  // Prefer the provider stamped on the message itself (so old turns retain
  // their original label after the user switches transports). Fall back to
  // the composer's current label for legacy messages without `provider`.
  const messageProviderLabel = message.provider === 'codex' ? 'Codex' :
    message.provider === 'claude' ? 'Claude' : fallbackProviderLabel;
  return (
    <div className={`bubble-row ${isUser ? 'user' : 'assistant'}`}>
      <div className="bubble-avatar" aria-hidden>{isUser ? 'You' : 'AI'}</div>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}`}>
        <div className="bubble-meta">
          <span className="bubble-role">{isUser ? 'You' : messageProviderLabel}</span>
          <span className="bubble-time">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {streaming && <span className="bubble-streaming">●</span>}
        </div>
        <div className="bubble-body">
          <RenderedMarkdown text={message.text} />
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
}

// Minimal markdown renderer — fenced code blocks, inline code,
// bold/italic, bullet lists, and tool-trace lines from the stream-json
// parser. We avoid pulling in a heavy markdown library; the chat doesn't
// need full CommonMark and this keeps the bundle lean.
function RenderedMarkdown({ text }: { text: string }) {
  // Split on triple-backtick fences first so we never apply inline
  // formatting inside code blocks.
  const segments: Array<{ kind: 'code'; lang: string; body: string } | { kind: 'text'; body: string }> = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ kind: 'text', body: text.slice(last, m.index) });
    segments.push({ kind: 'code', lang: m[1].trim(), body: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', body: text.slice(last) });

  return (
    <>
      {segments.map((s, i) => s.kind === 'code'
        ? <CodeBlock key={i} lang={s.lang} body={s.body} />
        : <InlineText key={i} body={s.body} />)}
    </>
  );
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  const showCopy = body.length > 0;
  const copy = () => {
    try { navigator.clipboard.writeText(body); } catch {}
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'code'}</span>
        {showCopy && <button className="md-code-copy" onClick={copy}>Copy</button>}
      </div>
      <pre><code>{body}</code></pre>
    </div>
  );
}

// Renders one "text" segment with: inline code (`x`), bold (**x**),
// italic (*x*), bullet lists, and the tool-trace markers we emit from
// ai.ts (`› using tool:` and `  ↳ result`).
function InlineText({ body }: { body: string }) {
  // Render line by line so list/tool-trace formatting works.
  const lines = body.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        if (/^›\s+using tool:/i.test(trimmed)) {
          return <div key={i} className="md-tool-call">{trimmed}</div>;
        }
        if (/^↳\s/.test(trimmed) || /^\s+↳\s/.test(line)) {
          return <div key={i} className="md-tool-result">{trimmed}</div>;
        }
        if (/^[-*]\s+/.test(trimmed)) {
          return <div key={i} className="md-li">• {renderInline(trimmed.replace(/^[-*]\s+/, ''))}</div>;
        }
        if (/^\d+\.\s+/.test(trimmed)) {
          return <div key={i} className="md-li">{trimmed.match(/^\d+/)?.[0]}. {renderInline(trimmed.replace(/^\d+\.\s+/, ''))}</div>;
        }
        if (line === '') return <br key={i} />;
        return <div key={i} className="md-line">{renderInline(line)}</div>;
      })}
    </>
  );
}

function renderInline(s: string) {
  // Tokenize: inline code (`x`), bold (**x**), italic (*x*), then plain.
  const parts: Array<JSX.Element | string> = [];
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { parts.push(buf); buf = ''; } };
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        flush();
        parts.push(<code key={parts.length} className="md-inline-code">{s.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i) {
        flush();
        parts.push(<strong key={parts.length}>{s.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (s[i] === '*') {
      const end = s.indexOf('*', i + 1);
      if (end > i) {
        flush();
        parts.push(<em key={parts.length}>{s.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  return <>{parts}</>;
}
