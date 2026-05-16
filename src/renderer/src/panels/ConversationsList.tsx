import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
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
  const showToast = useStore(s => s.showToast);

  const refresh = async () => {
    try {
      const list = await window.opendev.ai.conversations();
      setHistory(list);
    } catch {}
  };

  useEffect(() => { refresh(); }, []);

  // Refresh when the center tabs change — new conversations created in a
  // center AI tab should show up here without a page reload.
  useEffect(() => {
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

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
          return (
            <div key={c.id} className={`cv-row ${open ? 'open' : ''}`} onClick={() => {
              // Skip the open action if the user is selecting text in the row
              // — otherwise mouse-up ends the selection AND fires this handler,
              // which navigates away before they can copy.
              const sel = window.getSelection();
              if (sel && sel.toString().length > 0) return;
              openConv(c);
            }}>
              <div className="cv-text">
                <div className="cv-title">
                  {open && <span className="cv-open-dot">●</span>}
                  {c.title || 'Untitled'}
                </div>
                <div className="cv-sub">
                  {relativeTime(c.updatedAt)} · {c.messages.length} msg
                </div>
              </div>
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
