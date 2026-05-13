import { useEffect, useState } from 'react';
import type { DbConnectionProfile, DbResult, DbSchema } from '../../../shared/types';

export function SqlPanel() {
  const [conns, setConns] = useState<DbConnectionProfile[]>([]);
  const [active, setActive] = useState<string | undefined>();
  const [schema, setSchema] = useState<DbSchema[] | null>(null);
  const [sql, setSql] = useState('SELECT 1;');
  const [result, setResult] = useState<DbResult | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const [editing, setEditing] = useState<(DbConnectionProfile & { password?: string }) | null>(null);

  const refresh = async () => setConns(await window.opendev.db.list());
  useEffect(() => { refresh(); }, []);

  const connect = async (id: string) => {
    setActive(id); setSchema(null); setErr(undefined);
    try {
      await window.opendev.db.connect(id);
      setSchema(await window.opendev.db.schema(id));
    } catch (e: any) { setErr(e.message); }
  };

  const run = async () => {
    if (!active) return;
    setErr(undefined); setResult(null);
    try { setResult(await window.opendev.db.query(active, sql)); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="panel" style={{ flexDirection: 'row' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div className="panel-header">
          <span>Connections</span>
          <span className="grow" />
          <button className="icon" onClick={() => setEditing({ id: '', name: '', driver: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: '' })}>+</button>
        </div>
        <div className="panel-body">
          {conns.map(c => (
            <div key={c.id} className="svc-row" onClick={() => connect(c.id)}>
              <span className={`dot ${active === c.id ? 'running' : ''}`} />
              <span className="name">{c.name}</span>
              <span className="cmd">{c.driver}</span>
              <button onClick={(e) => { e.stopPropagation(); setEditing({ ...c }); }}>✎</button>
            </div>
          ))}
        </div>
        {schema && (
          <div style={{ borderTop: '1px solid var(--border)', overflow: 'auto', maxHeight: 240 }}>
            {schema.map(s => (
              <details key={s.name}>
                <summary style={{ padding: '4px 8px', cursor: 'pointer' }}>{s.name}</summary>
                {s.tables.map(t => (
                  <details key={t.name} style={{ marginLeft: 14 }}>
                    <summary style={{ padding: '2px 4px', cursor: 'pointer' }}>{t.name}</summary>
                    <div style={{ marginLeft: 14, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                      {t.columns.map(c => <div key={c.name}>{c.name} <span style={{ color: 'var(--fg-2)' }}>{c.type}</span></div>)}
                    </div>
                  </details>
                ))}
              </details>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div className="panel-header">
          <span>SQL Editor</span>
          <span className="grow" />
          <button onClick={run} disabled={!active}>Run</button>
        </div>
        <textarea value={sql} onChange={(e) => setSql(e.target.value)}
          style={{ minHeight: 120, fontFamily: 'var(--font-mono)', fontSize: 12, border: 'none', borderBottom: '1px solid var(--border)', borderRadius: 0 }} />
        <div style={{ flex: 1, overflow: 'auto' }}>
          {err && <div style={{ padding: 10, color: 'var(--danger)' }}>{err}</div>}
          {result && (
            <table className="grid">
              <thead><tr>{result.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{result.rows.slice(0, 500).map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j}>{v == null ? <em style={{ color: 'var(--fg-3)' }}>null</em> : String(v)}</td>)}</tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
      {editing && <DbProfileEditor p={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function DbProfileEditor({ p, onClose, onSaved }: { p: DbConnectionProfile & { password?: string }; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(p);
  const save = async () => { await window.opendev.db.save(draft); onSaved(); };
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" style={{ padding: 16 }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center' }}>
          <label>Name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <label>Driver</label>
          <select value={draft.driver} onChange={(e) => setDraft({ ...draft, driver: e.target.value as any, port: e.target.value === 'mysql' ? 3306 : 5432 })}>
            <option value="mysql">MySQL</option><option value="postgres">Postgres</option>
          </select>
          <label>Host</label><input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
          <label>Port</label><input type="number" value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} />
          <label>User</label><input value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
          <label>Password</label><input type="password" value={draft.password || ''} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="(stored in keychain)" />
          <label>Database</label><input value={draft.database || ''} onChange={(e) => setDraft({ ...draft, database: e.target.value })} />
          <label>Read only</label><input type="checkbox" checked={!!draft.readOnly} onChange={(e) => setDraft({ ...draft, readOnly: e.target.checked })} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
