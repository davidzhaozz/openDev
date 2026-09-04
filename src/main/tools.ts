import { ipcMain } from 'electron';
import { spawn, execSync } from 'child_process';
import { safeSend } from './safeSend.js';
import { LIMITS, tail } from './limits.js';
import type { InstallableTool, ToolInstallResult } from '@shared/types';
import { spawnBin, hasBin, IS_WIN } from './platform.js';

// `brew` on macOS, `winget` on Windows — the field is named for the macOS
// case because that's what the renderer has always keyed off; on Windows it
// answers "is there a package manager we can install through".
export type ToolCheck = { npm: boolean; node: boolean; brew: boolean; git: boolean; npmVersion?: string; nodeVersion?: string };

const which = hasBin;

/** Name of the system package manager we drive, or null if there isn't one. */
function packageManager(): 'brew' | 'winget' | null {
  if (IS_WIN) return which('winget') ? 'winget' : null;
  return which('brew') ? 'brew' : null;
}

function version(cmd: string, flag = '--version'): string | undefined {
  try {
    const r = execSync(`${cmd} ${flag}`, { encoding: 'utf8', env: process.env, timeout: 2000, windowsHide: true });
    return r.trim().split('\n')[0];
  } catch { return undefined; }
}

export function registerToolsIpc() {
  ipcMain.handle('tools:check', async (): Promise<ToolCheck> => ({
    npm: which('npm'),
    node: which('node'),
    brew: packageManager() !== null,
    git: which('git'),
    npmVersion: which('npm') ? version('npm') : undefined,
    nodeVersion: which('node') ? version('node') : undefined
  }));

  ipcMain.handle('tools:install-node', async () => installTool('node'));

  // Generic tool installer used by the New Project wizard when a CLI is
  // missing. Maps a known tool name to the right brew invocation; tsx is
  // installed via npm since it's a Node package, not a system tool.
  ipcMain.handle('tools:install', async (_e, tool: InstallableTool): Promise<ToolInstallResult> => {
    if (tool === 'tsx') {
      if (!which('npm')) return { ok: false, error: 'npm is not installed — install Node.js first.' };
      return runStreamedInstall('npm', ['i', '-g', 'tsx']);
    }
    return installTool(tool);
  });

  // Kill an in-flight tool install — used by the New Project modal's Cancel
  // button so the user is never trapped by a hanging brew (e.g. one that
  // wanted a sudo prompt).
  ipcMain.handle('tools:cancel-install', () => {
    if (!activeInstallProc) return { ok: false, error: 'No active install.' };
    try { activeInstallProc.kill('SIGTERM'); }
    catch { /* already gone */ }
    return { ok: true };
  });
}

function brewArgsFor(tool: InstallableTool): string[] | null {
  switch (tool) {
    case 'node':   return ['install', 'node'];
    case 'mvn':    return ['install', 'maven'];        // pulls openjdk as a dep
    case 'java':   return ['install', 'openjdk@17'];   // bare JDK, no Maven
    // IMPORTANT: use the `dotnet` formula, not the `dotnet-sdk` cask.
    // The cask installs to /usr/local/share/dotnet/ and prompts for sudo
    // (which hangs in a GUI subprocess that has no TTY). The formula goes
    // to brew's prefix and needs no sudo.
    case 'dotnet': return ['install', 'dotnet'];
    default:       return null;
  }
}

// winget package IDs. `--silent` keeps the installer from opening a UI the
// user can't reach from inside the log pane; the accept flags stop it from
// blocking on an agreement prompt that has no TTY to answer it.
function wingetIdFor(tool: InstallableTool): string | null {
  switch (tool) {
    case 'node':   return 'OpenJS.NodeJS.LTS';
    case 'mvn':    return 'Apache.Maven';
    case 'java':   return 'EclipseAdoptium.Temurin.17.JDK';
    case 'dotnet': return 'Microsoft.DotNet.SDK.8';
    default:       return null;
  }
}

async function installTool(tool: InstallableTool): Promise<ToolInstallResult> {
  const manager = packageManager();
  if (!manager) {
    return IS_WIN
      ? { ok: false, error: 'winget is not available. Install "App Installer" from the Microsoft Store, or install the tool manually.' }
      : { ok: false, error: 'Homebrew is not installed. Install it from https://brew.sh first.' };
  }
  if (manager === 'winget') {
    const id = wingetIdFor(tool);
    if (!id) return { ok: false, error: `Don't know how to install "${tool}" with winget.` };
    return runStreamedInstall('winget', [
      'install', '--id', id, '--exact', '--silent',
      '--accept-package-agreements', '--accept-source-agreements'
    ]);
  }
  const argv = brewArgsFor(tool);
  if (!argv) return { ok: false, error: `Don't know how to install "${tool}".` };
  return runStreamedInstall('brew', argv);
}

// Tracks the one in-flight install so `tools:cancel-install` can kill it.
let activeInstallProc: ReturnType<typeof spawn> | null = null;

function runStreamedInstall(cmd: string, args: string[]): Promise<ToolInstallResult> {
  return new Promise((resolve) => {
    safeSend('tools:install-log', `$ ${cmd} ${args.join(' ')}\n`);
    // stdin set to /dev/null so any tool that tries to prompt fails fast
    // instead of silently hanging waiting for input (the .NET cask did this).
    const proc = spawnBin(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    activeInstallProc = proc;
    let out = '';
    const append = (s: string) => { out = tail(out + s, LIMITS.subprocessBytes); };
    proc.stdout?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      append(s);
      safeSend('tools:install-log', s);
    });
    proc.stderr?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      append(s);
      safeSend('tools:install-log', s);
    });
    proc.on('error', (e) => {
      activeInstallProc = null;
      resolve({ ok: false, error: e.message });
    });
    proc.on('exit', (code, signal) => {
      activeInstallProc = null;
      if (signal === 'SIGTERM') resolve({ ok: false, error: 'Cancelled.' });
      else resolve({
        ok: code === 0,
        error: code === 0 ? undefined : `${cmd} exited with code ${code}.`
      });
    });
  });
}
