import { useEffect, useState } from 'react';
import { CodeEditor } from './components/Editor';
import { Settings, applyAppearanceSettings } from './components/Settings';
import './styles/global.css';
import { baseName, dirName } from '@shared/paths';
import { WindowControls, usesFramelessChrome } from './components/WindowControls';
import { modKey } from './platformUi';

export function Popout({ path }: { path: string }) {
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState<string | undefined>();
  const modified = dirty !== undefined && dirty !== content;

  useEffect(() => {
    window.opendev.settings.get().then(applyAppearanceSettings);
    window.opendev.fs.read(path).then(setContent).catch(() => setContent(''));
    document.title = baseName(path) || 'Popout';
  }, [path]);

  const save = async () => {
    if (dirty === undefined) return;
    await window.opendev.fs.write(path, dirty);
    setContent(dirty);
    setDirty(undefined);
  };

  return (
    <div className="app" style={{ gridTemplateRows: '32px 1fr', height: '100vh' }}>
      <div className="titlebar">
        <span className="title">{baseName(path)}</span>
        <span className="path">{dirName(path)}</span>
        {modified && <span style={{ color: 'var(--accent-hi)', marginLeft: 6 }}>●</span>}
        <div className="actions">
          <button onClick={save} disabled={!modified}>Save ({modKey()}S)</button>
        </div>
        {usesFramelessChrome() && <WindowControls />}
      </div>
      <div style={{ background: 'var(--bg-0)', height: '100%', minHeight: 0 }}>
        <CodeEditor
          path={path}
          value={dirty ?? content}
          onChange={setDirty}
          onSave={save}
        />
      </div>
    </div>
  );
}
