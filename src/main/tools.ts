import { ipcMain } from 'electron';
import { spawn, execSync } from 'child_process';
import { safeSend } from './safeSend.js';
import { LIMITS, tail } from './limits.js';
import type { InstallableTool, ToolInstallResult } from '@shared/types';

export type ToolCheck = { npm: boolean; node: boolean; brew: boolean; git: boolean; npmVersion?: string; nodeVersion?: string };

function which(cmd: string): boolean {
  try {
    const r = execSync(`/usr/bin/which ${cmd}`, { encoding: 'utf8', env: process.env, timeout: 2000 });
    return Boolean(r && r.trim());
  } catch { return false; }
}

function version(cmd: string, flag = '--version'): string | undefined {
  try {
    const r = execSync(`${cmd} ${flag}`, { encoding: 'utf8', env: process.env, timeout: 2000 });
    return r.trim().split('\n')[0];
  } catch { return undefined; }
}

export function registerToolsIpc() {
  ipcMain.handle('tools:check', async (): Promise<ToolCheck> => ({
    npm: which('npm'),
    node: which('node'),
    brew: which('brew'),
    git: which('git'),
    npmVersion: which('npm') ? version('npm') : undefined,
    nodeVersion: which('node') ? version('node') : undefined
  }));

  ipcMain.handle('tools:install-node', async () => installViaBrew(['install', 'node']));

  // Generic tool installer used by the New Project wizard when a CLI is
  // missing. Maps a known tool name to the right brew invocation; tsx is
  // installed via npm since it's a Node package, not a system tool.
  ipcMain.handle('tools:install', async (_e, tool: InstallableTool): Promise<ToolInstallResult> => {
    if (tool === 'tsx') {
      if (!which('npm')) return { ok: false, error: 'npm is not installed — install Node.js first.' };
      return runStreamedInstall('npm', ['i', '-g', 'tsx']);
    }
    const argv = brewArgsFor(tool);
    if (!argv) return { ok: false, error: `Don't know how to install "${tool}".` };
    return installViaBrew(argv);
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

async function installViaBrew(args: string[]): Promise<ToolInstallResult> {
  if (!which('brew')) {
    return { ok: false, error: 'Homebrew is not installed. Install it from https://brew.sh first.' };
  }
  return runStreamedInstall('brew', args);
}

// Tracks the one in-flight install so `tools:cancel-install` can kill it.
let activeInstallProc: ReturnType<typeof spawn> | null = null;

function runStreamedInstall(cmd: string, args: string[]): Promise<ToolInstallResult> {
  return new Promise((resolve) => {
    safeSend('tools:install-log', `$ ${cmd} ${args.join(' ')}\n`);
    // stdin set to /dev/null so any tool that tries to prompt fails fast
    // instead of silently hanging waiting for input (the .NET cask did this).
    const proc = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
