// Server-side directory browsing for the web client's file picker.
//
// The desktop app answers workspace.pick() / projects.pickDir() with a native
// dialog.showOpenDialog. A browser can't see the server's filesystem, so the
// web client renders its own picker and walks the tree through these channels.
import { ipcMain } from './electron.js';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { loadSettings } from '../main/storage.js';

export type RemoteEntry = { name: string; path: string; isDir: boolean };
export type RemoteListing = {
  path: string;
  parent: string | null;
  entries: RemoteEntry[];
  home: string;
  shortcuts: Array<{ label: string; path: string }>;
  error?: string;
};

async function listing(target: string, filesToo: boolean): Promise<RemoteListing> {
  const home = homedir();
  const settings = await loadSettings().catch(() => ({ recentWorkspaces: [] as string[] }));
  const shortcuts = [
    { label: 'Home', path: home },
    { label: 'Desktop', path: join(home, 'Desktop') },
    { label: 'Documents', path: join(home, 'Documents') },
    ...(settings.recentWorkspaces || []).slice(0, 5).map((p) => ({ label: p.split('/').pop() || p, path: p }))
  ];
  const path = resolve(target || home);
  const parent = path === '/' ? null : dirname(path);
  try {
    const dirents = await fs.readdir(path, { withFileTypes: true });
    const entries: RemoteEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const isDir = d.isDirectory() || (d.isSymbolicLink() && await isDirLink(join(path, d.name)));
      if (!isDir && !filesToo) continue;
      entries.push({ name: d.name, path: join(path, d.name), isDir });
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { path, parent, entries, home, shortcuts };
  } catch (err: any) {
    return { path, parent, entries: [], home, shortcuts, error: err?.message || String(err) };
  }
}

async function isDirLink(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

export function registerRemoteFilesIpc(): void {
  ipcMain.handle('web:list-dir', (_e, path?: string, filesToo?: boolean) => listing(path || homedir(), !!filesToo));
  ipcMain.handle('web:home', () => homedir());
}
