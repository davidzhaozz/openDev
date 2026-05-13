import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join, basename, dirname, resolve, relative } from 'path';
import { IPC } from '@shared/ipc';
import type { FileNode } from '@shared/types';
import { workspace, safeWithinRoot } from './workspace.js';
import { invalidateFileIndex } from './search.js';
import { LIMITS } from './limits.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.turbo', '.vite']);

async function gitInfoForDir(absPath: string): Promise<FileNode['gitInfo'] | undefined> {
  const gitPath = join(absPath, '.git');
  let isRepo = false;
  try {
    const st = await fs.stat(gitPath);
    if (st.isDirectory()) isRepo = true;
    else if (st.isFile()) {
      // git worktree marker file
      const txt = await fs.readFile(gitPath, 'utf8');
      if (txt.startsWith('gitdir:')) isRepo = true;
    }
  } catch {
    return undefined;
  }
  if (!isRepo) return undefined;

  let repoName: string | undefined;
  let branch: string | undefined;
  try {
    const cfg = await fs.readFile(join(absPath, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote\s+"origin"\][^[]*?url\s*=\s*([^\n\r]+)/);
    if (m) {
      const url = m[1].trim();
      const tail = url.split(/[/:]/).pop() || '';
      repoName = tail.replace(/\.git$/, '');
    }
  } catch {}
  try {
    const head = await fs.readFile(join(absPath, '.git', 'HEAD'), 'utf8');
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/m);
    if (m) branch = m[1].trim();
    else branch = head.trim().slice(0, 7); // detached HEAD short sha
  } catch {}
  return (repoName || branch) ? { repoName, branch } : { repoName: undefined, branch: undefined };
}

export async function listDir(dir: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirEntries: import('fs').Dirent[] = [];
  const fileEntries: import('fs').Dirent[] = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    (e.isDirectory() ? dirEntries : fileEntries).push(e);
  }
  // Resolve git info for each subdir in parallel.
  const dirNodes = await Promise.all(dirEntries.map(async (e) => {
    const path = join(dir, e.name);
    const gitInfo = await gitInfoForDir(path);
    return { name: e.name, path, isDir: true, gitInfo } satisfies FileNode;
  }));
  const fileNodes: FileNode[] = fileEntries.map(e => ({ name: e.name, path: join(dir, e.name), isDir: false }));
  const nodes = [...dirNodes, ...fileNodes];
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export async function readFileSafe(path: string): Promise<string> {
  if (!safeWithinRoot(path)) throw new Error(`Path outside workspace: ${path}`);
  // Refuse oversized files: Monaco struggles past a few MB and pushing
  // hundreds of MB across IPC has frozen the renderer in the past.
  const st = await fs.stat(path);
  if (st.size > LIMITS.fileReadBytes) {
    const mb = (st.size / (1024 * 1024)).toFixed(1);
    const capMb = (LIMITS.fileReadBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`File too large to open (${mb} MB; cap is ${capMb} MB): ${path}`);
  }
  return fs.readFile(path, 'utf8');
}

export async function writeFileSafe(path: string, content: string): Promise<void> {
  if (!safeWithinRoot(path)) throw new Error(`Path outside workspace: ${path}`);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
}

export async function walkAllFiles(root: string, max = 50_000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= max) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        out.push(full);
        if (out.length >= max) return;
      }
    }
  }
  await walk(root);
  return out;
}

export function registerFsIpc() {
  ipcMain.handle(IPC.FsList, async (_e, dir: string) => {
    const target = dir || workspace.getRoot();
    if (!target) return [];
    return listDir(target);
  });

  ipcMain.handle(IPC.FsRead, async (_e, path: string) => readFileSafe(path));

  ipcMain.handle(IPC.FsWrite, async (_e, path: string, content: string) => {
    await writeFileSafe(path, content);
    return true;
  });

  ipcMain.handle(IPC.FsRename, async (_e, from: string, to: string) => {
    if (!safeWithinRoot(from) || !safeWithinRoot(to)) throw new Error('Path outside workspace');
    await fs.rename(from, to);
    invalidateFileIndex();
    return true;
  });

  ipcMain.handle(IPC.FsDelete, async (_e, path: string) => {
    if (!safeWithinRoot(path)) throw new Error('Path outside workspace');
    await fs.rm(path, { recursive: true, force: true });
    invalidateFileIndex();
    return true;
  });

  ipcMain.handle(IPC.FsCreate, async (_e, path: string, isDir: boolean) => {
    if (!safeWithinRoot(path)) throw new Error('Path outside workspace');
    if (isDir) {
      await fs.mkdir(path, { recursive: true });
    } else {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, '', { flag: 'wx' });
    }
    invalidateFileIndex();
    return true;
  });

  ipcMain.handle(IPC.FsWatch, (_e, path: string) => {
    if (!safeWithinRoot(path)) return false;
    workspace.watchDir(path);
    return true;
  });
  ipcMain.handle(IPC.FsUnwatch, (_e, path: string) => {
    workspace.unwatchDir(path);
    return true;
  });
}

export function workspaceRelative(p: string): string {
  const root = workspace.getRoot();
  if (!root) return p;
  return relative(root, p) || basename(p);
}

export function resolveInRoot(p: string): string {
  const root = workspace.getRoot();
  if (!root) return p;
  return resolve(root, p);
}
