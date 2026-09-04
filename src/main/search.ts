import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import fuzzysort from 'fuzzysort';
import { IPC } from '@shared/ipc';
import type { GrepHit } from '@shared/types';
import { workspace } from './workspace.js';
import { walkAllFiles } from './fs.js';
import { safeSend } from './safeSend.js';
import { isWithin, toPosix } from '@shared/paths';

let fileIndex: { root: string; files: string[]; builtAt: number } | null = null;
let indexing: Promise<void> | null = null;
const STALE_MS = 30_000;

async function ensureIndex() {
  const root = workspace.getRoot();
  if (!root) return;
  const fresh = fileIndex && fileIndex.root === root && (Date.now() - fileIndex.builtAt) < STALE_MS;
  if (fresh) return;
  if (indexing) return indexing;
  indexing = (async () => {
    const files = await walkAllFiles(root);
    fileIndex = { root, files, builtAt: Date.now() };
    indexing = null;
  })();
  return indexing;
}

export function invalidateFileIndex() {
  fileIndex = null;
}

let activeGrep: ReturnType<typeof spawn> | null = null;

export function registerSearchIpc() {
  ipcMain.handle(IPC.SearchFuzzy, async (_e, query: string, limit = 40) => {
    await ensureIndex();
    if (!fileIndex) return [];
    if (!query) return fileIndex.files.slice(0, limit).map(path => ({ path, score: 0 }));
    const root = fileIndex.root;
    const results = fuzzysort.go(query, fileIndex.files, {
      limit,
      threshold: -10000
    });
    return results.map(r => ({
      path: r.target,
      score: r.score,
      relative: isWithin(r.target, root) && r.target.length > root.length ? toPosix(r.target.slice(root.length + 1)) : r.target
    }));
  });

  ipcMain.handle(IPC.SearchGrep, async (_e, query: string, opts: { glob?: string; caseSensitive?: boolean }) => {
    const root = workspace.getRoot();
    if (!root || !query) return false;
    if (activeGrep) { activeGrep.kill(); activeGrep = null; }
    const args = ['--json', '--max-count', '200'];
    if (!opts?.caseSensitive) args.push('-i');
    if (opts?.glob) args.push('-g', opts.glob);
    args.push('--', query);

    const proc = spawn(rgPath, args, { cwd: root });
    activeGrep = proc;
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.type === 'match') {
            const path = j.data.path?.text ?? j.data.path?.bytes;
            const lineNo = j.data.line_number;
            const text = j.data.lines?.text ?? '';
            const submatch = j.data.submatches?.[0];
            const col = submatch ? submatch.start : 0;
            const hit: GrepHit = { path, line: lineNo, col, preview: text.replace(/\n$/, '') };
            safeSend(IPC.SearchGrepHit, hit);
          }
        } catch { /* ignore */ }
      }
    });
    proc.on('close', () => {
      activeGrep = null;
      safeSend(IPC.SearchGrepDone);
    });
    return true;
  });
}
