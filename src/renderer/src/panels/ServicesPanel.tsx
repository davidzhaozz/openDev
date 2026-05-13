import { useEffect, useRef, useState } from 'react';
import type { ServiceDef } from '../../../shared/types';
import { useStore } from '../state/store';

const URL_REGEX = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/i;
const PORT_REGEX = /(?:listening (?:at|on)[^\d]{1,40}|on port |port[:\s]+|^port )(\d{2,5})\b/im;

function portFromLog(log: string | undefined): number | null {
  if (!log) return null;
  const tail = log.slice(-4000);
  const u = tail.match(URL_REGEX);
  if (u) return Number(u[1]);
  const m = tail.match(PORT_REGEX);
  return m ? Number(m[1]) : null;
}

export function ServicesPanel() {
  const [livePorts, setLivePorts] = useState<Record<string, number[]>>({});
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const openBrowserTab = useStore(s => s.openBrowserTab);
  const livePortsRef = useRef(livePorts);
  livePortsRef.current = livePorts;
  const services = useStore(s => s.services);
  const setServices = useStore(s => s.setServices);
  const statuses = useStore(s => s.serviceStatuses);
  const setStatus = useStore(s => s.setServiceStatus);
  const appendLog = useStore(s => s.appendServiceLog);
  const logs = useStore(s => s.serviceLogs);
  const showToast = useStore(s => s.showToast);
  const [expanded, setExpanded] = useState<string | undefined>();
  const [editing, setEditing] = useState<ServiceDef | null>(null);
  const pendingDraft = useStore(s => s.pendingServiceDraft);
  const clearPendingDraft = useStore(s => s.setPendingServiceDraft);

  useEffect(() => {
    let alive = true;
    const refresh = () => window.opendev.services.list().then(l => { if (alive) setServices(l); });
    refresh();
    const offChange = window.opendev.services.onChanged(() => refresh());
    return () => { alive = false; offChange(); };
  }, [setServices]);
  useEffect(() => {
    const off1 = window.opendev.services.onStatus(r => setStatus(r));
    const off2 = window.opendev.services.onLog(({ id, chunk }) => appendLog(id, chunk));
    return () => { off1(); off2(); };
  }, [setStatus, appendLog]);

  useEffect(() => {
    if (!pendingDraft) return;
    setEditing({ id: '', name: pendingDraft.name, command: pendingDraft.command, cwd: pendingDraft.cwd });
    clearPendingDraft(undefined);
  }, [pendingDraft, clearPendingDraft]);

  // Poll lsof every 2s for ports actually bound by each running service's
  // process group. Log-scraping alone misses backends that don't print a
  // recognizable startup line (ts-node-dev, plain Node servers, etc.).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const m = await window.opendev.services.ports();
        if (alive) setLivePorts(m);
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const refresh = async () => setServices(await window.opendev.services.list());

  const start = async (id: string) => {
    try { await window.opendev.services.start(id); }
    catch (e: any) { showToast(`Failed to start: ${e?.message || e}`, 5000); }
  };
  const stop = async (id: string) => {
    try { await window.opendev.services.stop(id); }
    catch (e: any) { showToast(`Stop failed: ${e?.message || e}`, 4000); }
  };
  const restart = async (id: string) => {
    try { await window.opendev.services.restart(id); }
    catch (e: any) { showToast(`Restart failed: ${e?.message || e}`, 4000); }
  };

  const startAll = () => { for (const s of services) start(s.id); };
  const stopAll = () => { for (const s of services) stop(s.id); };
  // Restart only the services that are actually running. Restarting a
  // stopped service would just start it — fine, but the explicit
  // semantics of "Restart All" means "bounce what's up", not "start
  // everything". If nothing is running we fall back to startAll().
  const restartAll = async () => {
    const running = services.filter(s => {
      const st = statuses[s.id]?.status;
      return st === 'running' || st === 'starting';
    });
    if (running.length === 0) {
      showToast('Nothing is running — starting all instead.', 2500);
      startAll();
      return;
    }
    showToast(`Restarting ${running.length} service${running.length === 1 ? '' : 's'}…`, 2500);
    // Fire restarts in parallel — each one stops + starts independently.
    await Promise.all(running.map(s => restart(s.id)));
  };
  const view = (s: ServiceDef) => {
    const port = livePortsRef.current[s.id]?.[0] ?? s.port;
    if (!port) { showToast('No port detected yet — wait a moment after starting.', 3000); return; }
    openBrowserTab(`http://localhost:${port}`, `${s.name} :${port}`);
  };

  useEffect(() => {
    const dismiss = () => setCtx(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, []);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Services</span>
        <span className="grow" />
        <button className="icon" onClick={refresh}>↻</button>
        <button className="icon" onClick={() => setEditing({ id: '', name: '', command: '', cwd: '' })}>+</button>
        <button onClick={startAll} title="Start every service">Start All</button>
        <button onClick={restartAll} title="Restart every running service">Restart All</button>
        <button onClick={stopAll} title="Stop every running service">Stop All</button>
      </div>
      <div className="panel-body">
        <div className="services-list">
          {services.map(s => {
            const st = statuses[s.id]?.status || 'stopped';
            const isExp = expanded === s.id;
            const port = livePorts[s.id]?.[0] ?? portFromLog(logs[s.id]) ?? s.port;
            const running = st === 'running' || st === 'starting';
            return (
              <div key={s.id}>
                <div className="svc-row"
                  onClick={() => setExpanded(isExp ? undefined : s.id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, id: s.id }); }}>
                  <span className={`dot ${st}`} title={st} />
                  <span className="name">{s.name}</span>
                  {port && (
                    <span
                      className="svc-port"
                      onClick={(e) => { e.stopPropagation(); window.opendev.fs.reveal(`http://localhost:${port}`); }}
                      title={`http://localhost:${port}`}
                    >:{port}</span>
                  )}
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    {!running && <button title="Start" onClick={() => start(s.id)}>▶</button>}
                    {running && <button title="Stop" onClick={() => stop(s.id)}>■</button>}
                    <button title="Reload (stop + start)" onClick={() => restart(s.id)}>↻</button>
                    {!s.id.startsWith('auto-') && <button title="Delete" onClick={async () => {
                      if (confirm(`Delete service ${s.name}?`)) { await window.opendev.services.delete(s.id); refresh(); }
                    }}>✕</button>}
                  </div>
                </div>
                {isExp && (
                  <div className="svc-log-peek">
                    <div className="svc-log-meta">
                      <span>{st}{statuses[s.id]?.pid ? ` · pid ${statuses[s.id]?.pid}` : ''}</span>
                      <span className="grow" />
                      {statuses[s.id]?.lastError && <span style={{ color: 'var(--danger)' }}>{statuses[s.id]?.lastError}</span>}
                    </div>
                    <pre className="svc-log-body">
                      {logs[s.id] ? logs[s.id].slice(-2000) : <span style={{ color: 'var(--fg-3)' }}>No output yet — click ▶ to start</span>}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
          {!services.length && <div style={{ padding: 14, color: 'var(--fg-3)' }}>No services. Click + or open a project with apps/*.</div>}
        </div>
      </div>
      {ctx && (() => {
        const svc = services.find(s => s.id === ctx.id);
        if (!svc) return null;
        const st = statuses[svc.id]?.status || 'stopped';
        const isRunning = st === 'running' || st === 'starting';
        const hasPort = (livePorts[svc.id]?.[0] ?? svc.port) != null;
        return (
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
            <div className="item" onClick={() => { start(svc.id); setCtx(null); }}>Start</div>
            <div className="item" style={{ opacity: isRunning ? 1 : 0.4 }}
              onClick={() => { if (isRunning) { stop(svc.id); setCtx(null); } }}>Stop</div>
            <div className="item" style={{ opacity: hasPort && isRunning ? 1 : 0.4 }}
              onClick={() => { if (hasPort && isRunning) { view(svc); setCtx(null); } }}>View</div>
            <div className="sep" />
            <div className="item" onClick={() => { restart(svc.id); setCtx(null); }}>Reload</div>
            {!svc.id.startsWith('auto-') && (
              <>
                <div className="sep" />
                <div className="item" onClick={() => { setEditing({ ...svc }); setCtx(null); }}>Edit…</div>
                <div className="item" onClick={async () => {
                  setCtx(null);
                  if (confirm(`Delete service ${svc.name}?`)) { await window.opendev.services.delete(svc.id); refresh(); }
                }}>Delete</div>
              </>
            )}
          </div>
        );
      })()}
      {editing && <ServiceEditor def={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function ServiceEditor({ def, onClose, onSaved }: { def: ServiceDef; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(def.name);
  const [cmd, setCmd] = useState(def.command);
  const [cwd, setCwd] = useState(def.cwd);
  // Local dismissed flag so the modal disappears even if the parent's
  // setEditing(null) somehow doesn't propagate. Render null when set.
  const [dismissed, setDismissed] = useState(false);
  const showToast = useStore(s => s.showToast);

  const closeEditor = () => {
    setDismissed(true);
    onClose();
  };

  const save = () => {
    // Close the modal IMMEDIATELY (optimistic). The IPC runs in
    // background so a hang/error can never trap the user with the modal
    // open. Errors become toasts.
    console.log('[ServiceEditor.save] click — closing then saving in background', { id: def.id, name });
    const snapshot = { ...def, name, command: cmd, cwd };
    closeEditor();
    onSaved();
    (async () => {
      try {
        await window.opendev.services.save(snapshot);
        console.log('[ServiceEditor.save] success');
        showToast(`Saved service "${snapshot.name}"`, 2000);
      } catch (e: any) {
        console.error('[ServiceEditor.save] error', e);
        showToast(`Save failed for "${snapshot.name}": ${e?.message || e}`, 6000);
      }
    })();
  };

  if (dismissed) return null;

  return (
    <div className="modal-overlay" onMouseDown={closeEditor}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'center' }}>
          <label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Command</label><input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm run dev" />
          <label>Working dir</label><input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="apps/gateway" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={closeEditor}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
