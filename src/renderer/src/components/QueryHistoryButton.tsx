import { useEffect, useRef, useState } from 'react';
import type { QueryHistoryEntry, QueryHistoryKind } from '../../../shared/types';

// Toolbar button that opens a popover with the recent SQL/ES queries for
// this workspace. Click an entry to load it into the editor; click the
// trash to wipe history. Used by both SqlWorkspace and EsWorkspace.

type Props = {
  kind: QueryHistoryKind;
  // Allows the parent to subscribe to "I just ran something, refresh me".
  refreshKey?: number;
  onPick: (text: string) => void;
};

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)';
}

export function QueryHistoryButton({ kind, refreshKey, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([]);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Load history when opening the popover or after a new run.
  useEffect(() => {
    if (!open && refreshKey == null) return;
    window.opendev.history.read(kind).then(setEntries).catch(() => setEntries([]));
  }, [open, refreshKey, kind]);

  // Click-outside close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const clearAll = async () => {
    await window.opendev.history.clear(kind);
    setEntries([]);
  };

  return (
    <div className="qh-wrap" ref={popRef}>
      <button className="qh-button" onClick={() => setOpen((v) => !v)} title="Query history">
        History {entries.length > 0 && <span className="qh-count">{entries.length}</span>}
      </button>
      {open && (
        <div className="qh-pop">
          <div className="qh-pop-head">
            <span>Recent queries</span>
            <span style={{ flex: 1 }} />
            {entries.length > 0 && (
              <button className="qh-clear" onClick={clearAll} title="Clear history">Clear</button>
            )}
          </div>
          {entries.length === 0 ? (
            <div className="qh-empty">No history yet — run a query and it'll appear here.</div>
          ) : (
            <div className="qh-list">
              {entries.map((e) => (
                <div
                  key={e.id}
                  className={`qh-item ${e.ok ? '' : 'err'}`}
                  onClick={() => { onPick(e.text); setOpen(false); }}
                  title={e.text}
                >
                  <div className="qh-row">
                    <span className="qh-prev">{e.esMethod ? `${e.esMethod} ${e.esPath} · ` : ''}{preview(e.text)}</span>
                  </div>
                  <div className="qh-meta">
                    <span>{relTime(e.runAt)}</span>
                    {typeof e.durationMs === 'number' && <span>{e.durationMs} ms</span>}
                    {typeof e.rowCount === 'number' && <span>{e.rowCount} row{e.rowCount === 1 ? '' : 's'}</span>}
                    {typeof e.status === 'number' && <span>HTTP {e.status}</span>}
                    {!e.ok && <span className="qh-bad">error</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
