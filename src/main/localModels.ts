import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { IPC } from '@shared/ipc';
import type { MlxServerStatus } from '@shared/types';
import { safeSend } from './safeSend.js';
import { onShutdown } from './lifecycle.js';
import { workspace } from './workspace.js';

// Local model control plane — mlx_lm.server only. The Ollama integration
// was removed in v0.6.22; users who want it run `ollama serve` directly
// and point any OpenAI-compatible client at it. The IDE focuses on what
// it can drive end-to-end: spawning mlx_lm.server with a chosen base model
// + optional LoRA adapter, capturing logs, and exposing status.

// ---------------------------------------------------------------------------
// MLX-LM server manager
// ---------------------------------------------------------------------------

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class MlxServerManager {
  private proc: ChildProcess | null = null;
  private status: MlxServerStatus = { running: false };

  getStatus(): MlxServerStatus {
    return { ...this.status };
  }

  private broadcast(): void {
    safeSend(IPC.LlmMlxStatusChanged, this.getStatus());
  }

  async start(opts: { model: string; adapter?: string | null; port?: number; interpreter?: string }): Promise<MlxServerStatus> {
    if (this.proc && this.proc.exitCode == null) {
      // Idempotent: if the same model+adapter is already running, return current status.
      if (this.status.model === opts.model && (this.status.adapter || null) === (opts.adapter || null)) {
        return this.getStatus();
      }
      await this.stop();
    }
    const interpreter = await this.resolveInterpreter(opts.interpreter);
    const port = opts.port ?? (await pickFreePort());
    const args = ['-m', 'mlx_lm.server', '--model', opts.model, '--port', String(port), '--host', '127.0.0.1'];
    if (opts.adapter) args.push('--adapter-path', opts.adapter);
    safeSend(IPC.LlmMlxLog, `[opendev] $ ${interpreter} ${args.join(' ')}\n`);
    const proc = spawn(interpreter, args, {
      cwd: workspace.getRoot() || process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    this.proc = proc;
    this.status = {
      running: true,
      pid: proc.pid,
      port,
      model: opts.model,
      adapter: opts.adapter || null,
      startedAt: Date.now()
    };
    this.broadcast();
    let stderrTail = '';
    proc.stdout?.on('data', (b: Buffer) => safeSend(IPC.LlmMlxLog, b.toString('utf8')));
    proc.stderr?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stderrTail = (stderrTail + s).slice(-2000);
      safeSend(IPC.LlmMlxLog, s);
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      const cleanExit = code === 0 || signal === 'SIGTERM';
      this.status = {
        ...this.status,
        running: false,
        pid: undefined,
        lastError: cleanExit ? undefined : (
          /No module named ['"]mlx_lm['"]/i.test(stderrTail) || /No module named ['"]mlx['"]/i.test(stderrTail)
            ? 'mlx_lm is not installed in this interpreter. Open Packages and install: mlx-lm'
            : signal ? `signal ${signal}` : `exit code ${code}`
        )
      };
      this.broadcast();
    });
    proc.on('error', (err) => {
      this.status = { ...this.status, running: false, lastError: err.message };
      this.broadcast();
    });
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode != null) {
      this.status = { ...this.status, running: false };
      this.broadcast();
      return;
    }
    const pid = p.pid;
    try { if (pid) process.kill(-pid, 'SIGTERM'); }
    catch { try { p.kill('SIGTERM'); } catch {} }
    await new Promise<void>((res) => {
      if (p.exitCode != null) return res();
      const t = setTimeout(() => {
        try { if (pid) process.kill(-pid, 'SIGKILL'); } catch {}
        res();
      }, 3000);
      p.once('exit', () => { clearTimeout(t); res(); });
    });
    this.proc = null;
  }

  private async resolveInterpreter(override?: string): Promise<string> {
    if (override) return override;
    try {
      const { getSelectedInterpreter } = await import('./python.js');
      const sel = await getSelectedInterpreter();
      if (sel) return sel.path;
    } catch { /* fall through */ }
    return 'python3';
  }
}

export const mlxServer = new MlxServerManager();
onShutdown(() => mlxServer.stop());

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------

export function registerLocalModelsIpc(): void {
  ipcMain.handle(IPC.LlmMlxStart, (_e, opts: { model: string; adapter?: string | null; port?: number }) =>
    mlxServer.start(opts));
  ipcMain.handle(IPC.LlmMlxStop, () => mlxServer.stop());
  ipcMain.handle(IPC.LlmMlxStatus, () => mlxServer.getStatus());
}
