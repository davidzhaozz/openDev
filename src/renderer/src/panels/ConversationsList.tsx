import { useState } from 'react';
import { useStore } from '../state/store';
import { useVisiblePoll } from '../usePoll';
import type { Conversation } from '../../../shared/types';

function relativeTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Side panel showing every saved conversation. Click → opens it in a new
// center tab (or focuses the existing tab if already open).
export function ConversationsList() {
  const [history, setHistory] = useState<Conversation[]>([]);
  const tabs = useStore(s => s.centerTabs);
  const openAiChatTab = useStore(s => s.openAiChatTab);
  const closeCenterTab = useStore(s => s.closeCenterTab);
  const renameCenterTab = useStore(s => s.renameCenterTab);
  const showToast = useStore(s => s.showToast);
  // id of the row being renamed, plus its draft title.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const refresh = async () => {
    try {
      const list = await window.opendev.ai.conversations();
      setHistory(list);
    } catch {}
  };

  // Refresh so conversations created in a center AI tab show up here without a
  // page reload. Every tick re-reads the conversation store from disk, so it
  // pauses with the window: nothing can be created from a window nobody can
  // see, and the tick on becoming visible again catches anything that was.
  useVisiblePoll(refresh, 4000);

  const startRename = (c: Conversation) => {
    setRenaming(c.id);
    setDraft(c.title || '');
  };

  const commitRename = async () => {
    const id = renaming;
    if (!id) return;
    const title = draft.trim();
    const current = history.find(c => c.id === id);
    setRenaming(null);
    if (!title || title === current?.title) return;
    // Paint the new name immediately; the poll would otherwise take up to
    // four seconds to catch up.
    setHistory(prev => prev.map(c => (c.id === id ? { ...c, title } : c)));
    // An open tab on this conversation shows the old title until it is
    // reopened, so keep the two in step.
    for (const t of useStore.getState().centerTabs) {
      if (t.kind === 'ai' && t.conversationId === id) renameCenterTab(t.id, title);
    }
    try {
      const ok = await window.opendev.ai.renameConversation(id, title);
      if (!ok) showToast('Rename failed — the conversation file is gone.', 4000);
    } catch (e: any) {
      showToast(`Rename failed: ${e?.message || e}`, 4000);
    }
    refresh();
  };

  const openConv = (c: Conversation) => {
    openAiChatTab({ conversationId: c.id, name: c.title || 'Chat' });
  };

  const newChat = () => {
    openAiChatTab({});
  };

  // Close every center tab whose AI conversation matches any of `ids`. Run
  // before the disk delete so the renderer doesn't briefly point a tab at
  // a missing file. Uses the live store state to avoid stale closure.
  const closeMatchingTabs = (ids: Set<string>) => {
    const cur = useStore.getState().centerTabs;
    for (const t of cur) {
      if (t.kind === 'ai' && t.conversationId && ids.has(t.conversationId)) {
        closeCenterTab(t.id);
      }
    }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    closeMatchingTabs(new Set([id]));
    await window.opendev.ai.deleteConversation(id);
    refresh();
  };

  const delAll = async () => {
    if (!history.length) return;
    if (!confirm(`Delete all ${history.length} conversations? This cannot be undone.`)) return;
    closeMatchingTabs(new Set(history.map(c => c.id)));
    for (const c of history) await window.opendev.ai.deleteConversation(c.id);
    refresh();
    showToast('All conversations deleted', 2000);
  };

  const openConvIds = new Set(tabs.flatMap(t => t.kind === 'ai' && t.conversationId ? [t.conversationId] : []));

  return (
    <div className="panel cv-panel">
      <div className="cv-head">
        <button className="cv-new" onClick={newChat}>＋ New chat</button>
        <span className="cv-grow" />
        <button className="cv-deleteall" disabled={!history.length} onClick={delAll}>Delete all</button>
      </div>
      <div className="cv-list">
        {history.map(c => {
          const open = openConvIds.has(c.id);
          const isRenaming = renaming === c.id;
          return (
            <div key={c.id} className={`cv-row ${open ? 'open' : ''}`} onClick={() => {
              if (isRenaming) return;
              // Skip the open action if the user is selecting text in the row
              // — otherwise mouse-up ends the selection AND fires this handler,
              // which navigates away before they can copy.
              const sel = window.getSelection();
              if (sel && sel.toString().length > 0) return;
              openConv(c);
            }}>
              <div className="cv-text">
                {isRenaming ? (
                  <input
                    autoFocus
                    className="cv-rename"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <div
                    className="cv-title"
                    title="Double-click to rename"
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(c); }}
                  >
                    {open && <span className="cv-open-dot">●</span>}
                    {c.title || 'Untitled'}
                  </div>
                )}
                <div className="cv-sub">
                  {relativeTime(c.updatedAt)} · {c.messageCount ?? c.messages.length} msg
                </div>
              </div>
              <button
                className="cv-edit"
                onClick={(e) => { e.stopPropagation(); startRename(c); }}
                title="Rename"
              >✎</button>
              <button
                className="cv-del"
                onClick={(e) => { e.stopPropagation(); del(c.id); }}
                title="Delete"
              >✕</button>
            </div>
          );
        })}
        {!history.length && (
          <div className="cv-empty">
            <div className="cv-empty-title">No conversations yet</div>
            <div className="cv-empty-sub">Click + New chat to start one.</div>
          </div>
        )}
      </div>
    </div>
  );
}
