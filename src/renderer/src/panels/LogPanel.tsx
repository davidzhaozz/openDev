import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';

// Unified bubble timeline of every line of stdout/stderr from every
// running service. Updated live as services emit log chunks. Useful for
// AI-driven debugging: ask the assistant to "log what's happening across
// the app", it instruments multiple services, then this panel shows every
// event in one place.
export function LogPanel() {
  const bubbles = useStore(s => s.logBubbles);
  const services = useStore(s => s.services);
  const clear = useStore(s => s.clearLogBubbles);
  const [filter, setFilter] = useState('');
  const [minSeverity, setMinSeverity] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [pinnedService, setPinnedService] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement | null>(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of services) m.set(s.id, s.name);
    return m;
  }, [services]);

  // Apply filter + severity + pinned-service filters.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sevRank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
    const minRank = minSeverity === 'all' ? -1 : sevRank[minSeverity];
    return bubbles.filter(b => {
      if (pinnedService && b.serviceId !== pinnedService) return false;
      if (minRank >= 0 && sevRank[b.severity] < minRank) return false;
      if (q && !b.text.toLowerCase().includes(q) && !(nameById.get(b.serviceId) || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [bubbles, filter, minSeverity, pinnedService, nameById]);

  // Auto-scroll to bottom when new bubbles arrive.
  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  // Detect user scroll-up to disengage auto-scroll, re-engage at bottom.
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  // Tally counts per severity for the header badges.
  const counts = useMemo(() => {
    let info = 0, warn = 0, error = 0;
    for (const b of bubbles) {
      if (b.severity === 'error') error++;
      else if (b.severity === 'warn') warn++;
      else info++;
    }
    return { info, warn, error };
  }, [bubbles]);

  // Distinct service IDs that have produced at least one bubble.
  const sourceServices = useMemo(() => {
    const set = new Set<string>();
    for (const b of bubbles) set.add(b.serviceId);
    return [...set];
  }, [bubbles]);

  const fmt = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };

  return (
    <div className="panel log-panel">
      <div className="log-header">
        <span className="log-title">LOG</span>
        <span className="log-counts">
          <span className="log-count info">{counts.info}</span>
          <span className="log-count warn">{counts.warn}</span>
          <span className="log-count error">{counts.error}</span>
        </span>
        <span className="grow" />
        <button className="log-clear" onClick={clear} title="Clear log buffer">Clear</button>
      </div>

      <div className="log-filters">
        <input
          className="log-filter-input"
          placeholder="Filter text / service…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="log-sev" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as typeof minSeverity)}>
          <option value="all">all</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">errors only</option>
        </select>
      </div>

      {sourceServices.length > 1 && (
        <div className="log-chips">
          <button
            className={`log-chip ${!pinnedService ? 'active' : ''}`}
            onClick={() => setPinnedService(undefined)}
          >all</button>
          {sourceServices.map(id => (
            <button
              key={id}
              className={`log-chip ${pinnedService === id ? 'active' : ''}`}
              onClick={() => setPinnedService(prev => prev === id ? undefined : id)}
              title={id}
            >{nameById.get(id) || id.slice(0, 8)}</button>
          ))}
        </div>
      )}

      <div className="log-list" ref={listRef} onScroll={onScroll}>
        {visible.length === 0 && (
          <div className="log-empty">
            {bubbles.length === 0 ? 'No log activity yet. Start a service to see events here.' : 'No bubbles match the current filter.'}
          </div>
        )}
        {visible.map((b) => (
          <div key={b.id} className={`log-bubble sev-${b.severity}`}>
            <div className="log-bubble-head">
              <span className="log-bubble-time">{fmt(b.ts)}</span>
              <span className="log-bubble-svc">{nameById.get(b.serviceId) || b.serviceId.slice(0, 8)}</span>
              <span className={`log-bubble-sev sev-${b.severity}`}>{b.severity}</span>
            </div>
            <div className="log-bubble-text">{b.text}</div>
          </div>
        ))}
      </div>

      {!autoScroll && bubbles.length > 0 && (
        <button
          className="log-resume-scroll"
          onClick={() => {
            setAutoScroll(true);
            const el = listRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >↓ Jump to latest</button>
      )}
    </div>
  );
}
