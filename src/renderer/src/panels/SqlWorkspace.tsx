import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../state/store';
import { Resizer } from '../components/Resizer';

function formatCell(v: unknown): ReactNode {
  if (v === null || v === undefined) return <em className="null">null</em>;
  if (typeof v === 'boolean') return <span className="cell-bool">{String(v)}</span>;
  if (typeof v === 'number' || typeof v === 'bigint') return <span className="cell-num">{String(v)}</span>;
  if (v instanceof Date) return <span className="cell-date">{v.toISOString()}</span>;
  if (v instanceof Uint8Array) {
    const hex = Array.from(v.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('');
    return <span className="cell-bytes" title={`${v.byteLength} bytes`}>0x{hex}{v.byteLength > 32 ? '…' : ''}</span>;
  }
  if (typeof v === 'object') {
    let s: string;
    try { s = JSON.stringify(v); }
    catch { return <em className="null">[unprintable]</em>; }
    const short = s.length > 200 ? s.slice(0, 200) + '…' : s;
    return <span className="cell-json" title={s}>{short}</span>;
  }
  const str = String(v);
  return str.length > 300 ? <span title={str}>{str.slice(0, 300)}…</span> : str;
}

// Convert a raw cell value into the textual form we put into the inline
// input. Objects become JSON, dates become ISO strings; null becomes empty.
function cellToInput(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return ''; }
  }
  return String(v);
}

// Inverse: the user types text; coerce back to the right runtime type.
// We use the original cell value to figure out the target type so we
// never change a number column into a string by accident.
function inputToValue(text: string, original: unknown): unknown {
  if (text === '' && original == null) return null;
  if (text === '' && typeof original === 'string') return '';
  if (text === '' && (typeof original === 'number' || typeof original === 'bigint')) return null;
  if (typeof original === 'boolean') {
    const t = text.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 't' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'f' || t === 'no') return false;
    return text;
  }
  if (typeof original === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (typeof original === 'bigint') {
    try { return BigInt(text); } catch { return text; }
  }
  if (original && typeof original === 'object' && !(original instanceof Date) && !(original instanceof Uint8Array)) {
    // Treat JSON/JSONB columns: parse if it looks like JSON, else keep
    // as a string and let the driver coerce.
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

export function SqlWorkspace() {
  const sqlText = useStore(s => s.sqlText);
  const setSqlText = useStore(s => s.setSqlText);
  const sqlConnId = useStore(s => s.sqlConnId);
  const sqlResult = useStore(s => s.sqlResult);
  const setSqlResult = useStore(s => s.setSqlResult);
  const sqlSource = useStore(s => s.sqlSource);
  const layout = useStore(s => s.layout);
  const setLayout = useStore(s => s.setLayout);
  const sqlRunRequest = useStore(s => s.sqlRunRequest);
  const showToast = useStore(s => s.showToast);
  const [running, setRunning] = useState(false);
  const lastRunRequest = useRef(0);

  // Dirty state: rowIndex → (colIndex → new typed value).
  // Lives only as long as the user hasn't pressed Save / discarded.
  const [dirty, setDirty] = useState<Record<number, Record<number, unknown>>>({});
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);

  const run = async () => {
    if (!sqlConnId) { setSqlResult({ error: 'No connection selected — pick one in the right panel.' }); return; }
    if (!sqlText.trim()) return;
    setRunning(true);
    try {
      const r = await window.opendev.db.query(sqlConnId, sqlText);
      setSqlResult(r);
      // Fresh data — drop any pending edits since row indices may shift.
      setDirty({});
      setSaveErrors([]);
    } catch (e: any) {
      setSqlResult({ error: e?.message || String(e) });
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (sqlRunRequest > lastRunRequest.current && !running) {
      lastRunRequest.current = sqlRunRequest;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sqlRunRequest]);

  const hasError = sqlResult && 'error' in sqlResult;
  const result = sqlResult && !('error' in sqlResult) ? sqlResult : null;

  // ───── Editable-grid bookkeeping ─────

  const pkColumns = useMemo(() => {
    if (!sqlSource) return [];
    return sqlSource.columns.filter(c => c.key === 'PRI').map(c => c.name);
  }, [sqlSource]);

  // The result is editable only when (1) we know the source table, (2) it
  // has a primary key, and (3) every PK column shows up in the result.
  const editableInfo = useMemo(() => {
    if (!result) return { editable: false, reason: 'No result yet.' };
    if (!sqlSource) return { editable: false, reason: 'Open a table from the DB tree to edit rows.' };
    if (pkColumns.length === 0) return { editable: false, reason: `${sqlSource.table} has no primary key — can't safely update rows.` };
    const present = pkColumns.every(c => result.columns.includes(c));
    if (!present) return { editable: false, reason: `SELECT must include the primary key (${pkColumns.join(', ')}).` };
    return { editable: true as const, reason: '' };
  }, [result, sqlSource, pkColumns]);

  const colIndex = useMemo(() => {
    if (!result) return new Map<string, number>();
    const m = new Map<string, number>();
    result.columns.forEach((c, i) => m.set(c, i));
    return m;
  }, [result]);

  const dirtyRowKeys = useMemo(() => Object.keys(dirty).map(n => Number(n)), [dirty]);
  const dirtyCount = useMemo(() => dirtyRowKeys.reduce((acc, r) => acc + Object.keys(dirty[r]).length, 0), [dirty, dirtyRowKeys]);

  const startEdit = (rowIdx: number, colIdx: number) => {
    if (!editableInfo.editable || !result) return;
    // PK columns are not editable — changing them would orphan the WHERE.
    const colName = result.columns[colIdx];
    if (pkColumns.includes(colName)) {
      showToast(`${colName} is a primary key column — not editable.`, 3000);
      return;
    }
    const current = dirty[rowIdx]?.[colIdx] !== undefined ? dirty[rowIdx][colIdx] : result.rows[rowIdx][colIdx];
    setEditing({ row: rowIdx, col: colIdx });
    setEditText(cellToInput(current));
  };

  const commitEdit = () => {
    if (!editing || !result) return;
    const { row, col } = editing;
    const original = result.rows[row][col];
    const next = inputToValue(editText, original);
    // No-op? clear dirty for this cell.
    const isSame = (() => {
      if (typeof original === 'object' && original != null) {
        try { return JSON.stringify(original) === JSON.stringify(next); } catch { return false; }
      }
      return original === next;
    })();
    setDirty(prev => {
      const rowMap = { ...(prev[row] || {}) };
      if (isSame) delete rowMap[col];
      else rowMap[col] = next;
      const out = { ...prev };
      if (Object.keys(rowMap).length === 0) delete out[row];
      else out[row] = rowMap;
      return out;
    });
    setEditing(null);
    setEditText('');
  };

  const cancelEdit = () => { setEditing(null); setEditText(''); };

  const discardAll = () => {
    if (dirtyCount === 0) return;
    if (!confirm(`Discard ${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}?`)) return;
    setDirty({});
    setSaveErrors([]);
  };

  const revertRow = (rowIdx: number) => {
    setDirty(prev => {
      const out = { ...prev };
      delete out[rowIdx];
      return out;
    });
  };

  const save = async () => {
    if (!sqlConnId || !sqlSource || !result || dirtyCount === 0) return;
    setSaving(true);
    setSaveErrors([]);
    try {
      const updates = dirtyRowKeys.map(rowIdx => {
        const set: Record<string, unknown> = {};
        for (const [colStr, val] of Object.entries(dirty[rowIdx])) {
          const colName = result.columns[Number(colStr)];
          set[colName] = val;
        }
        const where: Record<string, unknown> = {};
        for (const pk of pkColumns) {
          const i = colIndex.get(pk)!;
          where[pk] = result.rows[rowIdx][i];
        }
        return { where, set };
      });
      const res = await window.opendev.db.updateRows({
        connId: sqlConnId,
        schema: sqlSource.schema,
        table: sqlSource.table,
        updates
      });
      if (res.errors.length > 0) {
        const msgs = res.errors.map(e => {
          const rowIdx = dirtyRowKeys[e.index];
          return `Row ${rowIdx + 1}: ${e.message}`;
        });
        setSaveErrors(msgs);
        if (res.applied === 0) {
          showToast(`No rows saved — ${res.errors.length} error${res.errors.length === 1 ? '' : 's'} below.`, 5000);
        } else {
          showToast(`Saved ${res.applied}, ${res.errors.length} failed — see errors below.`, 5000);
        }
      } else {
        showToast(`Saved ${res.applied} row${res.applied === 1 ? '' : 's'}.`, 2500);
      }
      // Drop dirty entries that succeeded; keep the ones that failed.
      const failed = new Set(res.errors.map(e => dirtyRowKeys[e.index]));
      setDirty(prev => {
        const out: typeof prev = {};
        for (const k of Object.keys(prev)) {
          const n = Number(k);
          if (failed.has(n)) out[n] = prev[n];
        }
        return out;
      });
      // Re-fetch so we see the canonical row (DB-side triggers, etc).
      if (res.errors.length === 0) await run();
    } catch (e: any) {
      setSaveErrors([e?.message || String(e)]);
      showToast(`Save failed: ${e?.message || e}`, 5000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sql-workspace">
      <div className="sql-toolbar">
        <button className="primary" disabled={running || !sqlConnId} onClick={run}>{running ? 'Running…' : 'Run ⌘↵'}</button>
        <span className="grow" />
        <span className="sql-status">
          {sqlConnId ? `connected · ${sqlConnId.slice(0, 8)}` : 'no connection'}
          {sqlSource && (
            <span className="sql-source">
              {' · '}
              {sqlSource.schema ? `${sqlSource.schema}.` : ''}{sqlSource.table}
              {pkColumns.length > 0 && <span className="sql-pk"> · PK: {pkColumns.join(', ')}</span>}
            </span>
          )}
        </span>
      </div>

      {dirtyCount > 0 && (
        <div className="sql-savebar">
          <span className="sql-savebar-text">
            <strong>{dirtyCount}</strong> unsaved change{dirtyCount === 1 ? '' : 's'}
            {dirtyRowKeys.length > 1 && ` across ${dirtyRowKeys.length} rows`}
          </span>
          <span className="grow" />
          <button className="sql-savebar-discard" onClick={discardAll} disabled={saving}>Discard</button>
          <button className="sql-savebar-save" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      {saveErrors.length > 0 && (
        <div className="sql-saveerrors">
          {saveErrors.map((m, i) => <div key={i}>⚠ {m}</div>)}
        </div>
      )}

      <div className="sql-results">
        <div className="sql-results-header">
          {hasError && <span className="sql-results-error">{(sqlResult as { error: string }).error}</span>}
          {result && <span>{result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.durationMs} ms</span>}
          {result?.truncated && <span className="sql-truncated">⚠ showing first {result.rows.length} rows · add LIMIT to see specific data</span>}
          {result && !editableInfo.editable && <span className="sql-readonly">read-only · {editableInfo.reason}</span>}
          {result && editableInfo.editable && <span className="sql-editable">double-click a cell to edit</span>}
          {!sqlResult && <span className="sql-empty">Run a query to see results here.</span>}
        </div>
        <div className="sql-results-body">
          {result && (
            <table className="grid">
              <thead>
                <tr>
                  {editableInfo.editable && <th className="grid-rowctrl" />}
                  {result.columns.map(c => (
                    <th key={c}>
                      {c}
                      {pkColumns.includes(c) && <span className="grid-pk-badge" title="Primary key">🔑</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 500).map((row, i) => {
                  const rowDirty = dirty[i];
                  const isRowDirty = !!rowDirty && Object.keys(rowDirty).length > 0;
                  return (
                    <tr key={i} className={isRowDirty ? 'row-dirty' : undefined}>
                      {editableInfo.editable && (
                        <td className="grid-rowctrl">
                          {isRowDirty ? (
                            <button
                              className="grid-revert"
                              onClick={() => revertRow(i)}
                              title={`Revert ${Object.keys(rowDirty).length} change(s)`}
                            >↺</button>
                          ) : <span className="grid-rownum">{i + 1}</span>}
                        </td>
                      )}
                      {row.map((v, j) => {
                        const isEditing = editing?.row === i && editing.col === j;
                        const isDirty = rowDirty?.[j] !== undefined;
                        const colName = result.columns[j];
                        const isPk = pkColumns.includes(colName);
                        const displayValue = isDirty ? rowDirty[j] : v;
                        return (
                          <td
                            key={j}
                            className={[
                              'grid-cell',
                              isPk ? 'cell-pk' : '',
                              isDirty ? 'cell-dirty' : '',
                              !isPk && editableInfo.editable ? 'cell-editable' : ''
                            ].filter(Boolean).join(' ')}
                            onDoubleClick={() => startEdit(i, j)}
                            title={isDirty ? `original: ${cellToInput(v)}` : undefined}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                className="cell-input"
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                                  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                }}
                              />
                            ) : (
                              formatCell(displayValue)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Resizer orientation="horizontal" value={layout.sqlSplit} min={120} max={800}
        onChange={(v) => setLayout({ sqlSplit: v })} invert />

      <textarea
        className="sql-editor"
        value={sqlText}
        spellCheck={false}
        onChange={(e) => setSqlText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
        }}
        placeholder="-- write a SQL query, then ⌘↵ to run"
        style={{ height: layout.sqlSplit, flex: `0 0 ${layout.sqlSplit}px` }}
      />
    </div>
  );
}
