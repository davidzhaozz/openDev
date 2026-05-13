import { ipcMain } from 'electron';
import { spawn, execSync } from 'child_process';
import { safeSend } from './safeSend.js';
import { LIMITS, tail } from './limits.js';

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

  ipcMain.handle('tools:install-node', async () => {
    if (!which('brew')) {
      return { ok: false, error: 'Homebrew is not installed. Install it from https://brew.sh first.' };
    }
    return await new Promise<{ ok: boolean; output?: string; error?: string }>((resolve) => {
      const proc = spawn('brew', ['install', 'node'], { env: process.env });
      // Keep only the tail of brew's chatty output — the user mostly cares
      // about whatever's at the bottom when it fails, and the live IPC
      // stream is what they actually watch.
      let out = '';
      const appendCapped = (s: string) => {
        out = tail(out + s, LIMITS.subprocessBytes);
      };
      proc.stdout.on('data', (b: Buffer) => {
        const s = b.toString('utf8');
        appendCapped(s);
        safeSend('tools:install-log', s);
      });
      proc.stderr.on('data', (b: Buffer) => {
        const s = b.toString('utf8');
        appendCapped(s);
        safeSend('tools:install-log', s);
      });
      proc.on('error', (e) => resolve({ ok: false, error: e.message, output: out }));
      proc.on('exit', (code) => resolve({ ok: code === 0, output: out, error: code === 0 ? undefined : `brew install exited ${code}` }));
    });
  });
}
