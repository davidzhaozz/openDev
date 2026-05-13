import { useEffect, useState } from 'react';
import type { TaskItem } from '../../../shared/types';

export function TasksPanel() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [newTitle, setNewTitle] = useState('');

  const refresh = async () => setItems(await window.opendev.tasks.list());
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (!newTitle.trim()) return;
    await window.opendev.tasks.save({ title: newTitle.trim(), done: false });
    setNewTitle(''); refresh();
  };

  return (
    <div className="panel">
      <div className="panel-header"><span>Tasks</span></div>
      <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--border)' }}>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="New task…" style={{ flex: 1 }} />
        <button onClick={add}>Add</button>
      </div>
      <div className="panel-body">
        {items.map(t => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--bg-2)' }}>
            <input type="checkbox" checked={t.done} onChange={async (e) => {
              await window.opendev.tasks.save({ ...t, done: e.target.checked }); refresh();
            }} />
            <span style={{ flex: 1, textDecoration: t.done ? 'line-through' : undefined, color: t.done ? 'var(--fg-3)' : 'var(--fg-0)' }}>{t.title}</span>
            <button onClick={async () => { await window.opendev.tasks.delete(t.id); refresh(); }}>✕</button>
          </div>
        ))}
        {!items.length && <div style={{ padding: 12, color: 'var(--fg-3)' }}>No tasks yet.</div>}
      </div>
    </div>
  );
}
