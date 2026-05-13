import { useEffect, useState } from 'react';
import type { ListeningPort } from '../../../shared/types';
import { useStore } from '../state/store';

export function PortsPanel({ onOpen }: { onOpen: (url: string) => void }) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const showToast = useStore(s => s.showToast);

  const refresh = async () => setPorts(await window.opendev.ports.list());
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);

  const free = async (port: number, command: string) => {
    if (!confirm(`Kill the process listening on port ${port} (${command})?`)) return;
    setBusy(port);
    try {
      const r = await window.opendev.ports.free(port);
      if (r.killed.length > 0) {
        showToast(`Freed port ${port} (killed PID${r.killed.length === 1 ? '' : 's'} ${r.killed.join(', ')})`, 3000);
      } else {
        showToast(`Port ${port} was already free.`, 2000);
      }
      await refresh();
    } catch (e: any) {
      showToast(`Free port ${port} failed: ${e?.message || e}`, 4000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Ports</span>
        <span className="grow" />
        <button className="icon" onClick={refresh}>↻</button>
      </div>
      <div className="panel-body">
        <table className="grid">
          <thead><tr><th>Port</th><th>PID</th><th>Command</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>
            {ports.map(p => (
              <tr key={`${p.port}-${p.pid}`}>
                <td>{p.port}</td>
                <td>{p.pid}</td>
                <td>{p.command}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => onOpen(`http://localhost:${p.port}`)} title="Open in browser">↗</button>
                  <button
                    onClick={() => free(p.port, p.command || '')}
                    disabled={busy === p.port}
                    style={{ marginLeft: 6, color: '#e57373' }}
                    title="Kill the process holding this port"
                  >{busy === p.port ? '…' : 'Free'}</button>
                </td>
              </tr>
            ))}
            {ports.length === 0 && (
              <tr><td colSpan={4} style={{ color: 'var(--fg-2)', fontSize: 12, padding: 12 }}>No listening ports.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
