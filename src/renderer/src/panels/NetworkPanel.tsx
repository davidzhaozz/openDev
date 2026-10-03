import { useEffect, useMemo, useRef, useState } from 'react';
import type { NetEntrySummary } from '../../../shared/types';
import { useStore } from '../state/store';

// NETWORK tab — every HTTP call the IDE made, plus the browser panel's own
// XHR/fetch traffic, newest last. The list is deliberately summary-only;
// clicking a row opens the full request/response in a center tab.

type SourceFilter = 'all' | 'ide' | 'browser';

const STATUS_FILTERS = ['all', 'error'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

function statusClass(e: NetEntrySummary): string {
  if (e.error) return 'err';
  if (e.pending || e.status == null) return 'pending';
  if (e.status >= 500) return 'err';
  if (e.status >= 400) return 'warn';
  if (e.status >= 300) return 'redir';
  return 'ok';
}

function fmtDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtSize(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Last path segment, for a label that stays readable in a narrow column. */
function shortPath(p: string): string {
  const noQuery = p.split('?')[0];
  const parts = noQuery.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  return tail ? `/${tail}` : '/';
}

export function NetworkPanel() {
  const [entries, setEntries] = useState<NetEntrySummary[]>([]);
  const [source, setSource] = useState<SourceFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState(true);
  const [follow, setFollow] = useState(true);
  const openNetTab = useStore((s) => s.openNetTab);
  const showToast = useStore((s) => s.showToast);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.opendev.network.list().then(setEntries).catch(() => {});
    window.opendev.network.captureState().then(setCapturing).catch(() => {});
    const offEntry = window.opendev.network.onEntry((e) => {
      // Same id arrives again when the response lands — replace in place so
      // a row updates from "pending" to its final status without moving.
      setEntries((cur) => {
        const i = cur.findIndex((x) => x.id === e.id);
        if (i === -1) return [...cur, e];
        const next = cur.slice();
        next[i] = e;
        return next;
      });
    });
    const offCleared = window.opendev.network.onCleared(() => setEntries([]));
    const offState = window.opendev.network.onCaptureState(setCapturing);
    return () => { offEntry(); offCleared(); offState(); };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (source !== 'all' && e.source !== source) return false;
      if (status === 'error' && !e.error && !(e.status && e.status >= 400)) return false;
      if (!q) return true;
      return e.url.toLowerCase().includes(q)
        || e.method.toLowerCase().includes(q)
        || e.origin.toLowerCase().includes(q)
        || String(e.status ?? '').includes(q);
    });
  }, [entries, source, status, query]);

  // Auto-scroll only while the user is parked at the bottom, so reading an
  // older row isn't yanked away by fresh traffic.
  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const clear = async () => {
    await window.opendev.network.clear().catch(() => {});
    setEntries([]);
  };

  const toggleCapture = async () => {
    const next = !capturing;
    try {
      setCapturing(await window.opendev.network.setCapture(next));
      if (!next) showToast('Network capture paused — the browser panel gets its DevTools back', 4000);
    } catch (e: any) {
      showToast(`Could not change capture: ${e?.message || e}`, 4000);
    }
  };

  const errorCount = entries.filter((e) => e.error || (e.status && e.status >= 400)).length;

  return (
    <div className="net-panel">
      <div className="net-toolbar">
        <button
          className={`net-record ${capturing ? 'on' : 'off'}`}
          onClick={toggleCapture}
          title={capturing ? 'Capturing — click to pause' : 'Paused — click to resume'}
        >{capturing ? '⏸' : '⏵'}</button>
        <input
          className="net-search"
          value={query}
          placeholder="Filter URL, method, status…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="net-clear" onClick={clear} title="Clear the network log">Clear</button>
      </div>

      <div className="net-filters">
        {(['all', 'ide', 'browser'] as const).map((k) => (
          <button
            key={k}
            className={`net-chip ${source === k ? 'active' : ''}`}
            onClick={() => setSource(k)}
            title={k === 'ide' ? "openDev's own API calls" : k === 'browser' ? 'API calls made by pages in the Browser panel' : 'Everything'}
          >{k === 'all' ? 'All' : k === 'ide' ? 'IDE' : 'Browser'}</button>
        ))}
        <span className="grow" />
        {errorCount > 0 && (
          <button
            className={`net-chip errors ${status === 'error' ? 'active' : ''}`}
            onClick={() => setStatus(status === 'error' ? 'all' : 'error')}
            title="Show only failures and 4xx/5xx"
          >{errorCount} failed</button>
        )}
        <span className="net-count">{filtered.length}/{entries.length}</span>
      </div>

      <div className="net-list" ref={listRef} onScroll={onScroll}>
        {filtered.length === 0 && (
          <div className="net-empty">
            {entries.length === 0
              ? (capturing
                  ? 'No API calls captured yet. Send a REST request, open a Jira board, or trigger an XHR/fetch in the Browser panel.'
                  : 'Capture is paused.')
              : 'Nothing matches this filter.'}
          </div>
        )}
        {filtered.map((e) => (
          <div
            key={e.id}
            className="net-row"
            onClick={() => openNetTab(e.id, `${e.method} ${shortPath(e.path)}`)}
            title={`${e.method} ${e.url}`}
          >
            <span className={`net-status ${statusClass(e)}`}>
              {e.error ? '!' : e.pending ? '···' : e.status ?? '—'}
            </span>
            <span className="net-method">{e.method}</span>
            <span className="net-path">
              <span className="net-path-main">{shortPath(e.path)}</span>
              <span className="net-path-host">{e.host || e.origin}</span>
            </span>
            <span className="net-meta">
              <span className={`net-origin ${e.source}`}>{e.origin}</span>
              <span className="net-dur">{fmtDuration(e.durationMs)}</span>
              {e.responseSize != null && <span className="net-size">{fmtSize(e.responseSize)}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
