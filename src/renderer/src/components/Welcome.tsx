import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';

type Props = {
  onOpen: (path: string) => Promise<void> | void;
  onPick: () => Promise<void> | void;
};

export function Welcome({ onOpen, onPick }: Props) {
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    window.opendev.settings.get().then((s: AppSettings) => setRecents(s.recentWorkspaces || []));
  }, []);

  const shortPath = (p: string) => {
    const home = '/Users/';
    if (p.startsWith(home)) {
      const parts = p.split('/');
      return '~/' + parts.slice(3).join('/');
    }
    return p;
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-header">
          <div className="welcome-title">
            openDev
            <span className="welcome-version">v{window.opendev.app.version()}</span>
          </div>
          <div className="welcome-sub">Choose a project to get started</div>
        </div>

        <div className="welcome-actions">
          <button className="primary" onClick={() => onPick()}>Open Folder…</button>
        </div>

        <div className="welcome-section-label">Recent</div>
        <div className="welcome-recents">
          {recents.length === 0 && <div className="welcome-empty">Nothing here yet — open a folder above.</div>}
          {recents.map(p => (
            <div key={p} className="welcome-recent" onClick={() => onOpen(p)}>
              <span className="welcome-name">{p.split('/').filter(Boolean).pop() || p}</span>
              <span className="welcome-path">{shortPath(p)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
