import { useEffect, useRef, useState } from 'react';
import type { PythonInterpreter } from '../../../shared/types';
import { useStore } from '../state/store';

// PyCharm-style interpreter chip shown in the Project panel header when the
// workspace is Python-aware. Click → popover with detected interpreters
// (venv / pyenv / conda / homebrew / system) + a "Create .venv…" affordance.

export function PythonPicker() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PythonInterpreter[]>([]);
  const [selected, setSelected] = useState<PythonInterpreter | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createLog, setCreateLog] = useState('');
  const [createBase, setCreateBase] = useState<string | undefined>();
  const showToast = useStore((s) => s.showToast);
  const openPipTab = useStore((s) => s.openPipTab);
  const popRef = useRef<HTMLDivElement>(null);

  const refresh = async (force = false) => {
    setRefreshing(true);
    try {
      const [l, cur] = await Promise.all([
        window.opendev.python.list(force),
        window.opendev.python.get()
      ]);
      setList(l);
      setSelected(cur);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh(false);
    const off = window.opendev.python.onChanged((cur) => setSelected(cur));
    return off;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!creating) return;
    const off = window.opendev.python.onVenvLog((line) => setCreateLog((s) => (s + line).slice(-4000)));
    return off;
  }, [creating]);

  // Hide the chip entirely when no interpreters were found AND we're not
  // showing a venv-creation dialog — keeps the title bar uncluttered for
  // non-Python projects.
  if (!selected && list.length === 0 && !refreshing) return null;

  const chipLabel = selected
    ? `Py ${selected.version || '?'}${selected.label ? ` · ${selected.label}` : ''}`
    : 'Python: pick…';

  const pick = async (p: PythonInterpreter) => {
    try { await window.opendev.python.set(p.path); showToast(`Interpreter: ${p.version || p.path}`, 2500); }
    catch (e: any) { showToast(`Failed to set interpreter: ${e?.message || e}`, 5000); }
    setOpen(false);
  };

  const createVenv = async () => {
    if (!createBase) { showToast('Pick a base Python first', 3000); return; }
    setCreateLog('');
    try {
      await window.opendev.python.createVenv({ basePython: createBase, dirName: '.venv' });
      showToast('Created .venv', 2500);
      setCreating(false);
      refresh(true);
    } catch (e: any) {
      showToast(`venv creation failed: ${e?.message || e}`, 6000);
    }
  };

  return (
    <div className="py-picker" ref={popRef}>
      <button
        className="py-chip"
        title={selected ? selected.path : 'Pick a Python interpreter'}
        onClick={() => setOpen((o) => !o)}
      >
        {chipLabel}
      </button>
      {open && (
        <div className="py-popover">
          <div className="py-popover-head">
            <span>Python interpreter</span>
            <span className="grow" />
            <button className="icon" title="Refresh list" onClick={() => refresh(true)} disabled={refreshing}>↻</button>
          </div>
          <div className="py-popover-body">
            {list.length === 0 && !refreshing && (
              <div className="py-empty">
                No interpreters detected. Install Python 3 (e.g. <code>brew install python</code>) and click ↻.
              </div>
            )}
            {list.map((i) => (
              <div
                key={i.path}
                className={`py-row ${selected?.path === i.path ? 'selected' : ''}`}
                onClick={() => pick(i)}
                title={i.path}
              >
                <span className={`py-kind py-kind-${i.kind}`}>{i.kind}</span>
                <span className="py-version">{i.version || '?'}</span>
                <span className="py-path">{i.label || i.path.replace(/^.*\//, '')}</span>
              </div>
            ))}
          </div>
          <div className="py-popover-foot">
            <button
              onClick={() => { setOpen(false); openPipTab(); }}
              disabled={!selected}
              title={selected ? 'Open the package manager for this interpreter' : 'Select an interpreter first'}
            >
              Packages…
            </button>
            <span className="grow" />
            <button onClick={() => { setCreating(true); setOpen(false); setCreateBase(list[0]?.path); }}>
              Create .venv…
            </button>
          </div>
        </div>
      )}

      {creating && (
        <div className="modal-overlay" onMouseDown={() => setCreating(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 540, padding: 16 }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 13 }}>Create virtual environment</h3>
            <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 10 }}>
              Runs <code>&lt;base-python&gt; -m venv .venv</code> at the workspace root.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center' }}>
              <label>Base Python</label>
              <select value={createBase || ''} onChange={(e) => setCreateBase(e.target.value)}>
                {list.filter((i) => i.kind !== 'venv').map((i) => (
                  <option key={i.path} value={i.path}>
                    {i.label || i.kind} · {i.version || i.path}
                  </option>
                ))}
              </select>
            </div>
            {createLog && (
              <pre style={{
                marginTop: 10, padding: 8, background: 'var(--bg-0)', border: '1px solid var(--bg-2)',
                borderRadius: 4, maxHeight: 200, overflow: 'auto', fontSize: 11
              }}>{createLog}</pre>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setCreating(false)}>Cancel</button>
              <button className="primary" onClick={createVenv}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
