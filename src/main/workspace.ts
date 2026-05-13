import { type FSWatcher, watch } from 'fs';
import { join } from 'path';
import { loadSettings, patchSettings } from './storage.js';
import { safeSend } from './safeSend.js';
import { IPC } from '@shared/ipc';
import type { FileChange } from '@shared/types';

class Workspace {
  private root: string | undefined;
  private watchers = new Map<string, FSWatcher>();

  getRoot(): string | undefined {
    return this.root;
  }

  async restoreLast() {
    const s = await loadSettings();
    if (s.workspaceRoot) {
      try {
        await this.open(s.workspaceRoot, false);
      } catch (err) {
        console.error('Failed to restore workspace', err);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.root) return;
    await this.stopWatchers();
    this.root = undefined;
    await patchSettings({ workspaceRoot: undefined });
    safeSend(IPC.WorkspaceChanged, undefined);
  }

  async open(path: string, persist = true): Promise<void> {
    if (this.root === path) return;
    await this.stopWatchers();
    this.root = path;
    if (persist) {
      const s = await loadSettings();
      const recent = [path, ...s.recentWorkspaces.filter(p => p !== path)].slice(0, 10);
      await patchSettings({ workspaceRoot: path, recentWorkspaces: recent });
    }
    // Watch only the workspace root, non-recursive. The previous chokidar v4
    // setup ate ~one fd per watched file and blew past the macOS soft limit
    // (~256 fds for a Finder-launched .app) on real-world workspaces, causing
    // EMFILE crashes a few seconds in. We instead use a shallow fs.watch and
    // ask the renderer to refresh expanded directories on demand.
    this.watchDir(path);
    safeSend(IPC.WorkspaceChanged, path);
  }

  watchDir(dir: string): void {
    if (this.watchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: true, recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const full = join(dir, filename.toString());
        const type: FileChange['type'] = eventType === 'rename' ? 'add' : 'change';
        // Notify all listeners (file tree + fuzzy index).
        safeSend(IPC.FsWatchEvent, { type, path: full } satisfies FileChange);
        // Also invalidate the fuzzy finder's cached file list since any
        // rename/create/delete event affects what's findable.
        import('./search.js').then(s => s.invalidateFileIndex()).catch(() => {});
      });
      w.on('error', () => this.watchers.delete(dir));
      this.watchers.set(dir, w);
    } catch (err) {
      console.warn(`[watch] failed to watch ${dir}:`, (err as Error).message);
    }
  }

  unwatchDir(dir: string): void {
    const w = this.watchers.get(dir);
    if (w) { try { w.close(); } catch {} this.watchers.delete(dir); }
  }

  async stopWatchers(): Promise<void> {
    for (const [, w] of this.watchers) { try { w.close(); } catch {} }
    this.watchers.clear();
  }
}

export const workspace = new Workspace();
export const requireRoot = (): string => {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return root;
};

export function safeWithinRoot(p: string): boolean {
  const root = workspace.getRoot();
  if (!root) return false;
  const norm = join(p);
  return norm === root || norm.startsWith(root + '/');
}
