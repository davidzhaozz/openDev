import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { rgPath } from './ripgrep.js';
import fuzzysort from 'fuzzysort';
import { IPC } from '@shared/ipc';
import type { GrepHit } from '@shared/types';
import { workspace } from './workspace.js';
import { walkAllFiles } from './fs.js';
import { safeSend } from './safeSend.js';
import { isWithin, toPosix } from '@shared/paths';

/**
 * One indexed file: where it really is, and what the user types to find it.
 *
 * The fuzzy match runs on `rel` — the workspace-relative POSIX path — never on
 * the absolute native one. On Windows the absolute path is backslash-separated,
 * so a perfectly correct query like `apps/main-portal/src/foo.ts` matched
 * nothing at all: fuzzysort needs every query character to appear in order, and
 * `/` never appears in `C:\Users\…\apps\main-portal\…`. Relative also keeps the
 * root prefix out of the scoring, so typing "repo" doesn't rank every file.
 */
type IndexedFile = { abs: string; rel: string };

let fileIndex: { root: string; files: IndexedFile[]; builtAt: number } | null = null;
let indexing: Promise<void> | null = null;
const STALE_MS = 30_000;

async function ensureIndex() {
  const root = workspace.getRoot();
  if (!root) return;
  const fresh = fileIndex && fileIndex.root === root && (Date.now() - fileIndex.builtAt) < STALE_MS;
  if (fresh) return;
  if (indexing) return indexing;
  indexing = (async () => {
    const abs = await walkAllFiles(root);
    const files = abs.map((p) => ({ abs: p, rel: relativePosix(p, root) }));
    fileIndex = { root, files, builtAt: Date.now() };
    indexing = null;
  })();
  return indexing;
}

/** Workspace-relative, forward-slash. Falls back to the full path if outside. */
export function relativePosix(abs: string, root: string): string {
  return isWithin(abs, root) && abs.length > root.length
    ? toPosix(abs.slice(root.length + 1))
    : toPosix(abs);
}

export function invalidateFileIndex() {
  fileIndex = null;
}

let activeGrep: ReturnType<typeof spawn> | null = null;

// Cap on hits streamed to the renderer for one search.
const MAX_GREP_HITS = 2000;

export function registerSearchIpc() {
  ipcMain.handle(IPC.SearchFuzzy, async (_e, query: string, limit = 40) => {
    await ensureIndex();
    if (!fileIndex) return [];
    if (!query.trim()) {
      return fileIndex.files.slice(0, limit).map(f => ({ path: f.abs, score: 0, relative: f.rel }));
    }
    // Accept either separator: someone on Windows may well paste a path with
    // backslashes, and the indexed side is POSIX.
    const q = toPosix(query.trim());
    const results = fuzzysort.go(q, fileIndex.files, {
      key: 'rel',
      limit,
      threshold: -10000
    });
    return results.map(r => ({
      path: r.obj.abs,
      score: r.score,
      relative: r.obj.rel
    }));
  });

  ipcMain.handle(IPC.SearchGrep, async (
    _e,
    query: string,
    opts: {
      glob?: string;
      caseSensitive?: boolean;
      /** Restrict the search to this folder. Defaults to the whole workspace. */
      dir?: string;
      /** Treat the query as a regex. Off means a literal string match. */
      regex?: boolean;
      wholeWord?: boolean;
      /** Echoed back on every hit so the renderer can drop a stale stream. */
      token?: string;
    }
  ) => {
    const root = workspace.getRoot();
    if (!root || !query) return false;
    // A folder-scoped search still has to stay inside the workspace — the
    // renderer picks the folder, so it is untrusted input like any other.
    let dir = root;
    if (opts?.dir) {
      if (!isWithin(opts.dir, root)) throw new Error(`Search folder outside workspace: ${opts.dir}`);
      dir = opts.dir;
    }
    if (activeGrep) { activeGrep.kill(); activeGrep = null; }
    const args = ['--json', '--max-count', '200'];
    if (!opts?.caseSensitive) args.push('-i');
    // Literal by default: people search for `foo(bar)` and `a.b`, and those
    // are either regex errors or wrong matches when read as patterns.
    if (!opts?.regex) args.push('--fixed-strings');
    if (opts?.wholeWord) args.push('--word-regexp');
    if (opts?.glob) args.push('-g', opts.glob);
    // Naming the directory explicitly makes ripgrep report absolute paths.
    // With only a cwd it reports paths relative to it, and those are
    // rejected by fs.read's inside-the-workspace check when a hit is opened.
    args.push('--', query, dir);

    const proc = spawn(rgPath, args, { cwd: dir });
    activeGrep = proc;
    let buf = '';
    let sent = 0;
    let stopped = false;
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stopped) { buf = ''; return; }
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
            const hit: GrepHit = { token: opts?.token, path, line: lineNo, col, preview: text.replace(/\r?\n$/, '') };
            safeSend(IPC.SearchGrepHit, hit);
            // A three-character query across a monorepo can produce tens of
            // thousands of hits; nobody scrolls that far, and shipping them
            // all across IPC locks up the renderer.
            if (++sent >= MAX_GREP_HITS) { stopped = true; buf = ''; proc.kill(); return; }
          }
        } catch { /* ignore */ }
      }
    });
    // ripgrep exits 1 for "no matches" and 2 for a real problem — a malformed
    // regex or a bad glob. Without this the UI would just say "0 matches".
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    // A spawn failure — a missing or unrunnable rg — arrives as an 'error'
    // event, never as an exit code. With no listener Node re-throws it and the
    // main process's uncaughtException handler turns a failed search into a
    // modal dialog; reported here it lands on the search panel error line.
    let spawnFailure = '';
    proc.on('error', (err: Error) => { spawnFailure = `ripgrep failed to start: ${err.message}`; });
    proc.on('close', (code) => {
      activeGrep = null;
      safeSend(IPC.SearchGrepDone, {
        token: opts?.token,
        count: sent,
        truncated: stopped,
        error: spawnFailure || (code === 2 && stderr.trim() ? stderr.trim().split('\n').slice(0, 4).join('\n') : undefined)
      });
    });
    return true;
  });
}
