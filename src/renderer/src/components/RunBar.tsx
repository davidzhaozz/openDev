import { useEffect, useRef, useState } from 'react';
import type { PythonRunConfig } from '../../../shared/types';
import { useStore } from '../state/store';

// PyCharm-style run toolbar. Drop-down of saved configs + ▶ Run + ⏸ Stop
// + ⚙ Edit Configurations. Always rendered; if there are no configs yet,
// the dropdown shows "(no run configs)" and Edit Configurations is the
// path to create one. The Run button auto-opens the bottom Run panel.

export function RunBar({ activeFilePath }: { activeFilePath?: string }) {
  const [configs, setConfigs] = useState<PythonRunConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const setBottomTab = useStore((s) => s.setBottomTab);
  const bottomCollapsed = useStore((s) => s.bottomCollapsed);
  const toggleBottom = useStore((s) => s.toggleBottom);
  const showToast = useStore((s) => s.showToast);

  const refresh = async () => {
    const list = await window.opendev.runs.listConfigs();
    setConfigs(list);
    setSelectedId((cur) => cur && list.some((c) => c.id === cur) ? cur : list[0]?.id);
  };

  useEffect(() => {
    refresh();
    const off = window.opendev.runs.onChanged(refresh);
    return off;
  }, []);

  useEffect(() => {
    const off = window.opendev.runs.onStatus((s) => {
      if (s.id !== activeSessionId) return;
      if (s.status === 'stopped' || s.status === 'error') setRunning(false);
    });
    return off;
  }, [activeSessionId]);

  const showRun = () => {
    setBottomTab('run');
    if (bottomCollapsed) toggleBottom();
  };

  const startSelected = async () => {
    if (!selectedId) { showToast('Pick a run config first', 3000); return; }
    showRun();
    try {
      const s = await window.opendev.runs.start(selectedId);
      setActiveSessionId(s.id);
      setRunning(true);
    } catch (e: any) {
      showToast(`Run failed: ${e?.message || e}`, 5000);
    }
  };

  const stopActive = async () => {
    if (!activeSessionId) return;
    try { await window.opendev.runs.stop(activeSessionId); }
    catch (e: any) { showToast(`Stop failed: ${e?.message || e}`, 4000); }
  };

  // Ephemeral "Run current file" — bypasses the saved-config list so the
  // dropdown doesn't fill up with one-off entries.
  const runCurrentFile = async () => {
    if (!activeFilePath || !/\.pyi?$/i.test(activeFilePath)) {
      showToast('Open a .py file first', 3000);
      return;
    }
    showRun();
    const name = `▶ ${activeFilePath.split('/').pop()}`;
    try {
      const s = await window.opendev.runs.startAdHoc({
        name, mode: 'script', target: activeFilePath, args: [], cwd: '.', env: {}
      });
      setActiveSessionId(s.id);
      setRunning(true);
    } catch (e: any) {
      showToast(`Run failed: ${e?.message || e}`, 5000);
    }
  };

  const openEditor = (id?: string) => { setEditingId(id); setEditorOpen(true); };

  const isPyFile = !!activeFilePath && /\.pyi?$/i.test(activeFilePath);
  // Hide the bar entirely when it has nothing to offer — non-Python file
  // open, no saved configs, and no run currently active. Without this the
  // "(no run configs)" placeholder shows above every editor tab (AI chat,
  // browser, DB workspace, etc.) which is just noise. Once the user adds a
  // config, the bar becomes globally visible so they can run from any tab.
  const irrelevant = !isPyFile && configs.length === 0 && !running;
  if (irrelevant) return null;

  return (
    <div className="run-bar">
      <select
        className="run-select"
        value={selectedId || ''}
        onChange={(e) => setSelectedId(e.target.value || undefined)}
        title="Run configuration"
      >
        {configs.length === 0 ? <option value="">(no run configs)</option> : null}
        {configs.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {running
        ? <button className="run-btn stop" onClick={stopActive} title="Stop the active run">■</button>
        : <button className="run-btn play" onClick={startSelected} disabled={!selectedId} title="Run selected config">▶</button>}
      {isPyFile && !running && (
        <button className="run-btn file" onClick={runCurrentFile} title={`Run ${activeFilePath?.split('/').pop()}`}>▶ this file</button>
      )}
      <button className="run-btn edit" onClick={() => openEditor()} title="Edit run configurations">⚙</button>
      {editorOpen && (
        <RunConfigsEditor
          configs={configs}
          initialId={editingId}
          onClose={() => setEditorOpen(false)}
          onSelectAfterSave={(id) => setSelectedId(id)}
        />
      )}
    </div>
  );
}

function RunConfigsEditor({
  configs, initialId, onClose, onSelectAfterSave
}: {
  configs: PythonRunConfig[];
  initialId?: string;
  onClose: () => void;
  onSelectAfterSave: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId || configs[0]?.id);
  const [draft, setDraft] = useState<PythonRunConfig | null>(null);
  const showToast = useStore((s) => s.showToast);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedId) {
      const cfg = configs.find((c) => c.id === selectedId);
      if (cfg) setDraft({ ...cfg, args: [...cfg.args], env: { ...cfg.env } });
    } else {
      setDraft(null);
    }
  }, [selectedId, configs]);

  const newConfig = () => {
    setSelectedId(undefined);
    setDraft({
      id: '', name: 'New config', mode: 'script', target: '', args: [], cwd: '.', env: {}
    });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { showToast('Name is required', 3000); return; }
    if (!draft.target.trim()) { showToast(draft.mode === 'module' ? 'Module is required' : 'Script path is required', 3000); return; }
    try {
      const saved = await window.opendev.runs.saveConfig(draft);
      onSelectAfterSave(saved.id);
      setSelectedId(saved.id);
      showToast(`Saved "${saved.name}"`, 2000);
    } catch (e: any) {
      showToast(`Save failed: ${e?.message || e}`, 5000);
    }
  };

  const remove = async () => {
    if (!draft || !draft.id) return;
    if (!confirm(`Delete run config "${draft.name}"?`)) return;
    try {
      await window.opendev.runs.deleteConfig(draft.id);
      setSelectedId(undefined);
      setDraft(null);
    } catch (e: any) {
      showToast(`Delete failed: ${e?.message || e}`, 5000);
    }
  };

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className="modal run-config-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="run-config-head">
          <span>Run / Debug Configurations</span>
          <span className="grow" />
          <button onClick={onClose}>Close</button>
        </div>
        <div className="run-config-body">
          <div className="run-config-list">
            <div className="run-config-list-head">
              <span>Configurations</span>
              <span className="grow" />
              <button onClick={newConfig} title="Add new">＋</button>
            </div>
            {configs.length === 0 && !draft && (
              <div style={{ color: 'var(--fg-3)', padding: 10, fontSize: 11.5 }}>
                No configurations yet. Click ＋ to add one.
              </div>
            )}
            {configs.map((c) => (
              <div
                key={c.id}
                className={`run-config-row ${selectedId === c.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                {c.name}
              </div>
            ))}
            {draft && !draft.id && (
              <div className="run-config-row selected">{draft.name} *</div>
            )}
          </div>
          <div className="run-config-form">
            {!draft ? (
              <div style={{ color: 'var(--fg-3)', padding: 20 }}>Pick a configuration on the left, or click ＋ to add one.</div>
            ) : (
              <ConfigForm draft={draft} setDraft={setDraft} />
            )}
          </div>
        </div>
        {draft && (
          <div className="run-config-foot">
            <span className="grow" />
            {draft.id && <button onClick={remove}>Delete</button>}
            <button className="primary" onClick={save}>Save</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigForm({ draft, setDraft }: { draft: PythonRunConfig; setDraft: (d: PythonRunConfig) => void }) {
  const update = (patch: Partial<PythonRunConfig>) => setDraft({ ...draft, ...patch });
  const updateArgs = (text: string) => update({ args: text.split(/\s+/).filter(Boolean) });
  const updateEnv = (text: string) => {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    update({ env });
  };
  const envText = Object.entries(draft.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  return (
    <div className="run-config-fields">
      <label>Name</label>
      <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />

      <label>Type</label>
      <div className="run-config-radio">
        <label><input type="radio" checked={draft.mode === 'script'} onChange={() => update({ mode: 'script' })} /> Script</label>
        <label><input type="radio" checked={draft.mode === 'module'} onChange={() => update({ mode: 'module' })} /> Module (-m)</label>
      </div>

      <label>{draft.mode === 'module' ? 'Module' : 'Script path'}</label>
      <input
        value={draft.target}
        placeholder={draft.mode === 'module' ? 'mlx_lm.lora' : 'train.py'}
        onChange={(e) => update({ target: e.target.value })}
      />

      <label>Args</label>
      <input
        value={draft.args.join(' ')}
        placeholder="--config lora_config.yaml"
        onChange={(e) => updateArgs(e.target.value)}
      />

      <label>Working dir</label>
      <input value={draft.cwd || '.'} onChange={(e) => update({ cwd: e.target.value })} placeholder="." />

      <label>Interpreter</label>
      <input
        value={draft.interpreter || ''}
        placeholder="(use selected interpreter)"
        onChange={(e) => update({ interpreter: e.target.value || undefined })}
      />

      <label style={{ alignSelf: 'flex-start' }}>Env</label>
      <textarea
        rows={4}
        value={envText}
        placeholder={'KEY=value\nANOTHER=value'}
        onChange={(e) => updateEnv(e.target.value)}
      />
    </div>
  );
}
