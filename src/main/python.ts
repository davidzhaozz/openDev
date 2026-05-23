import { ipcMain } from 'electron';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { join, delimiter, basename, dirname } from 'path';
import { IPC } from '@shared/ipc';
import type { PythonInterpreter } from '@shared/types';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';

const pexec = promisify(exec);

// ---------------------------------------------------------------------------
// Interpreter detection
// ---------------------------------------------------------------------------
// PyCharm-style: scan the usual locations on macOS, run `python -V`, return
// one entry per distinct binary. The user picks one in the UI; that choice
// is persisted per-workspace and feeds:
//   - Pyright LSP (via initializationOptions.pythonPath)
//   - the auto-MLX service's command
//   - anywhere else we shell out to python

type CandidateKind = 'venv' | 'pyenv' | 'conda' | 'homebrew' | 'system' | 'path' | 'framework';

type Candidate = { path: string; kind: CandidateKind; label?: string };

function uniqByPath(items: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const it of items) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    out.push(it);
  }
  return out;
}

function addIfExists(out: Candidate[], path: string, kind: CandidateKind, label?: string): void {
  if (existsSync(path)) out.push({ path, kind, label });
}

async function listDirSafe(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}

async function gatherCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const home = homedir();
  const root = workspace.getRoot();

  // 1. Workspace .venv / venv — highest priority when present.
  if (root) {
    addIfExists(out, join(root, '.venv', 'bin', 'python'), 'venv', '.venv');
    addIfExists(out, join(root, '.venv', 'bin', 'python3'), 'venv', '.venv');
    addIfExists(out, join(root, 'venv', 'bin', 'python'), 'venv', 'venv');
    addIfExists(out, join(root, 'venv', 'bin', 'python3'), 'venv', 'venv');
    // Sibling venv at the workspace parent — common when the user opens a
    // sub-folder (e.g. `korena/training/`) of a repo whose venv lives at the
    // repo root.
    addIfExists(out, join(root, '..', '.venv', 'bin', 'python'), 'venv', '../.venv');
  }

  // 2. Homebrew on macOS (both arches).
  addIfExists(out, '/opt/homebrew/bin/python3', 'homebrew', 'Homebrew (arm64)');
  addIfExists(out, '/usr/local/bin/python3', 'homebrew', 'Homebrew (x86_64)');

  // 3. Apple's bundled Python.
  addIfExists(out, '/usr/bin/python3', 'system', 'System');

  // 4. python.org installer framework builds.
  for (const v of await listDirSafe('/Library/Frameworks/Python.framework/Versions')) {
    if (v === 'Current') continue;
    addIfExists(out, `/Library/Frameworks/Python.framework/Versions/${v}/bin/python3`, 'framework', `python.org ${v}`);
  }

  // 5. pyenv installed versions.
  const pyenvRoot = process.env.PYENV_ROOT || join(home, '.pyenv');
  for (const v of await listDirSafe(join(pyenvRoot, 'versions'))) {
    addIfExists(out, join(pyenvRoot, 'versions', v, 'bin', 'python'), 'pyenv', `pyenv:${v}`);
  }

  // 6. Conda / Miniforge envs.
  for (const condaRoot of [
    join(home, 'miniforge3'),
    join(home, 'anaconda3'),
    join(home, 'miniconda3'),
    join(home, 'mambaforge')
  ]) {
    addIfExists(out, join(condaRoot, 'bin', 'python'), 'conda', `${basename(condaRoot)}:base`);
    for (const env of await listDirSafe(join(condaRoot, 'envs'))) {
      addIfExists(out, join(condaRoot, 'envs', env, 'bin', 'python'), 'conda', `${basename(condaRoot)}:${env}`);
    }
  }

  // 7. PATH — pick up anything the user explicitly put on PATH that's not
  // already covered. Bare `python3` and `python` are the canonical names.
  for (const bin of ['python3', 'python']) {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, bin);
      if (existsSync(p)) out.push({ path: p, kind: 'path', label: `PATH (${dir})` });
    }
  }

  return uniqByPath(out);
}

async function probeVersion(interpreterPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await pexec(`'${interpreterPath.replace(/'/g, `'\\''`)}' -V`, { timeout: 3000 });
    // Old Python wrote to stderr; modern Python to stdout. Take whichever.
    const out = (stdout.trim() || stderr.trim()).replace(/^Python\s+/, '');
    return out || null;
  } catch {
    return null;
  }
}

// Top-level cache. Cheap to recompute (~100ms with 5–10 probes) but we
// avoid re-probing on every render — list() rebuilds when the workspace
// changes or the user clicks Refresh.
let listCache: { root: string | undefined; result: PythonInterpreter[]; ts: number } | null = null;
const LIST_TTL_MS = 30_000;

export async function listInterpreters(force = false): Promise<PythonInterpreter[]> {
  const root = workspace.getRoot();
  if (!force && listCache && listCache.root === root && Date.now() - listCache.ts < LIST_TTL_MS) {
    return listCache.result;
  }
  const candidates = await gatherCandidates();
  // Probe versions in parallel — capped concurrency would be polite but
  // even on a workstation with 15 interpreters this finishes in ~250ms.
  const versions = await Promise.all(candidates.map((c) => probeVersion(c.path)));
  const result: PythonInterpreter[] = candidates.map((c, i) => ({
    path: c.path,
    kind: c.kind,
    label: c.label,
    version: versions[i]
  }));
  listCache = { root, result, ts: Date.now() };
  return result;
}

// ---------------------------------------------------------------------------
// Selection persistence
// ---------------------------------------------------------------------------

function selectionPath(): string {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return join(root, '.opendev', 'python.json');
}

export async function getSelectedInterpreter(): Promise<PythonInterpreter | null> {
  const root = workspace.getRoot();
  if (!root) return null;
  let selectedPath: string | undefined;
  try {
    const raw = await fs.readFile(selectionPath(), 'utf8');
    selectedPath = (JSON.parse(raw) as { path?: string }).path;
  } catch { /* no file yet — fall through to auto-pick */ }

  const list = await listInterpreters();
  if (selectedPath) {
    const hit = list.find((i) => i.path === selectedPath);
    if (hit) return hit;
    // Stale selection (env got renamed/deleted) — fall through and re-pick.
  }
  // Auto-pick: workspace .venv if present, else system python3.
  return list.find((i) => i.kind === 'venv') ?? list.find((i) => i.kind === 'homebrew') ?? list[0] ?? null;
}

export async function setSelectedInterpreter(path: string): Promise<PythonInterpreter | null> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  await fs.mkdir(join(root, '.opendev'), { recursive: true });
  await fs.writeFile(selectionPath(), JSON.stringify({ path }, null, 2), 'utf8');
  const cur = await getSelectedInterpreter();
  safeSend(IPC.PythonChanged, cur);
  // Side effects: restart Pyright with the new interpreter so its
  // typeshed/site-packages resolution lines up. Done via dynamic import
  // to avoid a circular dep at module load.
  try {
    const lsp = await import('./lsp.js');
    if (typeof (lsp as { restartPyright?: () => void }).restartPyright === 'function') {
      (lsp as { restartPyright?: () => void }).restartPyright!();
    }
  } catch (e) {
    console.warn('[python] could not restart pyright:', (e as Error).message);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// venv creation
// ---------------------------------------------------------------------------
// Spawn `<basePython> -m venv .venv` at workspace root and stream output to
// the renderer via PythonVenvLog. Resolves to the new interpreter's path or
// throws on non-zero exit.

export async function createVenv(opts: { basePython: string; dirName?: string }): Promise<PythonInterpreter | null> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  const dirName = opts.dirName || '.venv';
  const target = join(root, dirName);
  if (existsSync(target)) throw new Error(`${dirName} already exists`);
  safeSend(IPC.PythonVenvLog, `[opendev] $ ${opts.basePython} -m venv ${dirName}\n`);
  const proc = spawn(opts.basePython, ['-m', 'venv', dirName], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const push = (b: Buffer) => safeSend(IPC.PythonVenvLog, b.toString('utf8'));
  proc.stdout?.on('data', push);
  proc.stderr?.on('data', push);
  const code: number = await new Promise((resolve) => proc.on('exit', (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error(`venv creation failed with exit ${code}`);
  // Fresh on disk; invalidate the cache so the new entry shows up.
  listCache = null;
  // Auto-select the just-created venv so the user doesn't have to click twice.
  const newPython = join(target, 'bin', 'python');
  return setSelectedInterpreter(newPython);
}

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------

export function registerPythonIpc(): void {
  ipcMain.handle(IPC.PythonList, (_e, force?: boolean) => listInterpreters(!!force));
  ipcMain.handle(IPC.PythonGet, () => getSelectedInterpreter());
  ipcMain.handle(IPC.PythonSet, (_e, path: string) => setSelectedInterpreter(path));
  ipcMain.handle(IPC.PythonCreateVenv, (_e, opts: { basePython: string; dirName?: string }) => createVenv(opts));
}

// Invalidate the interpreter list cache when the workspace changes — different
// .venv/, different conda envs may apply. Re-export this so workspace.ts can
// call it without a dependency on the IPC module shape.
export function invalidatePythonCache(): void {
  listCache = null;
}

// Suppress unused-import warning on `dirname` — kept available for future
// path operations (e.g. surfacing the parent venv folder in the UI).
void dirname;
