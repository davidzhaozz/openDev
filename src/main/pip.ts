import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import type { PipPackage, PipRequirement } from '@shared/types';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';

// Pip wrapper. All commands target the workspace's currently-selected Python
// interpreter. We use `pip` via `<py> -m pip` so the right pip is always
// invoked (a global pip can resolve to the wrong env on macOS where Apple's
// /usr/bin/python3 and Homebrew Python both ship pip).

// ---- helpers --------------------------------------------------------------

async function selectedPython(): Promise<string> {
  const { getSelectedInterpreter } = await import('./python.js');
  const sel = await getSelectedInterpreter();
  if (!sel) throw new Error('No Python interpreter selected. Pick one from the Python chip in the Project panel.');
  return sel.path;
}

function runPip(py: string, args: string[], onLine?: (s: string) => void): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc: ChildProcess = spawn(py, ['-m', 'pip', '--disable-pip-version-check', ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stdout += s;
      if (onLine) onLine(s);
    });
    proc.stderr?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stderr += s;
      if (onLine) onLine(s);
    });
    proc.on('exit', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on('error', (err) => resolve({ stdout, stderr: stderr + `\n[spawn error] ${err.message}\n`, code: 1 }));
  });
}

// Coarse busy-flag so the UI can disable buttons while pip is running.
// Only one mutating op at a time — list/outdated read are fine concurrently.
let busy = false;
function setBusy(v: boolean) {
  if (busy === v) return;
  busy = v;
  safeSend(IPC.PipBusy, busy);
}

// ---- list / outdated ------------------------------------------------------

export async function listInstalled(): Promise<PipPackage[]> {
  const py = await selectedPython();
  const r = await runPip(py, ['list', '--format=json']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `pip list failed (exit ${r.code})`);
  try {
    const arr = JSON.parse(r.stdout) as Array<{ name: string; version: string }>;
    return arr.map((p) => ({ name: p.name, version: p.version, latest: undefined }));
  } catch (e) {
    throw new Error(`Could not parse pip list output: ${(e as Error).message}`);
  }
}

export async function listOutdated(): Promise<Record<string, string>> {
  const py = await selectedPython();
  // `--outdated` is slower (queries PyPI); cap its runtime via overall pip
  // timeouts — pip uses `--timeout` per network request. 10s per request is
  // a fair upper bound on a healthy network.
  const r = await runPip(py, ['list', '--outdated', '--format=json', '--timeout', '10']);
  if (r.code !== 0) return {}; // network failures shouldn't break the panel
  try {
    const arr = JSON.parse(r.stdout) as Array<{ name: string; version: string; latest_version?: string }>;
    const out: Record<string, string> = {};
    for (const p of arr) if (p.latest_version) out[p.name.toLowerCase()] = p.latest_version;
    return out;
  } catch {
    return {};
  }
}

// ---- install / uninstall / upgrade ---------------------------------------

const stream = (chunk: string) => safeSend(IPC.PipLog, chunk);

export async function installSpec(spec: string): Promise<void> {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream(`[opendev] $ ${py} -m pip install ${spec}\n`);
    const r = await runPip(py, ['install', spec], stream);
    if (r.code !== 0) throw new Error(`pip install failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}

export async function uninstall(name: string): Promise<void> {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream(`[opendev] $ ${py} -m pip uninstall -y ${name}\n`);
    const r = await runPip(py, ['uninstall', '-y', name], stream);
    if (r.code !== 0) throw new Error(`pip uninstall failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}

export async function upgrade(name: string): Promise<void> {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream(`[opendev] $ ${py} -m pip install --upgrade ${name}\n`);
    const r = await runPip(py, ['install', '--upgrade', name], stream);
    if (r.code !== 0) throw new Error(`pip install --upgrade failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}

// ---- requirements.txt ----------------------------------------------------

// Heuristic name extraction. requirements.txt is famously underspecified;
// real-world files include URL pins, --options, comments, editable installs,
// extras. We strip these to find a comparable package name; if we can't,
// the requirement still shows but its `installed` flag is false (the user
// can decide whether to install via `pip install -r`).
function parseRequirementName(line: string): string | null {
  const stripped = line.split('#')[0].trim();
  if (!stripped) return null;
  if (stripped.startsWith('-')) return null;       // -r, -e, --index-url, etc.
  if (/^[a-z]+:\/\//i.test(stripped)) return null; // URL install
  if (stripped.startsWith('git+')) return null;
  // Strip extras: "foo[extra1,extra2]>=1" → "foo"
  const m = stripped.match(/^([A-Za-z0-9_\-.]+)/);
  return m ? m[1].toLowerCase() : null;
}

export async function readRequirements(path?: string): Promise<{ path: string; requirements: PipRequirement[] } | null> {
  const root = workspace.getRoot();
  if (!root) return null;
  // Locate a requirements.txt — caller can override the path; we look in
  // common places otherwise.
  const candidates = path
    ? [path]
    : ['requirements.txt', 'training/requirements.txt', 'requirements/base.txt'].map((p) => join(root, p));
  let target: string | null = null;
  let text: string | null = null;
  for (const c of candidates) {
    try { text = await fs.readFile(c, 'utf8'); target = c; break; } catch { /* try next */ }
  }
  if (!text || !target) return null;
  const installed = await listInstalled().catch(() => [] as PipPackage[]);
  const map = new Map(installed.map((p) => [p.name.toLowerCase(), p.version]));
  const requirements: PipRequirement[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = rawLine.split('#')[0].trim();
    if (!stripped) continue;
    const name = parseRequirementName(stripped);
    const version = name ? map.get(name) : undefined;
    requirements.push({
      spec: stripped,
      name,
      installed: !!version,
      installedVersion: version || null
    });
  }
  return { path: target, requirements };
}

export async function installRequirements(path: string): Promise<void> {
  setBusy(true);
  try {
    const py = await selectedPython();
    stream(`[opendev] $ ${py} -m pip install -r ${path}\n`);
    const r = await runPip(py, ['install', '-r', path], stream);
    if (r.code !== 0) throw new Error(`pip install -r failed (exit ${r.code})`);
  } finally {
    setBusy(false);
  }
}

// ---- IPC wiring ----------------------------------------------------------

export function registerPipIpc(): void {
  ipcMain.handle(IPC.PipList, () => listInstalled());
  ipcMain.handle(IPC.PipOutdated, () => listOutdated());
  ipcMain.handle(IPC.PipInstall, (_e, spec: string) => installSpec(spec));
  ipcMain.handle(IPC.PipUninstall, (_e, name: string) => uninstall(name));
  ipcMain.handle(IPC.PipUpgrade, (_e, name: string) => upgrade(name));
  ipcMain.handle(IPC.PipReadRequirements, (_e, path?: string) => readRequirements(path));
  ipcMain.handle(IPC.PipInstallRequirements, (_e, path: string) => installRequirements(path));
}
