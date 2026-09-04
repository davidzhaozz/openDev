import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipPackage, PipRequirement, PythonInterpreter } from '../../../shared/types';
import { useStore } from '../state/store';
import { baseName } from '@shared/paths';

// PyCharm-style package manager. Lists pip-installed packages for the
// workspace's selected interpreter, marks outdated ones, and runs
// install/uninstall/upgrade with streaming output. Reads requirements.txt
// when present and offers to `pip install -r` it.

export function PipPanel() {
  const [interp, setInterp] = useState<PythonInterpreter | null>(null);
  const [pkgs, setPkgs] = useState<PipPackage[] | null>(null);
  const [outdated, setOutdated] = useState<Record<string, string>>({});
  const [loadingOutdated, setLoadingOutdated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [installSpec, setInstallSpec] = useState('');
  const [installLog, setInstallLog] = useState('');
  const [reqs, setReqs] = useState<{ path: string; requirements: PipRequirement[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const showToast = useStore((s) => s.showToast);

  const refresh = async () => {
    setError(null);
    setPkgs(null);
    try {
      const list = await window.opendev.pip.list();
      setPkgs(list);
    } catch (e: any) {
      setError(e?.message || String(e));
      setPkgs([]);
    }
  };

  const refreshOutdated = async () => {
    setLoadingOutdated(true);
    try {
      const m = await window.opendev.pip.outdated();
      setOutdated(m);
    } catch { /* network failure handled silently */ }
    finally { setLoadingOutdated(false); }
  };

  const refreshReqs = async () => {
    try {
      const r = await window.opendev.pip.readRequirements();
      setReqs(r);
    } catch { setReqs(null); }
  };

  useEffect(() => {
    (async () => {
      const cur = await window.opendev.python.get();
      setInterp(cur);
    })();
    const offChange = window.opendev.python.onChanged((cur) => { setInterp(cur); refresh(); refreshReqs(); });
    const offLog = window.opendev.pip.onLog((chunk) => setInstallLog((s) => (s + chunk).slice(-12000)));
    const offBusy = window.opendev.pip.onBusy((b) => setBusy(b));
    refresh();
    refreshReqs();
    return () => { offChange(); offLog(); offBusy(); };
  }, []);

  // Autoscroll the install log when new lines arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [installLog]);

  const visiblePkgs = useMemo(() => {
    if (!pkgs) return [];
    const q = filter.trim().toLowerCase();
    return q ? pkgs.filter((p) => p.name.toLowerCase().includes(q)) : pkgs;
  }, [pkgs, filter]);

  const doInstall = async () => {
    const spec = installSpec.trim();
    if (!spec) return;
    setInstallLog('');
    try {
      await window.opendev.pip.install(spec);
      showToast(`Installed ${spec}`, 2500);
      setInstallSpec('');
      await refresh();
      await refreshReqs();
    } catch (e: any) {
      showToast(`Install failed: ${e?.message || e}`, 6000);
    }
  };

  const doUninstall = async (name: string) => {
    if (!confirm(`Uninstall ${name}?`)) return;
    setInstallLog('');
    try {
      await window.opendev.pip.uninstall(name);
      showToast(`Uninstalled ${name}`, 2500);
      await refresh();
      await refreshReqs();
    } catch (e: any) {
      showToast(`Uninstall failed: ${e?.message || e}`, 6000);
    }
  };

  const doUpgrade = async (name: string) => {
    setInstallLog('');
    try {
      await window.opendev.pip.upgrade(name);
      showToast(`Upgraded ${name}`, 2500);
      await refresh();
      // Drop just this package from the outdated map.
      setOutdated((m) => {
        const { [name.toLowerCase()]: _drop, ...rest } = m;
        return rest;
      });
    } catch (e: any) {
      showToast(`Upgrade failed: ${e?.message || e}`, 6000);
    }
  };

  const doInstallReqs = async () => {
    if (!reqs) return;
    setInstallLog('');
    try {
      await window.opendev.pip.installRequirements(reqs.path);
      showToast(`Installed from ${baseName(reqs.path)}`, 2500);
      await refresh();
      await refreshReqs();
    } catch (e: any) {
      showToast(`Install -r failed: ${e?.message || e}`, 6000);
    }
  };

  return (
    <div className="pip-panel">
      <div className="pip-header">
        <span>Packages</span>
        {interp && (
          <span className="pip-interp" title={interp.path}>
            Python {interp.version || '?'}{interp.label ? ` · ${interp.label}` : ''}
          </span>
        )}
        <span className="grow" />
        <button onClick={refresh} disabled={busy} title="Reload installed packages">↻ Reload</button>
        <button onClick={refreshOutdated} disabled={busy || loadingOutdated} title="Check PyPI for newer versions">
          {loadingOutdated ? 'Checking…' : 'Check outdated'}
        </button>
      </div>

      <div className="pip-install-row">
        <input
          className="pip-install-input"
          placeholder="package name (e.g. mlx-lm, torch>=2.1, requests~=2.31)"
          value={installSpec}
          onChange={(e) => setInstallSpec(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doInstall(); }}
          disabled={busy}
        />
        <button onClick={doInstall} disabled={busy || !installSpec.trim()} className="primary">Install</button>
      </div>

      {reqs && (
        <div className="pip-reqs">
          <div className="pip-reqs-head">
            <span>requirements.txt — <code>{reqs.path.replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/')}</code></span>
            <span className="grow" />
            <span className="pip-reqs-summary">
              {reqs.requirements.filter((r) => r.installed).length} / {reqs.requirements.filter((r) => r.name).length} installed
            </span>
            <button onClick={doInstallReqs} disabled={busy}>pip install -r</button>
          </div>
          <div className="pip-reqs-body">
            {reqs.requirements.map((r, i) => (
              <span key={i} className={`pip-req-pill ${r.installed ? 'ok' : r.name ? 'miss' : 'unknown'}`}
                title={r.name ? (r.installed ? `installed: ${r.installedVersion}` : 'not installed') : 'non-package line'}>
                {r.spec}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="pip-filter-row">
        <input
          className="pip-filter-input"
          placeholder="Filter installed…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>
          {pkgs ? `${visiblePkgs.length} of ${pkgs.length}` : 'loading…'}
        </span>
      </div>

      {error && <div className="pip-error">{error}</div>}

      <div className="pip-list">
        {!pkgs && !error && <div className="pip-empty">Loading…</div>}
        {pkgs && pkgs.length === 0 && !error && (
          <div className="pip-empty">No packages installed in this interpreter.</div>
        )}
        {visiblePkgs.map((p) => {
          const newer = outdated[p.name.toLowerCase()];
          return (
            <div key={p.name} className="pip-row">
              <span className="pip-name">{p.name}</span>
              <span className="pip-version">{p.version}</span>
              {newer && <span className="pip-latest" title="Latest on PyPI">→ {newer}</span>}
              <div className="pip-actions">
                {newer && <button onClick={() => doUpgrade(p.name)} disabled={busy}>Upgrade</button>}
                <button onClick={() => doUninstall(p.name)} disabled={busy}>Uninstall</button>
              </div>
            </div>
          );
        })}
      </div>

      {installLog && (
        <pre ref={logRef} className="pip-log">{installLog}</pre>
      )}
    </div>
  );
}
