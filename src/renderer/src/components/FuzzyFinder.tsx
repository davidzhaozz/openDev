import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { baseName } from '@shared/paths';

export function FuzzyFinder() {
  const setModal = useStore(s => s.setModal);
  const openFile = useStore(s => s.openFileTab);
  const root = useStore(s => s.workspaceRoot);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Array<{ path: string; relative?: string }>>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const r = await window.opendev.search.fuzzy(q, 80);
      if (!alive) return;
      setItems(r);
      setActive(0);
    }, 60);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const open = async (p: string) => {
    const content = await window.opendev.fs.read(p);
    openFile(p, content);
    setModal(null);
  };

  return (
    <div className="modal-overlay" onMouseDown={() => setModal(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-input">
          <input
            autoFocus
            placeholder="Find file by name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setModal(null);
              else if (e.key === 'ArrowDown') { setActive(a => Math.min(a + 1, items.length - 1)); e.preventDefault(); }
              else if (e.key === 'ArrowUp') { setActive(a => Math.max(a - 1, 0)); e.preventDefault(); }
              else if (e.key === 'Enter') { if (items[active]) open(items[active].path); }
            }}
          />
        </div>
        <div className="modal-list">
          {items.map((it, i) => (
            <div
              key={it.path}
              className={`modal-row ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => open(it.path)}
            >
              <span>{baseName((it.relative || it.path))}</span>
              <span className="relpath">{(it.relative || it.path).slice(0, -(baseName((it.relative || it.path))?.length || 0))}</span>
            </div>
          ))}
          {!items.length && q && <div className="modal-row" style={{ color: 'var(--fg-3)' }}>No matches</div>}
          {!q && root && <div className="modal-row" style={{ color: 'var(--fg-3)' }}>Type to filter files in {root}</div>}
        </div>
      </div>
    </div>
  );
}
