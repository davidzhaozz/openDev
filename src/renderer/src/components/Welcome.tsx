import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { AppSettings } from '../../../shared/types';

type Props = {
  onOpen: (path: string) => Promise<void> | void;
  onPick: () => Promise<void> | void;
};

export function Welcome({ onOpen, onPick }: Props) {
  const setModal = useStore((s) => s.setModal);
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
            OpenDev IDE
            <span className="welcome-version">v{window.opendev.app.version()}</span>
          </div>
          <div className="welcome-sub">Choose a project to get started</div>
        </div>

        <div className="welcome-actions">
          <button className="primary" onClick={() => onPick()}>Open Project…</button>
          <button onClick={async () => {
            // Folder picker first, then the form modal — matches the user's
            // mental model of "where do I want this saved?" being the first
            // question. Cancelling the picker just bails silently.
            const dest = await window.opendev.projects.pickDir();
            if (!dest) return;
            setModal('new-project', { dest });
          }}>New Project…</button>
        </div>

        <div className="welcome-section-label">Recent</div>
        <div className="welcome-recents">
          {recents.length === 0 && <div className="welcome-empty">Nothing here yet — open a folder above.</div>}
          {recents.map(p => (
            <div key={p} className="welcome-recent" onClick={() => onOpen(p)}>
              <div className="welcome-recent-text">
                <span className="welcome-name">{p.split('/').filter(Boolean).pop() || p}</span>
                <span className="welcome-path">{shortPath(p)}</span>
              </div>
              <button
                className="welcome-recent-x"
                title="Remove from recents (doesn't touch the folder on disk)"
                onClick={async (e) => {
                  e.stopPropagation();
                  const next = recents.filter((x) => x !== p);
                  setRecents(next);
                  await window.opendev.settings.set({ recentWorkspaces: next });
                }}
              >✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
