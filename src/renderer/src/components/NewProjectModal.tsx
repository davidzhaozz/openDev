import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import type { ProjectTemplate } from '../../../shared/types';

// Single-step new-project wizard: language → framework → name + destination,
// then Create. CLI-based templates and post-install steps stream live log
// output into a console area so the user sees what's happening.

type Phase = 'form' | 'creating' | 'done' | 'error';

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [language, setLanguage] = useState<string>('');
  const [templateId, setTemplateId] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [dest, setDest] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('form');
  const [log, setLog] = useState<string>('');
  const [createdPath, setCreatedPath] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    window.opendev.projects.list().then((ts) => {
      setTemplates(ts);
      if (ts.length > 0) {
        setLanguage(ts[0].language);
        setTemplateId(ts[0].id);
      }
    });
  }, []);

  // Always subscribe to log lines while creating; phase-changes detach them
  // automatically when the modal closes.
  useEffect(() => {
    const off = window.opendev.projects.onLog((line) => setLog((s) => s + line));
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
    try {
      const r = await window.opendev.projects.create({ templateId, projectName: name.trim(), destinationDir: dest });
      if (r.ok) {
        setCreatedPath(r.projectPath);
        setPhase('done');
      } else {
        setErrorMsg(r.error || 'Unknown error');
        setPhase('error');
      }
    } catch (err) {
      setErrorMsg((err as Error).message);
      setPhase('error');
    }
  };

  const openCreated = async () => {
    if (!createdPath) return;
    await window.opendev.workspace.open(createdPath);
    onClose();
  };

  const canClose = phase !== 'creating';

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
              <div className="np-error">{errorMsg}</div>
            )}
            {log && phase === 'error' && (
              <pre ref={logRef} className="np-log">{log}</pre>
            )}
            <div className="np-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={create} disabled={!templateId || !name.trim() || !dest}>
                Create
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
