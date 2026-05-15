import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { InstallableTool, ProjectTemplate } from '../../../shared/types';

// Single-step new-project wizard: language → framework → name + destination,
// then Create. CLI-based templates and post-install steps stream live log
// output into a console area so the user sees what's happening.

type Phase = 'form' | 'creating' | 'installing' | 'done' | 'error';

// Tools the wizard knows how to install in-app via brew. Anything else is
// surfaced as a plain error.
const INSTALLABLE: ReadonlySet<InstallableTool> = new Set<InstallableTool>(['node', 'dotnet', 'mvn', 'java', 'tsx']);

export function NewProjectModal({ onClose, initialDest }: { onClose: () => void; initialDest?: string }) {
  const showToast = useStore((s) => s.showToast);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [language, setLanguage] = useState<string>('');
  const [templateId, setTemplateId] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [dest, setDest] = useState<string>(initialDest ?? '');
  const [phase, setPhase] = useState<Phase>('form');
  const [log, setLog] = useState<string>('');
  const [createdPath, setCreatedPath] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  // When the create fails because a CLI is missing, this holds the tool's
  // name so we can offer an "Install <tool>" button.
  const [missingTool, setMissingTool] = useState<InstallableTool | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    window.opendev.projects.list().then((ts) => {
      setTemplates(ts);
      if (ts.length > 0) {
        setLanguage(ts[0].language);
        setTemplateId(ts[0].id);
      }
    }).catch((err) => {
      showToast(`Couldn't load project templates: ${(err as Error).message}`, 5000);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Always subscribe to log lines while creating; phase-changes detach them
  // automatically when the modal closes.
  useEffect(() => {
    const off = window.opendev.projects.onLog((line) => setLog((s) => s + line));
    return off;
  }, []);
  // Tool-install logs share the same log area so the user sees a continuous
  // story (install brew package → retry create).
  useEffect(() => {
    const off = window.opendev.tools.onInstallLog((chunk) => setLog((s) => s + chunk));
    return off;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const languages = useMemo(() => {
    const seen: string[] = [];
    for (const t of templates) if (!seen.includes(t.language)) seen.push(t.language);
    return seen;
  }, [templates]);
  const inLang = useMemo(() => templates.filter((t) => t.language === language), [templates, language]);
  const selected = templates.find((t) => t.id === templateId);

  // Keep templateId valid as language changes.
  useEffect(() => {
    if (!selected || selected.language !== language) {
      const first = inLang[0];
      if (first) setTemplateId(first.id);
    }
  }, [language, inLang, selected]);

  const pickDir = async () => {
    const r = await window.opendev.projects.pickDir();
    if (r) setDest(r);
  };

  const create = async () => {
    if (!templateId) return;
    if (!name.trim()) { showToast('Enter a project name.', 2000); return; }
    if (!dest) { showToast('Pick a destination folder.', 2000); return; }
    setPhase('creating');
    setLog('');
    setErrorMsg(undefined);
    setMissingTool(null);
    try {
      const r = await window.opendev.projects.create({ templateId, projectName: name.trim(), destinationDir: dest });
      if (r.ok) {
        setCreatedPath(r.projectPath);
        // WebStorm-style flow: open the new project as the workspace
        // immediately on success — no extra click. The install log is
        // still visible during the 'creating' phase, so the user has
        // already seen what happened.
        if (r.projectPath) {
          try { await window.opendev.workspace.open(r.projectPath); } catch {}
        }
        onClose();
      } else {
        setErrorMsg(r.error || 'Unknown error');
        if (r.errorCode === 'MISSING_TOOL' && r.missingTool && INSTALLABLE.has(r.missingTool as InstallableTool)) {
          setMissingTool(r.missingTool as InstallableTool);
        }
        setPhase('error');
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
      setPhase('error');
    }
  };

  // Install a missing tool via brew (or npm for tsx), then re-trigger the
  // create. Logs stream into the same panel so the user sees one continuous
  // flow: install → retry.
  const installAndRetry = async (tool: InstallableTool) => {
    setPhase('installing');
    setLog((s) => s + `\n\n=== Installing ${tool} ===\n`);
    try {
      const r = await window.opendev.tools.install(tool);
      if (!r.ok) {
        setErrorMsg(`Install of ${tool} failed: ${r.error || 'unknown error'}`);
        setPhase('error');
        return;
      }
      setLog((s) => s + `\n=== ${tool} installed — retrying project create ===\n`);
      setMissingTool(null);
      // Retry create with the same form values.
      await create();
    } catch (err) {
      setErrorMsg(`Install of ${tool} failed: ${(err as Error).message}`);
      setPhase('error');
    }
  };

  const openCreated = async () => {
    if (!createdPath) return;
    await window.opendev.workspace.open(createdPath);
    onClose();
  };

  const canClose = phase !== 'creating' && phase !== 'installing';

  return (
    <div className="modal-overlay" onClick={() => canClose && onClose()}>
      <div className="modal new-project-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">New Project</span>
          {canClose && <button className="modal-x" onClick={onClose}>✕</button>}
        </div>

        {(phase === 'form' || phase === 'error') && (
          <div className="np-form">
            <div className="np-row">
              <label>Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {languages.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="np-row">
              <label>Framework</label>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {inLang.map((t) => <option key={t.id} value={t.id}>{t.framework}</option>)}
              </select>
            </div>
            {selected && (
              <div className="np-desc">
                <div>{selected.description}</div>
                {selected.requires && <div className="np-req">{selected.requires}</div>}
                {selected.postCreate && <div className="np-hint">{selected.postCreate}</div>}
              </div>
            )}
            <div className="np-row">
              <label>Project name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-app"
                autoFocus
              />
            </div>
            <div className="np-row">
              <label>Destination</label>
              <div className="np-dest">
                <input value={dest} readOnly placeholder="Pick a folder…" />
                <button onClick={pickDir}>Choose…</button>
              </div>
            </div>
            {phase === 'error' && errorMsg && (
              <div className="np-error">
                {errorMsg}
                {missingTool && (
                  <div className="np-error-hint">
                    OpenDev IDE can install <code>{missingTool}</code> for you via Homebrew.
                  </div>
                )}
              </div>
            )}
            {log && phase === 'error' && (
              <pre ref={logRef} className="np-log">{log}</pre>
            )}
            <div className="np-actions">
              <button onClick={onClose}>Cancel</button>
              {missingTool && (
                <button className="primary" onClick={() => installAndRetry(missingTool)}>
                  Install {missingTool} & retry
                </button>
              )}
              <button className={missingTool ? '' : 'primary'} onClick={create} disabled={!templateId || !name.trim() || !dest}>
                {missingTool ? 'Retry' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {phase === 'creating' && (
          <div className="np-creating">
            <div className="np-status">Creating <strong>{name}</strong>… This may take a minute on first run while dependencies download.</div>
            <pre ref={logRef} className="np-log">{log || 'Starting…'}</pre>
          </div>
        )}

        {phase === 'installing' && (
          <div className="np-creating">
            <div className="np-status">
              Installing <strong>{missingTool}</strong> via Homebrew… This typically takes a few minutes (the .NET SDK is ~500MB).
            </div>
            <pre ref={logRef} className="np-log">{log || 'Starting…'}</pre>
            <div className="np-actions">
              <button onClick={async () => {
                await window.opendev.tools.cancelInstall();
                // The install promise resolves with ok:false, which flips to 'error'.
              }}>Cancel install</button>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="np-done">
            <div className="np-success">✓ Project created at <code>{createdPath}</code></div>
            <pre ref={logRef} className="np-log">{log}</pre>
            <div className="np-actions">
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={openCreated}>Open Project</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
