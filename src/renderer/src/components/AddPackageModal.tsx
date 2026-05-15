import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { DetectedProject } from '../../../shared/types';

// Add a dependency to a Maven (Java) or .NET (C#) project. The project is
// identified by the folder the user right-clicked in the file tree; the
// modal auto-detects the type and pivots its UX (Maven needs the
// "groupId:artifactId[:version]" coordinate; .NET takes a NuGet name).

type Phase = 'form' | 'adding' | 'done' | 'error';

export function AddPackageModal({ dir, onClose }: { dir: string; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const [det, setDet] = useState<DetectedProject | null | 'loading'>('loading');
  const [pkg, setPkg] = useState('');
  const [version, setVersion] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [log, setLog] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    window.opendev.packages.detect(dir).then(setDet).catch(() => setDet(null));
  }, [dir]);
  useEffect(() => {
    const off = window.opendev.packages.onLog((line) => setLog((s) => s + line));
    return off;
  }, []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const submit = async () => {
    if (!det || det === 'loading') return;
    if (!pkg.trim()) { showToast('Enter a package name.', 2000); return; }
    setPhase('adding');
    setLog('');
    setErrorMsg(undefined);
    try {
      const r = await window.opendev.packages.add({
        projectDir: dir,
        type: det.type,
        packageId: pkg.trim(),
        version: version.trim() || undefined
      });
      if (r.ok) setPhase('done');
      else { setErrorMsg(r.error); setPhase('error'); }
    } catch (err) {
      setErrorMsg((err as Error).message);
      setPhase('error');
    }
  };

  const canClose = phase !== 'adding';

  const placeholder = det && det !== 'loading'
    ? (det.type === 'maven'
        ? 'org.springframework.boot:spring-boot-starter-data-jpa'
        : 'Newtonsoft.Json')
    : '';
  const versionPlaceholder = det && det !== 'loading'
    ? (det.type === 'maven' ? '(optional — managed by parent POM if blank)' : '(optional — latest if blank)')
    : '';

  return (
    <div className="modal-overlay" onClick={() => canClose && onClose()}>
      <div className="modal new-project-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Add Package</span>
          {canClose && <button className="modal-x" onClick={onClose}>✕</button>}
        </div>

        {det === 'loading' && <div className="np-form">Detecting project type…</div>}

        {det === null && (
          <div className="np-form">
            <div className="np-error">No Maven (pom.xml) or .NET (.csproj) project found in this folder.</div>
            <div className="np-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        )}

        {det && det !== 'loading' && (phase === 'form' || phase === 'error') && (
          <div className="np-form">
            <div className="np-row">
              <label>Project</label>
              <span className="np-detected">{det.label}</span>
            </div>
            <div className="np-row">
              <label>{det.type === 'maven' ? 'Coordinate' : 'Package'}</label>
              <input
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder={placeholder}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </div>
            <div className="np-row">
              <label>Version</label>
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder={versionPlaceholder}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </div>
            <div className="np-desc">
              {det.type === 'maven'
                ? <>Edits <code>pom.xml</code> to add the dependency, then runs <code>mvn install -DskipTests</code> to fetch it.</>
                : <>Runs <code>dotnet add package</code> against <code>{det.label}</code> — it edits the .csproj and restores in one step.</>}
            </div>
            {phase === 'error' && errorMsg && <div className="np-error">{errorMsg}</div>}
            {log && phase === 'error' && <pre ref={logRef} className="np-log">{log}</pre>}
            <div className="np-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={submit} disabled={!pkg.trim()}>Add</button>
            </div>
          </div>
        )}

        {phase === 'adding' && (
          <div className="np-creating">
            <div className="np-status">Adding <strong>{pkg}</strong>…</div>
            <pre ref={logRef} className="np-log">{log || 'Starting…'}</pre>
          </div>
        )}

        {phase === 'done' && (
          <div className="np-done">
            <div className="np-success">✓ Added <code>{pkg}</code></div>
            <pre ref={logRef} className="np-log">{log}</pre>
            <div className="np-actions">
              <button className="primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
