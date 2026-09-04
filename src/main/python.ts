import { ipcMain } from 'electron';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { join, delimiter, basename, dirname } from 'path';
import { IPC } from '@shared/ipc';
import type { PythonInterpreter } from '@shared/types';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { IS_WIN, withExtensions } from './platform.js';

const pexec = promisify(exec);

// ---------------------------------------------------------------------------
// Interpreter detection
// ---------------------------------------------------------------------------
// PyCharm-style: scan the usual locations for the platform, run `python -V`, return
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

// A virtualenv puts its interpreter in bin/ on POSIX and Scripts/ on Windows,
// and the executable is python.exe rather than python/python3.
const VENV_BIN = IS_WIN ? 'Scripts' : 'bin';
const PY_NAMES = IS_WIN ? ['python.exe'] : ['python', 'python3'];

function addVenv(out: Candidate[], dir: string, label: string): void {
  for (const name of PY_NAMES) addIfExists(out, join(dir, VENV_BIN, name), 'venv', label);
}

async function gatherCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const home = homedir();
  const root = workspace.getRoot();

  // 1. Workspace .venv / venv — highest priority when present.
  if (root) {
    addVenv(out, join(root, '.venv'), '.venv');
    addVenv(out, join(root, 'venv'), 'venv');
    // Sibling venv at the workspace parent — common when the user opens a
    // sub-folder (e.g. `korena/training/`) of a repo whose venv lives at the
    // repo root.
    addVenv(out, join(root, '..', '.venv'), '../.venv');
  }

  if (IS_WIN) await gatherWindowsCandidates(out, home);
  else await gatherPosixCandidates(out, home);

  // Last: PATH — anything the user explicitly put there that isn't already
  // covered. `where`/PATHEXT means the Windows names carry their extension.
  for (const bin of PY_NAMES) {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, bin);
      // Skip the Microsoft Store alias stubs: they are 0-byte reparse points
      // that open the Store instead of running Python.
      if (existsSync(p) && !isStoreStub(p)) out.push({ path: p, kind: 'path', label: `PATH (${dir})` });
    }
  }

  return uniqByPath(out);
}

function isStoreStub(p: string): boolean {
  if (!IS_WIN) return false;
  try { return statSync(p).size === 0; } catch { return false; }
}

async function gatherPosixCandidates(out: Candidate[], home: string): Promise<void> {
  // Homebrew on macOS (both arches).
  addIfExists(out, '/opt/homebrew/bin/python3', 'homebrew', 'Homebrew (arm64)');
  addIfExists(out, '/usr/local/bin/python3', 'homebrew', 'Homebrew (x86_64)');

  // Apple's bundled Python.
  addIfExists(out, '/usr/bin/python3', 'system', 'System');

  // python.org installer framework builds.
  for (const v of await listDirSafe('/Library/Frameworks/Python.framework/Versions')) {
    if (v === 'Current') continue;
    addIfExists(out, `/Library/Frameworks/Python.framework/Versions/${v}/bin/python3`, 'framework', `python.org ${v}`);
  }

  // pyenv installed versions.
  const pyenvRoot = process.env.PYENV_ROOT || join(home, '.pyenv');
  for (const v of await listDirSafe(join(pyenvRoot, 'versions'))) {
    addIfExists(out, join(pyenvRoot, 'versions', v, 'bin', 'python'), 'pyenv', `pyenv:${v}`);
  }

  // Conda / Miniforge envs.
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
}

async function gatherWindowsCandidates(out: Candidate[], home: string): Promise<void> {
  // The `py` launcher is the authoritative registry of installed CPythons.
  // `py -0p` prints one "-V:3.12 *  C:\...\python.exe" line per install.
  try {
    const { stdout } = await pexec('py -0p', { timeout: 4000, windowsHide: true });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*-V:([^\s*]+)\s*\*?\s+(.+?)\s*$/);
      if (!m) continue;
      addIfExists(out, m[2], 'framework', `python.org ${m[1]}`);
    }
  } catch { /* py launcher not installed — the directory scans below still apply */ }

  // python.org per-user and machine-wide installer layouts.
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  for (const base of [
    join(localAppData, 'Programs', 'Python'),
    join(process.env.ProgramFiles || 'C:\\Program Files'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)')
  ]) {
    for (const dir of await listDirSafe(base)) {
      if (!/^Python\d/i.test(dir)) continue;
      addIfExists(out, join(base, dir, 'python.exe'), 'system', `python.org ${dir.replace(/^Python/i, '')}`);
    }
  }

  // Conda / Miniforge — on Windows the base interpreter sits at the root of
  // the install, not in a bin/ subdirectory.
  for (const condaRoot of [
    join(home, 'miniforge3'),
    join(home, 'anaconda3'),
    join(home, 'miniconda3'),
    join(home, 'mambaforge'),
    join(process.env.ProgramData || 'C:\\ProgramData', 'anaconda3'),
    join(process.env.ProgramData || 'C:\\ProgramData', 'miniconda3')
  ]) {
    addIfExists(out, join(condaRoot, 'python.exe'), 'conda', `${basename(condaRoot)}:base`);
    for (const env of await listDirSafe(join(condaRoot, 'envs'))) {
      addIfExists(out, join(condaRoot, 'envs', env, 'python.exe'), 'conda', `${basename(condaRoot)}:${env}`);
    }
  }
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
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const push = (b: Buffer) => safeSend(IPC.PythonVenvLog, b.toString('utf8'));
  proc.stdout?.on('data', push);
  proc.stderr?.on('data', push);
  const code: number = await new Promise((resolve) => proc.on('exit', (c) => resolve(c ?? 1)));
  if (code !== 0) throw new Error(`venv creation failed with exit ${code}`);
  // Fresh on disk; invalidate the cache so the new entry shows up.
  listCache = null;
  // Auto-select the just-created venv so the user doesn't have to click twice.
  const newPython = withExtensions(join(target, VENV_BIN, IS_WIN ? 'python' : 'python'))
    .find((p) => existsSync(p)) || join(target, VENV_BIN, PY_NAMES[0]);
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
