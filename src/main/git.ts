import { ipcMain, app } from 'electron';
import { simpleGit, type SimpleGit } from 'simple-git';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { GitFileStatus, WorktreeInfo } from '@shared/types';
import { workspace, requireRoot } from './workspace.js';

let gitInstance: SimpleGit | null = null;
let gitRoot: string | undefined;

function git(): SimpleGit {
  const root = requireRoot();
  if (!gitInstance || gitRoot !== root) {
    gitInstance = simpleGit(root);
    gitRoot = root;
  }
  return gitInstance;
}

// Bundle the whole repo (all refs) into a single file we can ship to a peer
// over HTTP. Returns the bundle's absolute path in a temp dir; the caller
// is responsible for deleting it after sending.
export async function bundleRepo(root: string): Promise<string> {
  const out = join(tmpdir(), `opendev-bundle-${randomUUID()}.bundle`);
  await simpleGit(root).raw(['bundle', 'create', out, '--all']);
  return out;
}

// Clone (or update) a repo on the receiving peer from a bundle file. If the
// target already exists, fetch from the bundle and hard-reset to its HEAD so
// repeated pushes stay in sync; otherwise clone fresh.
export async function applyBundle(bundlePath: string, targetDir: string): Promise<void> {
  let exists = false;
  try { await fs.access(join(targetDir, '.git')); exists = true; } catch {}
  if (exists) {
    const g = simpleGit(targetDir);
    await g.raw(['fetch', bundlePath, '+refs/heads/*:refs/heads/*', '--force']);
    // Move the working tree to whatever the bundle's default branch HEAD is.
    const head = (await simpleGit(targetDir).raw(['rev-parse', 'HEAD'])).trim();
    await g.raw(['reset', '--hard', head]);
  } else {
    await fs.mkdir(targetDir, { recursive: true });
    await simpleGit().raw(['clone', bundlePath, targetDir]);
  }
}

// Where a peer stores repos pushed to it: <appData>/openDev/peer-repos/<name>.
export function peerRepoDir(workspaceName: string): string {
  const safe = workspaceName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo';
  return join(app.getPath('appData'), 'openDev', 'peer-repos', safe);
}

function mapStatus(idx: string, wt: string): GitFileStatus['status'] {
  if (idx === 'A' || wt === 'A') return 'added';
  if (idx === 'D' || wt === 'D') return 'deleted';
  if (idx === 'R' || wt === 'R') return 'renamed';
  if (idx === 'U' || wt === 'U') return 'conflicted';
  if (idx === '?' || wt === '?') return 'untracked';
  return 'modified';
}

async function status(): Promise<GitFileStatus[]> {
  try {
    const s = await git().status();
    const out: GitFileStatus[] = [];
    for (const f of s.files) {
      out.push({
        path: f.path,
        status: mapStatus(f.index, f.working_dir),
        staged: f.index !== ' ' && f.index !== '?'
      });
    }
    return out;
  } catch { return []; }
}

const worktreesFile = () => join(workspace.getRoot()!, '.opendev', 'worktrees.json');

async function readWorktrees(): Promise<WorktreeInfo[]> {
  try {
    const raw = await fs.readFile(worktreesFile(), 'utf8');
    return (JSON.parse(raw) as { items: WorktreeInfo[] }).items;
  } catch { return []; }
}
async function writeWorktrees(items: WorktreeInfo[]): Promise<void> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace');
  await fs.mkdir(join(root, '.opendev'), { recursive: true });
  await fs.writeFile(worktreesFile(), JSON.stringify({ items }, null, 2), 'utf8');
}

export function registerGitIpc() {
  ipcMain.handle(IPC.GitStatus, () => status());

  ipcMain.handle(IPC.GitDiff, async (_e, path?: string) => {
    try { return path ? await git().diff(['--', path]) : await git().diff(); }
    catch { return ''; }
  });

  ipcMain.handle(IPC.GitStage, async (_e, paths: string[]) => { await git().add(paths); return true; });
  ipcMain.handle(IPC.GitUnstage, async (_e, paths: string[]) => { await git().reset(['HEAD', '--', ...paths]); return true; });
  ipcMain.handle(IPC.GitCommit, async (_e, message: string) => { const r = await git().commit(message); return r.commit; });
  ipcMain.handle(IPC.GitPush, async () => { try { await git().push(); return true; } catch (e: any) { return { error: e.message }; } });
  ipcMain.handle(IPC.GitPull, async () => { try { await git().pull(); return true; } catch (e: any) { return { error: e.message }; } });

  ipcMain.handle(IPC.GitBranch, async () => {
    try { const r = await git().branch(); return r; } catch { return null; }
  });
  ipcMain.handle(IPC.GitCheckout, async (_e, branch: string) => { await git().checkout(branch); return true; });

  ipcMain.handle(IPC.GitBlame, async (_e, filePath: string) => {
    try {
      const dir = filePath.split('/').slice(0, -1).join('/');
      const file = filePath.split('/').pop()!;
      const g = simpleGit(dir);
      const raw = await g.raw(['blame', '--porcelain', '--', file]);
      type Entry = { hash: string; author?: string; authorTime?: number; summary?: string };
      const commits = new Map<string, Entry>();
      const lines: Array<{ line: number; hash: string; author?: string; date?: string; summary?: string }> = [];
      const text = raw.split('\n');
      let i = 0;
      while (i < text.length) {
        const line = text[i++];
        if (!line) continue;
        // Porcelain header: `<40-hex-sha> <orig-line> <final-line>[ <num-lines>]`
        // Real-world output sometimes has a leading caret (^sha) for boundary
        // commits and the sha may be shorter than 40 chars on certain configs;
        // accept any hex sha of at least 7 chars to be safe.
        const m = line.match(/^\^?([0-9a-f]{7,40})\s+\d+\s+(\d+)(?:\s+\d+)?\s*$/);
        if (!m) continue;
        const hash = m[1];
        const finalLine = Number(m[2]);
        let entry = commits.get(hash);
        if (!entry) entry = { hash };
        while (i < text.length && !text[i].startsWith('\t')) {
          const meta = text[i++];
          if (meta.startsWith('author ')) entry!.author = meta.slice(7);
          else if (meta.startsWith('author-time ')) entry!.authorTime = Number(meta.slice(12));
          else if (meta.startsWith('summary ')) entry!.summary = meta.slice(8);
        }
        i++; // skip the tab-prefixed content line
        commits.set(hash, entry!);
        const dateStr = entry!.authorTime
          ? new Date(entry!.authorTime * 1000).toISOString().slice(0, 10)
          : undefined;
        lines.push({ line: finalLine, hash, author: entry!.author, date: dateStr, summary: entry!.summary });
      }
      console.log(`[git blame] ${filePath} → parsed ${lines.length} lines from ${raw.length} bytes`);
      return { lines };
    } catch (e: any) {
      console.error(`[git blame] ${filePath} failed:`, e?.message || e);
      return { error: e?.message || String(e) };
    }
  });

  ipcMain.handle(IPC.GitFileLog, async (_e, filePath: string, limit = 100) => {
    try {
      const dir = filePath.split('/').slice(0, -1).join('/');
      const file = filePath.split('/').pop()!;
      const g = simpleGit(dir);
      const log = await g.log({ file, maxCount: limit, '--follow': null });
      return { commits: log.all };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  });

  ipcMain.handle(IPC.GitShow, async (_e, dir: string, hash: string) => {
    try {
      const g = simpleGit(dir);
      const diff = await g.show([hash, '--stat', '--patch']);
      return { diff };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  });

  ipcMain.handle(IPC.GitBranchesAt, async (_e, absPath: string) => {
    try {
      const g = simpleGit(absPath);
      const r = await g.branch(['-a']);
      return { current: r.current, all: r.all };
    } catch (err: any) {
      return { error: err?.message || String(err) };
    }
  });
  ipcMain.handle(IPC.GitCheckoutAt, async (_e, absPath: string, branch: string) => {
    try {
      const g = simpleGit(absPath);
      await g.checkout(branch);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  ipcMain.handle(IPC.GitLog, async (_e, limit = 50) => {
    try { return await git().log({ maxCount: limit }); } catch { return { all: [] }; }
  });

  ipcMain.handle(IPC.GitWorktreeCreate, async (_e, opts: { name?: string; branch?: string }) => {
    const root = workspace.getRoot()!;
    const id = randomUUID();
    const name = opts.name || `sandbox-${id.slice(0, 8)}`;
    const wtPath = join(root, '.opendev', 'worktrees', name);
    await fs.mkdir(join(root, '.opendev', 'worktrees'), { recursive: true });
    const branch = opts.branch || `opendev/${name}`;
    await git().raw(['worktree', 'add', '-b', branch, wtPath]);
    const items = await readWorktrees();
    const info: WorktreeInfo = { id, path: wtPath, branch, createdAt: Date.now() };
    items.push(info);
    await writeWorktrees(items);
    return info;
  });

  ipcMain.handle(IPC.GitWorktreeList, async () => readWorktrees());

  ipcMain.handle(IPC.GitWorktreeRemove, async (_e, id: string) => {
    const items = await readWorktrees();
    const wt = items.find(w => w.id === id);
    if (!wt) return false;
    try { await git().raw(['worktree', 'remove', '--force', wt.path]); } catch {}
    try { await git().raw(['branch', '-D', wt.branch]); } catch {}
    await writeWorktrees(items.filter(w => w.id !== id));
    return true;
  });

  ipcMain.handle(IPC.GitWorktreeMerge, async (_e, id: string) => {
    const items = await readWorktrees();
    const wt = items.find(w => w.id === id);
    if (!wt) return false;
    await git().raw(['merge', '--no-ff', wt.branch]);
    return true;
  });
}
