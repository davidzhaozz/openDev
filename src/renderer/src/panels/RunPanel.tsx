import { useEffect, useRef, useState } from 'react';
import type { RunSession } from '../../../shared/types';
import { useStore } from '../state/store';

// Bottom-bar Run panel. Each Run produces a new session; sessions live in a
// row of pills above the log pane. Click a pill to view its output. The
// active session auto-switches when a fresh run starts. Output autoscrolls
// while it's already pinned to the bottom; freezes when the user scrolls up.

type SessionView = RunSession & { log: string };

export function RunPanel() {
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [activeId, setActiveId] = useState<string | undefined>();
  const showToast = useStore((s) => s.showToast);
  const logRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);

  // Replay live sessions on mount — the user might switch to this tab
  // after kicking off a run from elsewhere.
  useEffect(() => {
    let alive = true;
    (async () => {
      const live = await window.opendev.runs.listSessions();
      if (!alive) return;
      const map: Record<string, SessionView> = {};
      await Promise.all(live.map(async (s) => {
        const log = await window.opendev.runs.logReplay(s.id);
        map[s.id] = { ...s, log };
      }));
      setSessions(map);
      // Default to the most-recent session.
      const mostRecent = live.sort((a, b) => b.startedAt - a.startedAt)[0];
      if (mostRecent) setActiveId(mostRecent.id);
    })();
    return () => { alive = false; };
  }, []);

  // Subscribe to log/status events.
  useEffect(() => {
    const offLog = window.opendev.runs.onLog(({ id, chunk }) => {
      setSessions((prev) => {
        const cur = prev[id];
        if (!cur) {
          // Status event hasn't arrived yet — buffer the chunk under a placeholder.
          return { ...prev, [id]: { id, configId: '', configName: '', status: 'running', startedAt: Date.now(), log: chunk } };
        }
        return { ...prev, [id]: { ...cur, log: (cur.log + chunk).slice(-200_000) } };
      });
    });
    const offStatus = window.opendev.runs.onStatus((s) => {
      setSessions((prev) => {
        const existing = prev[s.id];
        return { ...prev, [s.id]: { ...s, log: existing?.log ?? '' } as SessionView };
      });
      if (s.status === 'starting' || s.status === 'running') {
        // Auto-switch focus to the freshly-started run.
        setActiveId((cur) => cur === s.id ? cur : s.id);
      }
    });
    return () => { offLog(); offStatus(); };
  }, []);

  // Autoscroll the log pane when the user hasn't scrolled away.
  useEffect(() => {
    const el = logRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [activeId, activeId ? sessions[activeId]?.log : '']);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  };

  const active = activeId ? sessions[activeId] : undefined;
  const sortedSessions = Object.values(sessions).sort((a, b) => a.startedAt - b.startedAt);

  const clearAll = () => {
    setSessions((prev) => {
      const next: Record<string, SessionView> = {};
      for (const [id, s] of Object.entries(prev)) if (s.status === 'starting' || s.status === 'running') next[id] = s;
      return next;
    });
    if (active && active.status !== 'starting' && active.status !== 'running') setActiveId(undefined);
  };

  const closeOne = (id: string) => {
    setSessions((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    if (activeId === id) {
      const others = Object.keys(sessions).filter((x) => x !== id);
      setActiveId(others[others.length - 1]);
    }
  };

  const stop = async (id: string) => {
    try { await window.opendev.runs.stop(id); }
    catch (e: any) { showToast(`Stop failed: ${e?.message || e}`, 4000); }
  };

  return (
    <div className="panel run-panel">
      <div className="panel-header">
        <span>Run</span>
        <span className="grow" />
        <button onClick={clearAll} title="Clear finished sessions">Clear</button>
      </div>
      <div className="run-sessions">
        {sortedSessions.length === 0 ? (
          <span style={{ color: 'var(--fg-3)', fontSize: 11.5 }}>No runs yet. Pick a config and hit ▶ Run.</span>
        ) : sortedSessions.map((s) => (
          <div
            key={s.id}
            className={`run-pill ${s.status} ${s.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(s.id)}
            title={`${s.configName} · ${s.status}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}`}
          >
            <span className={`run-dot ${s.status}`} />
            <span className="run-name">{s.configName || s.id.slice(0, 8)}</span>
            {(s.status === 'starting' || s.status === 'running')
              ? <span className="run-x" onClick={(e) => { e.stopPropagation(); stop(s.id); }} title="Stop">■</span>
              : <span className="run-x" onClick={(e) => { e.stopPropagation(); closeOne(s.id); }} title="Close">✕</span>}
          </div>
        ))}
      </div>
      <pre ref={logRef} onScroll={onScroll} className="run-log">
        {active?.log || (active ? '(no output yet)' : 'Select a run above to view its output.')}
        {active && (active.status === 'stopped' || active.status === 'error') && (
          <span style={{ color: active.status === 'error' ? 'var(--danger)' : 'var(--fg-3)' }}>
            {'\n\n[exit '}{active.exitCode == null ? 'signal' : active.exitCode}{active.lastError ? `: ${active.lastError}` : ''}{']'}
          </span>
        )}
      </pre>
    </div>
  );
}
