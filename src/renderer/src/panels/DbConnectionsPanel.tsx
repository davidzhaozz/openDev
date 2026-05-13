import { useEffect, useMemo, useRef, useState } from 'react';
import type { DbConnectionProfile, DbSchema, DbTable } from '../../../shared/types';
import { useStore } from '../state/store';

const POSTGRES_RESERVED = /^[a-z_][a-z0-9_]*$/;
function quote(driver: 'mysql' | 'postgres', ident: string): string {
  if (driver === 'mysql') return '`' + ident.replace(/`/g, '``') + '`';
  return POSTGRES_RESERVED.test(ident) ? ident : '"' + ident.replace(/"/g, '""') + '"';
}

type Props = {
  /** Limit what drivers this panel shows / allows. Default = all SQL (mysql + postgres). */
  drivers?: Array<'mysql' | 'postgres' | 'elasticsearch'>;
  /** Header label for the panel (defaults to "Connections"). */
  title?: string;
};

const DEFAULT_DRIVERS: Array<'mysql' | 'postgres' | 'elasticsearch'> = ['mysql', 'postgres'];

export function DbConnectionsPanel({ drivers = DEFAULT_DRIVERS, title = 'Connections' }: Props = {}) {
  const [conns, setConns] = useState<DbConnectionProfile[]>([]);
  const [schema, setSchema] = useState<DbSchema[] | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const [editing, setEditing] = useState<(DbConnectionProfile & { password?: string }) | null>(null);
  const [filter, setFilter] = useState('');
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [databases, setDatabases] = useState<string[]>([]);
  const [currentDb, setCurrentDb] = useState<string | undefined>();
  const [expandedDb, setExpandedDb] = useState<string | undefined>();
  const [switchingTo, setSwitchingTo] = useState<string | undefined>();

  const sqlConnId = useStore(s => s.sqlConnId);
  const setSqlConnId = useStore(s => s.setSqlConnId);
  // Only treat sqlConnId as "this panel's selection" if the connection
  // actually belongs to this panel's drivers. Otherwise, switching from
  // the SQL right-tab to the ES right-tab would leak the SQL panel's
  // browser state (schemas/tables) into the ES tab.
  const effectiveConnId = useMemo(() => {
    if (!sqlConnId) return undefined;
    if (conns.some(c => c.id === sqlConnId)) return sqlConnId;
    return undefined;
  }, [sqlConnId, conns]);
  const setSqlText = useStore(s => s.setSqlText);
  const setSqlSource = useStore(s => s.setSqlSource);
  const openSqlTab = useStore(s => s.openSqlTab);
  const triggerSqlRun = useStore(s => s.triggerSqlRun);
  const setEsText = useStore(s => s.setEsText);
  const openEsTab = useStore(s => s.openEsTab);
  const triggerEsRun = useStore(s => s.triggerEsRun);
  const [tableCtx, setTableCtx] = useState<{ x: number; y: number; schema: string; table: DbTable } | null>(null);

  useEffect(() => {
    const dismiss = () => setTableCtx(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, []);

  const activeConn = useMemo(() => conns.find(c => c.id === effectiveConnId), [conns, effectiveConnId]);

  const refresh = async () => {
    const all = await window.opendev.db.list();
    setConns(all.filter(c => drivers.includes(c.driver as any)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [drivers.join('|')]);

  // (Re)load when this panel's effective connection changes. When the
  // active right-tab's connection doesn't belong here, effectiveConnId is
  // undefined → we wipe local state so no stale browser content shows.
  useEffect(() => {
    let alive = true;
    if (!effectiveConnId) {
      setSchema(null); setDatabases([]); setCurrentDb(undefined); setExpandedDb(undefined);
      setExpandedSchemas(new Set()); setExpandedTables(new Set()); setErr(undefined);
      return;
    }
    setSchema(null); setErr(undefined); setDatabases([]);
    (async () => {
      try {
        await window.opendev.db.connect(effectiveConnId);
        const { databases, current } = await window.opendev.db.listDatabases(effectiveConnId);
        if (!alive) return;
        setDatabases(databases);
        setCurrentDb(current);
        setExpandedDb(current);
        await loadSchemaForCurrent();
      } catch (e: any) {
        if (alive) setErr(e?.message || String(e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveConnId]);

  const loadSchemaForCurrent = async () => {
    if (!effectiveConnId) return;
    setSchema(null);
    try {
      const s = await window.opendev.db.schema(effectiveConnId);
      setSchema(s);
      setErr(undefined);
      const firstWithTables = s.find(x => x.tables.length > 0);
      if (firstWithTables) setExpandedSchemas(new Set([firstWithTables.name]));
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };

  const switchTo = async (dbName: string) => {
    if (!effectiveConnId || dbName === currentDb) {
      setExpandedDb(prev => prev === dbName ? undefined : dbName);
      return;
    }
    setSwitchingTo(dbName);
    setExpandedSchemas(new Set()); setExpandedTables(new Set());
    try {
      await window.opendev.db.switchDatabase(effectiveConnId, dbName);
      setCurrentDb(dbName);
      setExpandedDb(dbName);
      await loadSchemaForCurrent();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSwitchingTo(undefined);
    }
  };

  const toggleSchema = (name: string) => {
    setExpandedSchemas(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };
  const toggleTable = (key: string) => {
    setExpandedTables(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const tableRef = (schemaName: string, table: DbTable) => {
    if (!activeConn) return null;
    const drv = activeConn.driver;
    if (drv === 'elasticsearch') {
      // For ES the table name is just the index, and there's no schema prefix.
      return table.name;
    }
    const sqlDrv = drv as 'mysql' | 'postgres';
    return `${quote(sqlDrv, schemaName)}.${quote(sqlDrv, table.name)}`;
  };

  const previewTable = (schemaName: string, table: DbTable, opts: { limit?: number | null; run?: boolean } = {}) => {
    const ref = tableRef(schemaName, table);
    if (!ref) return;
    const limit = opts.limit === undefined ? 100 : opts.limit;
    if (activeConn?.driver === 'elasticsearch') {
      // Route ES previews through the JSON-DSL workspace, not the SQL one.
      const size = limit == null ? 1000 : limit;
      const dsl = `POST /${ref}/_search\n{\n  "query": { "match_all": {} },\n  "size": ${size}\n}`;
      setEsText(dsl);
      openEsTab();
      if (opts.run) triggerEsRun();
      return;
    }
    const sql = limit == null
      ? `SELECT *\nFROM ${ref};`
      : `SELECT *\nFROM ${ref}\nLIMIT ${limit};`;
    // keepSource so the SqlSource we set below isn't immediately cleared
    // by setSqlText's default "hand-edit detected" behavior.
    setSqlText(sql, { keepSource: true });
    if (activeConn && (activeConn.driver === 'mysql' || activeConn.driver === 'postgres')) {
      setSqlSource({
        driver: activeConn.driver,
        schema: schemaName,
        table: table.name,
        columns: table.columns
      });
    } else {
      setSqlSource(undefined);
    }
    openSqlTab();
    if (opts.run) triggerSqlRun();
  };

  const countTable = (schemaName: string, table: DbTable) => {
    const ref = tableRef(schemaName, table);
    if (!ref) return;
    const sql = `SELECT COUNT(*) AS n FROM ${ref};`;
    // COUNT returns one synthetic row — not editable, so clear the source.
    setSqlText(sql);
    setSqlSource(undefined);
    openSqlTab();
    triggerSqlRun();
  };

  const tableMatches = (t: DbTable) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()) ||
    t.columns.some(c => c.name.toLowerCase().includes(filter.toLowerCase()));
  const visibleSchemas = useMemo(() => {
    if (!schema) return null;
    if (!filter) return schema;
    return schema
      .map(s => ({ ...s, tables: s.tables.filter(tableMatches) }))
      .filter(s => s.tables.length > 0);
  }, [schema, filter]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>{title}</span>
        <span className="grow" />
        <button className="icon" onClick={() => {
          const initialDriver = drivers[0];
          const defaultPort = initialDriver === 'mysql' ? 3306 : initialDriver === 'postgres' ? 5432 : 9200;
          const defaultUser = initialDriver === 'mysql' ? 'root' : initialDriver === 'postgres' ? 'postgres' : '';
          setEditing({
            id: '', name: '', driver: initialDriver,
            host: '127.0.0.1', port: defaultPort,
            user: defaultUser, database: ''
          });
        }}>+</button>
        <button className="icon" onClick={refresh}>↻</button>
      </div>
      <div className="db-connlist">
        {conns.map(c => (
          <div key={c.id}
            className={`db-conn ${effectiveConnId === c.id ? 'active' : ''}`}
            onClick={() => setSqlConnId(c.id)}>
            <span className="dot" />
            <div className="db-conn-text">
              <div className="db-conn-name">{c.name}</div>
              <div className="db-conn-sub">{c.driver === 'mysql' ? 'MySQL' : c.driver === 'postgres' ? 'Postgres' : 'ES'} · {c.host}:{c.port}{c.database ? ` / ${c.database}` : ''}</div>
            </div>
            <button className="icon" title="Edit" onClick={(e) => { e.stopPropagation(); setEditing({ ...c }); }}>✎</button>
          </div>
        ))}
        {!conns.length && <div className="db-empty">No connections yet — click + to add one.</div>}
      </div>

      <div className="db-schema-header">
        <span>Database Browser</span>
        <span className="grow" />
        {effectiveConnId && (
          <button className="icon" title="Reload" onClick={async () => {
            if (!effectiveConnId) return;
            setDatabases([]); setSchema(null); setErr(undefined);
            try {
              const { databases, current } = await window.opendev.db.listDatabases(effectiveConnId);
              setDatabases(databases);
              setCurrentDb(current);
              setExpandedDb(current);
              await loadSchemaForCurrent();
            } catch (e: any) { setErr(e?.message || String(e)); }
          }}>↻</button>
        )}
      </div>
      {effectiveConnId && databases.length > 0 && (
        <div className="db-schema-filter">
          <input
            value={filter}
            placeholder="Filter tables / columns…"
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      <div className="db-schema">
        {!effectiveConnId && <div className="db-empty">Select a connection above.</div>}
        {effectiveConnId && !databases.length && !err && <div className="db-empty">Connecting…</div>}
        {err && (
          <div className="db-schema-error">
            <div className="db-schema-error-title">Couldn't load schema</div>
            <pre className="db-schema-error-msg">{err}</pre>
          </div>
        )}
        {databases.length > 0 && (
          <div className="db-tree">
            {databases.map(dbName => {
              const isCurrent = dbName === currentDb;
              const isExpanded = expandedDb === dbName;
              const isSwitching = switchingTo === dbName;
              return (
                <div key={dbName}>
                  <div
                    className={`db-tree-row database ${isCurrent ? 'current' : ''}`}
                    onClick={() => switchTo(dbName)}
                    title={isCurrent ? `Connected to ${dbName}` : `Switch to ${dbName}`}
                  >
                    <span className="db-tree-icon">{isExpanded && isCurrent ? '▾' : '▸'}</span>
                    <span className="db-tree-dbicon">⛁</span>
                    <span className="db-tree-name">{dbName}</span>
                    {isSwitching && <span className="db-tree-spin">…</span>}
                    {isCurrent && !isSwitching && <span className="db-tree-badge">connected</span>}
                  </div>
                  {isExpanded && isCurrent && schema && visibleSchemas?.map(s => {
                    const open = expandedSchemas.has(s.name);
                    return (
                      <div key={s.name}>
                        <div className="db-tree-row schema" onClick={() => toggleSchema(s.name)}>
                          <span className="db-tree-icon">{open ? '▾' : '▸'}</span>
                          <span className="db-tree-name">{s.name}</span>
                          <span className="db-tree-count">{s.tables.length}</span>
                        </div>
                        {open && s.tables.length === 0 && <div className="db-tree-empty">No tables</div>}
                        {open && s.tables.map(t => {
                          const key = `${s.name}.${t.name}`;
                          const tOpen = expandedTables.has(key);
                          return (
                            <div key={key}>
                              <div
                                className="db-tree-row table"
                                onDoubleClick={() => previewTable(s.name, t, { run: true })}
                                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTableCtx({ x: e.clientX, y: e.clientY, schema: s.name, table: t }); }}
                              >
                                <span className="db-tree-icon" onClick={(e) => { e.stopPropagation(); toggleTable(key); }}>{tOpen ? '▾' : '▸'}</span>
                                <span className="db-tree-tabicon" title={t.type === 'view' ? 'View' : 'Table'}>{t.type === 'view' ? '◇' : '▦'}</span>
                                <span className="db-tree-name" onClick={() => previewTable(s.name, t, { run: true })} title={`Click: run SELECT * LIMIT 100 · Right-click: more options`}>{t.name}</span>
                                <span className="db-tree-count">{t.columns.length}</span>
                                <button
                                  className="db-tree-action"
                                  title="Run SELECT * LIMIT 100"
                                  onClick={(e) => { e.stopPropagation(); previewTable(s.name, t, { run: true }); }}
                                >▶</button>
                              </div>
                              {tOpen && (
                                <div className="db-tree-cols">
                                  {t.columns.map(c => (
                                    <div key={c.name} className="db-tree-col" title={`${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`}>
                                      <span className="db-tree-col-key">{c.key === 'PRI' ? '🔑' : c.key === 'UNI' ? '∗' : ''}</span>
                                      <span className="db-tree-col-name">{c.name}</span>
                                      <span className="db-tree-col-type">{c.type}{c.nullable ? '' : '!'}</span>
                                    </div>
                                  ))}
                                  {t.columns.length === 0 && <div className="db-tree-empty">No columns</div>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  {isExpanded && isCurrent && !schema && !err && (
                    <div className="db-tree-empty">Loading schemas…</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && <DbProfileEditor p={editing} allowedDrivers={drivers} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); refresh(); }} />}
      {tableCtx && (
        <div className="ctx-menu" style={{ left: tableCtx.x, top: tableCtx.y }} onClick={(e) => e.stopPropagation()}>
          <div className="item" onClick={() => { previewTable(tableCtx.schema, tableCtx.table, { run: true }); setTableCtx(null); }}>
            Select &amp; run (100 rows)
          </div>
          <div className="item" onClick={() => { previewTable(tableCtx.schema, tableCtx.table, { limit: 1000, run: true }); setTableCtx(null); }}>
            Select &amp; run (1000 rows)
          </div>
          <div className="item" onClick={() => { previewTable(tableCtx.schema, tableCtx.table, { limit: null, run: true }); setTableCtx(null); }}>
            Select &amp; run (all rows — no LIMIT)
          </div>
          <div className="sep" />
          <div className="item" onClick={() => { previewTable(tableCtx.schema, tableCtx.table); setTableCtx(null); }}>
            Load SELECT into editor (don't run)
          </div>
          <div className="item" onClick={() => { countTable(tableCtx.schema, tableCtx.table); setTableCtx(null); }}>
            Count rows
          </div>
          <div className="sep" />
          <div className="item" onClick={() => {
            navigator.clipboard.writeText(tableRef(tableCtx.schema, tableCtx.table) || tableCtx.table.name);
            setTableCtx(null);
          }}>Copy fully-qualified name</div>
        </div>
      )}
    </div>
  );
}

function DbProfileEditor({ p, onClose, onSaved, allowedDrivers }: { p: DbConnectionProfile & { password?: string }; onClose: () => void; onSaved: () => void; allowedDrivers: Array<'mysql' | 'postgres' | 'elasticsearch'> }) {
  const [draft, setDraft] = useState(p);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: true; serverInfo?: string } | { ok: false; error: string; hint?: string }>(null);
  const isMysql = draft.driver === 'mysql';
  const showToast = useStore(s => s.showToast);
  // Local "I should disappear" flag. We render null when this is true,
  // so even if the parent's setEditing(null) somehow doesn't propagate,
  // the editor disappears visually.
  const [dismissed, setDismissed] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const setField = (patch: Partial<typeof draft>) => { setDraft(d => ({ ...d, ...patch })); setTestResult(null); };
  const setDriver = (driver: 'mysql' | 'postgres' | 'elasticsearch') => setDraft(d => {
    const defaultPort = driver === 'mysql' ? 3306 : driver === 'postgres' ? 5432 : 9200;
    const looksDefault = [3306, 5432, 9200].includes(d.port);
    return {
      ...d,
      driver,
      port: looksDefault ? defaultPort : d.port,
      ssl: driver === 'elasticsearch' ? (d.ssl ?? false) : undefined,
      allowSelfSigned: driver === 'elasticsearch' ? (d.allowSelfSigned ?? false) : undefined
    };
  });

  const test = async () => {
    setTesting(true); setTestResult(null);
    try { setTestResult(await window.opendev.db.test(draft)); }
    catch (e: any) { setTestResult({ ok: false, error: e?.message || String(e) }); }
    finally { setTesting(false); }
  };

  // Kept for the button's enabled state, but the new save() flow no
  // longer waits for the IPC before closing — so this stays false in
  // practice. Left in to avoid re-jiggering the disabled prop.
  const [saving] = useState(false);

  // Closes the editor in three ways at once (belt-and-suspenders): local
  // dismissed flag, parent onClose callback, and parent onSaved (which
  // also clears `editing` and refreshes the list). Any one of these
  // alone should hide the modal; together it's bulletproof.
  const closeEditor = () => {
    console.log('[DbProfileEditor.closeEditor] called');
    // 1) Synchronously hide via DOM — guaranteed to disappear this frame
    //    regardless of any React state-update issues downstream.
    if (overlayRef.current) overlayRef.current.style.display = 'none';
    // 2) Flip the local dismissed flag → next render returns null.
    setDismissed(true);
    // 3) Tell the parent to unmount us via its setEditing(null) callback.
    try { onClose(); } catch (e) { console.error('[DbProfileEditor.closeEditor] onClose threw', e); }
  };

  const save = () => {
    if (saving) return;
    console.log('[DbProfileEditor.save] click — closing modal then running IPC', { id: draft.id, name: draft.name });
    // Close the modal IMMEDIATELY — before we even touch the IPC. The
    // user clicked Save; their intent is unambiguous. We then run the
    // IPC in the background and surface success/error via toast. This
    // makes it impossible for any IPC issue (hang, throw, slow keychain)
    // to keep the modal stuck open.
    const snapshot = { ...draft };
    closeEditor();
    onSaved();
    // Fire-and-forget. Errors become toasts; success becomes a toast.
    (async () => {
      try {
        const result = await window.opendev.db.save(snapshot);
        console.log('[DbProfileEditor.save] success', result);
        showToast(`Saved "${snapshot.name}"`, 2000);
      } catch (e: any) {
        const msg = `Save failed for "${snapshot.name}": ${e?.message || e}`;
        console.error('[DbProfileEditor.save] error', e);
        showToast(msg, 7000);
      }
    })();
  };

  if (dismissed) {
    console.log('[DbProfileEditor] dismissed=true → returning null');
    return null;
  }
  const saveDisabledReason = !draft.name ? 'Enter a name' :
    !draft.host ? 'Enter a host' :
    !draft.user ? 'Enter a user' :
    !draft.port ? 'Enter a port' : '';

  return (
    <div
      className="modal-overlay"
      onMouseDown={closeEditor}
      ref={overlayRef}
    >
      <div className="modal db-editor" onMouseDown={(e) => e.stopPropagation()}>
        <div className="db-editor-header">
          <span>{p.id ? 'Edit connection' : 'New connection'} <span style={{ color: 'var(--fg-3)', fontWeight: 400, fontSize: 11, marginLeft: 6 }}>v{window.opendev.app.version()}</span></span>
          <button className="db-editor-x" onClick={closeEditor}>×</button>
        </div>

        <div className="db-editor-body">
          <div className="db-driver-cards">
            {allowedDrivers.includes('mysql') && (
              <button
                type="button"
                className={`db-driver-card ${draft.driver === 'mysql' ? 'active' : ''}`}
                onClick={() => setDriver('mysql')}>
                <div className="db-driver-name">MySQL</div>
                <div className="db-driver-port">default :3306</div>
              </button>
            )}
            {allowedDrivers.includes('postgres') && (
              <button
                type="button"
                className={`db-driver-card ${draft.driver === 'postgres' ? 'active' : ''}`}
                onClick={() => setDriver('postgres')}>
                <div className="db-driver-name">Postgres</div>
                <div className="db-driver-port">default :5432</div>
              </button>
            )}
            {allowedDrivers.includes('elasticsearch') && (
              <button
                type="button"
                className={`db-driver-card ${draft.driver === 'elasticsearch' ? 'active' : ''}`}
                onClick={() => setDriver('elasticsearch')}>
                <div className="db-driver-name">ES / OpenSearch</div>
                <div className="db-driver-port">default :9200</div>
              </button>
            )}
          </div>

          <div className="db-field">
            <label>Name</label>
            <input value={draft.name} placeholder="e.g. prod-db"
              onChange={(e) => setField({ name: e.target.value })} />
          </div>

          <div className="db-field-row">
            <div className="db-field grow">
              <label>Host</label>
              <input value={draft.host} placeholder="127.0.0.1 or 192.168.x.x"
                spellCheck={false} autoCapitalize="off"
                onChange={(e) => setField({ host: e.target.value })} />
            </div>
            <div className="db-field" style={{ width: 100 }}>
              <label>Port</label>
              <input
                type="text"
                inputMode="numeric"
                value={draft.port ? String(draft.port) : ''}
                placeholder={draft.driver === 'mysql' ? '3306' : draft.driver === 'postgres' ? '5432' : '9200'}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/[^0-9]/g, '');
                  setField({ port: cleaned ? Number(cleaned) : 0 });
                }}
              />
            </div>
          </div>

          <div className="db-field-row">
            <div className="db-field grow">
              <label>User</label>
              <input value={draft.user} placeholder="David.Zhao"
                spellCheck={false} autoCapitalize="off"
                onChange={(e) => setField({ user: e.target.value })} />
            </div>
            <div className="db-field grow">
              <label>Password</label>
              <input type="password" value={draft.password || ''}
                placeholder={p.id ? '(unchanged)' : '••••••••'}
                onChange={(e) => setField({ password: e.target.value })} />
            </div>
          </div>

          {draft.driver !== 'elasticsearch' && (
            <div className="db-field">
              <label>Database <span className="db-field-opt">(optional)</span></label>
              <input value={draft.database || ''} placeholder="leave blank to list all"
                onChange={(e) => setField({ database: e.target.value })} />
            </div>
          )}

          <div className="db-field-checks">
            <label className="db-check">
              <input type="checkbox" checked={!!draft.readOnly}
                onChange={(e) => setField({ readOnly: e.target.checked })} />
              <span>Read-only (block DROP / DELETE / UPDATE / INSERT)</span>
            </label>
            {draft.driver === 'elasticsearch' && (
              <>
                <label className="db-check">
                  <input type="checkbox" checked={!!draft.ssl}
                    onChange={(e) => setField({ ssl: e.target.checked })} />
                  <span>Use HTTPS</span>
                </label>
                <label className="db-check">
                  <input type="checkbox" checked={!!draft.allowSelfSigned} disabled={!draft.ssl}
                    onChange={(e) => setField({ allowSelfSigned: e.target.checked })} />
                  <span>Accept self-signed certificates</span>
                </label>
              </>
            )}
          </div>

          {testResult && (
            <div className={`db-test-result ${testResult.ok ? 'ok' : 'err'}`}>
              {testResult.ok ? (
                <>
                  <strong>✓ Connected</strong>
                  {testResult.serverInfo && <span className="db-test-info">{testResult.serverInfo}</span>}
                  {('viaRelay' in testResult) && testResult.viaRelay && (
                    <div className="db-test-hint">Routed through /usr/bin/nc to bypass macOS Sequoia's LAN filter for unsigned apps.</div>
                  )}
                </>
              ) : (
                <>
                  <strong>✗ Failed</strong>
                  <div className="db-test-error">{testResult.error}</div>
                  {testResult.hint && <div className="db-test-hint">{testResult.hint}</div>}
                </>
              )}
            </div>
          )}
        </div>

        <div className="db-editor-footer">
          {p.id ? (
            <button className="link-danger" onClick={async () => {
              if (confirm(`Delete ${p.name}?`)) { await window.opendev.db.delete(p.id); onSaved(); }
            }}>Delete</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {saveDisabledReason && <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{saveDisabledReason}</span>}
            <button onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test Connection'}</button>
            <button onClick={closeEditor}>Cancel</button>
            <button
              className="primary"
              onClick={save}
              // NEVER disable — the user reported that for DB connections
              // (mysql/postgres) where required fields were empty, Save
              // was greyed out and their clicks did nothing, which they
              // experienced as "Save doesn't close the modal". For ES the
              // validation passed so Save worked. Now the click ALWAYS
              // fires save(), which closes the modal regardless; the
              // background IPC reports any validation/save error via
              // toast.
              title={saveDisabledReason ? `${saveDisabledReason} (will save anyway)` : 'Save connection'}
            >Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
