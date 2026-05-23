import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { LogPanel } from '../panels/LogPanel';
import { DebugPanel } from '../panels/DebugPanel';
import { RunPanel } from '../panels/RunPanel';
import type { SystemStats } from '../../../shared/types';

// Application bottom bar — hosts LOG and DEBUG panels that used to live in
// the right column. Collapsing leaves only the tab strip visible so the
// user can keep the workspace at full height when the panels are idle.

export function BottomBar() {
  const tab = useStore(s => s.bottomTab);
  const setTab = useStore(s => s.setBottomTab);
  const collapsed = useStore(s => s.bottomCollapsed);
  const toggle = useStore(s => s.toggleBottom);

  return (
    <div className={`bottom-bar ${collapsed ? 'collapsed' : ''}`}>
      <div className="bottom-tabs">
        {(['log', 'debug', 'run'] as const).map(k => (
          <div
            key={k}
            className={`bottom-tab ${tab === k ? 'active' : ''}`}
            onClick={() => {
              if (tab === k) toggle();
              else { setTab(k); if (collapsed) toggle(); }
            }}
            title={tab === k ? (collapsed ? 'Expand' : 'Collapse') : `Show ${k.toUpperCase()}`}
          >
            {k === 'log' ? 'LOG' : k === 'debug' ? 'DEBUG' : 'RUN'}
          </div>
        ))}
        <span className="grow" />
        <FreeMemoryButton />
        <SystemStatsChip />
        <button
          className="bottom-collapse"
          onClick={toggle}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >{collapsed ? '▲' : '▼'}</button>
      </div>
      {!collapsed && (
        <div className="bottom-body">
          <div style={{ height: '100%', display: tab === 'log' ? 'flex' : 'none', flexDirection: 'column' }}>
            <LogPanel />
          </div>
          <div style={{ height: '100%', display: tab === 'debug' ? 'flex' : 'none', flexDirection: 'column' }}>
            <DebugPanel />
          </div>
          <div style={{ height: '100%', display: tab === 'run' ? 'flex' : 'none', flexDirection: 'column' }}>
            <RunPanel />
          </div>
        </div>
      )}
    </div>
  );
}

// Whole-system memory + CPU readout for the bottom-bar strip. Updates every
// ~2s from the main-process sampler. Colors:
//   ≥90% memory → red ("about to swap"); ≥80% → amber; otherwise muted.
// Same thresholds for CPU. Title text exposes load average for ssh-vibe
// debugging without taking up bar space.
function SystemStatsChip() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    const off = window.opendev.system.onStats((s) => setStats(s));
    return off;
  }, []);
  if (!stats) return null;
  const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(1);
  const memPct = stats.memTotalBytes > 0 ? (stats.memUsedBytes / stats.memTotalBytes) * 100 : 0;
  const memCls = memPct >= 90 ? 'critical' : memPct >= 80 ? 'warn' : 'ok';
  const cpuCls = stats.cpuPct >= 90 ? 'critical' : stats.cpuPct >= 80 ? 'warn' : 'ok';
  const fdPct = stats.fdLimit > 0 ? (stats.fdCount / stats.fdLimit) * 100 : 0;
  // Don't warn against a generous limit (Terminal-launched dev runs inherit
  // millions of fds) — only color-code when the limit is small enough that
  // the count could realistically hit it.
  const fdMeaningful = stats.fdLimit > 0 && stats.fdLimit <= 4096;
  const fdCls = fdMeaningful ? (fdPct >= 90 ? 'critical' : fdPct >= 80 ? 'warn' : 'ok') : 'ok';
  const loadStr = stats.loadAvg.map((n) => n.toFixed(2)).join(', ');
  // GPU pill — static info probed once at startup. Hide entirely if the
  // probe didn't find anything (non-Mac, probe failed, etc.) rather than
  // showing a misleading "GPU 0".
  const gpuLabel = stats.gpuCount > 0
    ? (stats.gpuCount === 1
        ? (stats.gpuCores > 0 ? `GPU ${stats.gpuCores}c` : 'GPU 1')
        : (stats.gpuCores > 0 ? `GPU ${stats.gpuCount}× ${stats.gpuCores}c` : `GPU ${stats.gpuCount}`))
    : null;
  const gpuTitle = stats.gpuCount > 0
    ? `${stats.gpuCount} GPU${stats.gpuCount === 1 ? '' : 's'}${stats.gpuCores > 0 ? `, ${stats.gpuCores} core${stats.gpuCores === 1 ? '' : 's'} total` : ''}`
    : '';
  return (
    <div
      className="sys-stats"
      title={`load avg: ${loadStr}\nmem: ${gb(stats.memUsedBytes)} / ${gb(stats.memTotalBytes)} GB (${memPct.toFixed(0)}%)\ncpu: ${stats.cpuPct.toFixed(1)}%\nfd: ${stats.fdCount}${stats.fdLimit ? ` / ${stats.fdLimit}` : ''}${gpuTitle ? `\ngpu: ${gpuTitle}` : ''}`}
    >
      <span className={`sys-stat-pill ${memCls}`}>MEM {gb(stats.memUsedBytes)}/{gb(stats.memTotalBytes)}G</span>
      <span className={`sys-stat-pill ${cpuCls}`}>CPU {stats.cpuPct.toFixed(0)}%</span>
      <span className={`sys-stat-pill ${fdCls}`}>FD {stats.fdCount}{stats.fdLimit ? `/${formatFdLimit(stats.fdLimit)}` : ''}</span>
      {gpuLabel && <span className="sys-stat-pill ok" title={gpuTitle}>{gpuLabel}</span>}
    </div>
  );
}

// Compact display for the fd limit: keeps the pill narrow when ulimit is
// generous (Terminal-launched dev hands the IDE 1,048,576 by default —
// "1M" is more readable than "1048576").
function formatFdLimit(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

// One-click "free unused resources" — kills idle LSPs (they respawn lazily
// on next use) and drops accumulated renderer log buffers. Toast reports
// reclaimed main-process RSS. The actual savings depend on what was idle.
function FreeMemoryButton() {
  const showToast = useStore((s) => s.showToast);
  const clearLogBubbles = useStore((s) => s.clearLogBubbles);
  const onClick = async () => {
    try {
      const r = await window.opendev.system.freeMemory();
      clearLogBubbles();
      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
      const reclaimed = Math.max(0, r.mainRssBefore - r.mainRssAfter);
      const parts: string[] = [];
      if (r.lspsKilled > 0) parts.push(`killed ${r.lspsKilled} LSP${r.lspsKilled === 1 ? '' : 's'}`);
      parts.push(`reclaimed ${mb(reclaimed)} main RSS`);
      showToast(`Memory freed: ${parts.join(', ')}`, 4000);
    } catch (e: any) {
      showToast(`Free memory failed: ${e?.message || e}`, 4000);
    }
  };
  return (
    <button
      className="sys-free-btn"
      onClick={onClick}
      title="Free unused resources (kills idle LSPs, drops log buffers). They'll respawn lazily on next use."
    >🧹</button>
  );
}
