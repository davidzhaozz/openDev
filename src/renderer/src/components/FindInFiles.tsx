import { useEffect, useState } from 'react';
import type { GrepHit } from '../../../shared/types';
import { useStore } from '../state/store';

export function FindInFiles() {
  const setModal = useStore(s => s.setModal);
  const openFile = useStore(s => s.openFileTab);
  const [q, setQ] = useState('');
  const [glob, setGlob] = useState('');
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const off1 = window.opendev.search.onHit((h) => setHits(prev => [...prev, h]));
    const off2 = window.opendev.search.onDone(() => setRunning(false));
    return () => { off1(); off2(); };
  }, []);

  const run = async () => {
    if (!q) return;
    setHits([]); setRunning(true);
    await window.opendev.search.grep(q, glob ? { glob } : {});
  };

  const open = async (h: GrepHit) => {
    const content = await window.opendev.fs.read(h.path);
    openFile(h.path, content);
    setModal(null);
  };

  return (
    <div className="modal-overlay" onMouseDown={() => setModal(null)}>
      <div className="modal" style={{ width: 720 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-input" style={{ display: 'flex', gap: 8 }}>
          <input autoFocus placeholder="ripgrep query…" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); if (e.key === 'Escape') setModal(null); }}
            style={{ flex: 1 }} />
          <input placeholder="glob (optional)" value={glob} onChange={(e) => setGlob(e.target.value)}
            style={{ width: 180 }} />
          <button onClick={run} disabled={running}>{running ? 'Searching…' : 'Search'}</button>
        </div>
        <div className="modal-list">
          {hits.map((h, i) => (
            <div key={i} className="modal-row" onClick={() => open(h)}>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-2)' }}>
                  {h.path}:{h.line}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{h.preview}</div>
              </div>
            </div>
          ))}
          {!hits.length && !running && q && <div className="modal-row" style={{ color: 'var(--fg-3)' }}>No matches</div>}
        </div>
      </div>
    </div>
  );
}
