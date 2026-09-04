import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { DebugVar, Scope } from '../../../shared/types';
import { baseName } from '@shared/paths';

// The "DEBUG" right-panel tab — call stack, variables (lazy-expanded scopes),
// watch, breakpoints, console. The global debug event subscription that
// keeps the store in sync lives in App.tsx so the data is correct whether
// or not this panel is mounted.

export function DebugPanel() {
  const session = useStore((s) => s.debugSession);
  const paused = useStore((s) => s.debugPaused);
  const selectedFrameId = useStore((s) => s.debugSelectedFrameId);
  const selectFrame = useStore((s) => s.selectDebugFrame);
  const breakpoints = useStore((s) => s.breakpoints);
  const toggleBreakpoint = useStore((s) => s.toggleBreakpoint);
  const debugConsole = useStore((s) => s.debugConsole);
  const clearConsole = useStore((s) => s.clearDebugConsole);
  const watches = useStore((s) => s.debugWatches);
  const addWatch = useStore((s) => s.addDebugWatch);
  const removeWatch = useStore((s) => s.removeDebugWatch);
  const setPendingJump = useStore((s) => s.setPendingJump);

  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeVars, setScopeVars] = useState<Record<string, DebugVar[] | 'loading'>>({});
  const [watchValues, setWatchValues] = useState<Record<string, string>>({});
  const [watchInput, setWatchInput] = useState('');

  // Re-fetch scopes on each pause / frame switch.
  useEffect(() => {
    setScopes([]);
    setScopeVars({});
    if (!paused || !selectedFrameId) return;
    let cancelled = false;
    window.opendev.debug.request<{ scopes: Scope[] }>('getScopes', { frameId: selectedFrameId })
      .then((r) => { if (!cancelled) setScopes(r.scopes || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [paused, selectedFrameId]);

  // Re-evaluate watch expressions on each pause.
  useEffect(() => {
    if (!paused || !selectedFrameId) { setWatchValues({}); return; }
    let cancelled = false;
    Promise.all(watches.map(async (expr) => {
      try {
        const r = await window.opendev.debug.request<{ value: string }>('evaluate', { frameId: selectedFrameId, expression: expr });
        return [expr, r.value] as const;
      } catch (e) {
        return [expr, `error: ${(e as Error).message}`] as const;
      }
    })).then((pairs) => {
      if (cancelled) return;
      const out: Record<string, string> = {};
      for (const [k, v] of pairs) out[k] = v;
      setWatchValues(out);
    });
    return () => { cancelled = true; };
  }, [paused, selectedFrameId, watches]);

  const toggleScope = async (s: Scope) => {
    if (scopeVars[s.varsRef]) {
      setScopeVars((prev) => { const n = { ...prev }; delete n[s.varsRef]; return n; });
      return;
    }
    setScopeVars((prev) => ({ ...prev, [s.varsRef]: 'loading' }));
    try {
      const r = await window.opendev.debug.request<{ variables: DebugVar[] }>('getVariables', { varsRef: s.varsRef });
      setScopeVars((prev) => ({ ...prev, [s.varsRef]: r.variables || [] }));
    } catch {
      setScopeVars((prev) => { const n = { ...prev }; delete n[s.varsRef]; return n; });
    }
  };

  const allBp = Object.entries(breakpoints).flatMap(([path, lines]) =>
    lines.map((line) => ({ path, line }))
  );

  return (
    <div className="debug-panel">
      <div className="debug-head">
        <span className="debug-title">DEBUG</span>
        {session && <span className={`debug-status ${session.status}`}>{session.status}</span>}
        <span style={{ flex: 1 }} />
        {session && session.status !== 'terminated' && (
          <button className="debug-btn stop" onClick={() => window.opendev.debug.stop()}>Stop</button>
        )}
      </div>

      {!session && (
        <div className="debug-empty">
          No debug session running. Open a <code>.js</code>/<code>.mjs</code> file and click
          <strong> Debug</strong> above the editor to start one.
        </div>
      )}

      {session && (
        <>
          <div className="debug-section">
            <div className="debug-section-title">Call Stack</div>
            {!paused && <div className="debug-mini">Running…</div>}
            {paused?.frames.map((f) => (
              <div
                key={f.id}
                className={`debug-frame ${f.id === selectedFrameId ? 'selected' : ''}`}
                onClick={() => {
                  selectFrame(f.id);
                  // Reveal the frame's location in the editor (LSP coords are 0-indexed).
                  if (f.path) setPendingJump({ path: f.path, line: f.line - 1, col: Math.max(0, (f.col || 1) - 1) });
                }}
              >
                <span className="frame-name">{f.name}</span>
                <span className="frame-loc">{f.path ? baseName(f.path) : '<anon>'}:{f.line}</span>
              </div>
            ))}
          </div>

          <div className="debug-section">
            <div className="debug-section-title">Variables</div>
            {!paused && <div className="debug-mini">—</div>}
            {paused && scopes.length === 0 && <div className="debug-mini">loading…</div>}
            {scopes.map((s) => {
              const expanded = scopeVars[s.varsRef];
              return (
                <div key={s.varsRef} className="debug-scope">
                  <div className="scope-head" onClick={() => toggleScope(s)}>
                    <span className="caret">{expanded ? '▾' : '▸'}</span>
                    <span className="scope-name">{s.name}</span>
                  </div>
                  {expanded === 'loading' && <div className="debug-mini">loading…</div>}
                  {Array.isArray(expanded) && (
                    <div className="scope-vars">
                      {expanded.length === 0 && <div className="debug-mini">(empty)</div>}
                      {expanded.map((v, i) => (
                        <div key={i} className="var-row">
                          <span className="var-name">{v.name}</span>
                          <span className="var-eq">:</span>
                          <span className="var-val" title={v.value}>{v.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="debug-section">
            <div className="debug-section-title">Watch</div>
            {watches.map((w, i) => (
              <div key={i} className="watch-row">
                <span className="watch-expr">{w}</span>
                <span className="watch-val" title={watchValues[w] ?? ''}>{watchValues[w] ?? '—'}</span>
                <button className="watch-x" onClick={() => removeWatch(i)} title="Remove">✕</button>
              </div>
            ))}
            <input
              className="watch-input"
              placeholder="+ add watch expression"
              value={watchInput}
              onChange={(e) => setWatchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && watchInput.trim()) {
                  addWatch(watchInput.trim());
                  setWatchInput('');
                }
              }}
            />
          </div>
        </>
      )}

      <div className="debug-section">
        <div className="debug-section-title">Breakpoints ({allBp.length})</div>
        {allBp.length === 0 && <div className="debug-mini">No breakpoints set. Click the gutter in any editor.</div>}
        {allBp.map((b, i) => (
          <div key={`${b.path}:${b.line}:${i}`} className="bp-row">
            <span className="bp-dot" />
            <span className="bp-loc" onClick={() => setPendingJump({ path: b.path, line: b.line - 1, col: 0 })}>
              {baseName(b.path)}:{b.line}
            </span>
            <button className="bp-x" onClick={() => toggleBreakpoint(b.path, b.line)} title="Remove">✕</button>
          </div>
        ))}
      </div>

      <div className="debug-section debug-console-section">
        <div className="debug-section-title">
          Console
          {debugConsole && <button className="debug-mini-btn" onClick={clearConsole}>clear</button>}
        </div>
        <pre className="debug-console">{debugConsole || '(no output yet)'}</pre>
      </div>
    </div>
  );
}
