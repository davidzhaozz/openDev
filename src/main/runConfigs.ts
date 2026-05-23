import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { PythonRunConfig, RunSession, RunStatus } from '@shared/types';
import { workspace } from './workspace.js';
import { onShutdown } from './lifecycle.js';
import { safeSend } from './safeSend.js';

// PyCharm-style run configurations. Persisted per-workspace in
// .opendev/run-configs.json. A run is a one-shot child process whose output
// streams to the renderer; multiple sessions can coexist but the UI today
// surfaces one at a time.

const LOG_TAIL = 4000;            // bytes per-session log buffer cap

type StoreShape = { items: PythonRunConfig[] };

class RunManager {
  // Persisted definitions.
  private async storePath(): Promise<string> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    return join(root, '.opendev', 'run-configs.json');
  }

  async list(): Promise<PythonRunConfig[]> {
    const root = workspace.getRoot();
    if (!root) return [];
    try {
      const raw = await fs.readFile(await this.storePath(), 'utf8');
      return (JSON.parse(raw) as StoreShape).items ?? [];
    } catch { return []; }
  }

  async save(cfg: PythonRunConfig): Promise<PythonRunConfig> {
    const list = await this.list();
    const out: PythonRunConfig = { ...cfg, id: cfg.id || randomUUID() };
    const idx = list.findIndex((c) => c.id === out.id);
    if (idx >= 0) list[idx] = out; else list.push(out);
    await this.write(list);
    safeSend(IPC.RunsChanged);
    return out;
  }

  async delete(id: string): Promise<void> {
    const next = (await this.list()).filter((c) => c.id !== id);
    await this.write(next);
    safeSend(IPC.RunsChanged);
  }

  private async write(items: PythonRunConfig[]): Promise<void> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    await fs.mkdir(join(root, '.opendev'), { recursive: true });
    await fs.writeFile(await this.storePath(), JSON.stringify({ items }, null, 2), 'utf8');
  }

  // Live sessions. One run = one ChildProcess. We keep the log as a string
  // buffer (capped) so a panel mount can replay the recent tail.
  private sessions = new Map<string, { proc: ChildProcess; session: RunSession; log: string }>();

  liveSessions(): RunSession[] {
    return [...this.sessions.values()].map((r) => r.session);
  }

  log(id: string): string {
    return this.sessions.get(id)?.log ?? '';
  }

  // Run a transient (unsaved) configuration. Used by the "Run current file"
  // button so we don't pollute the persisted run-config list with one-off
  // entries every time the user clicks ▶ on a .py file.
  async startAdHoc(spec: Omit<PythonRunConfig, 'id'>): Promise<RunSession> {
    return this.startWithConfig({ ...spec, id: `adhoc-${randomUUID()}` });
  }

  async start(configId: string): Promise<RunSession> {
    const cfg = (await this.list()).find((c) => c.id === configId);
    if (!cfg) throw new Error(`Run config ${configId} not found`);
    return this.startWithConfig(cfg);
  }

  private async startWithConfig(cfg: PythonRunConfig): Promise<RunSession> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');

    // Resolve interpreter: explicit override > workspace-selected > python3.
    let interpreter = cfg.interpreter;
    if (!interpreter) {
      try {
        const { getSelectedInterpreter } = await import('./python.js');
        const sel = await getSelectedInterpreter();
        interpreter = sel?.path;
      } catch { /* ignore */ }
    }
    if (!interpreter) interpreter = 'python3';

    const args: string[] = cfg.mode === 'module'
      ? ['-m', cfg.target, ...cfg.args]
      : [resolveTarget(root, cfg.target), ...cfg.args];

    const cwd = cfg.cwd
      ? (isAbsolute(cfg.cwd) ? cfg.cwd : resolve(root, cfg.cwd))
      : root;

    const id = randomUUID();
    const session: RunSession = {
      id,
      configId: cfg.id,
      configName: cfg.name,
      status: 'starting',
      startedAt: Date.now()
    };
    let log = `[opendev] $ ${interpreter} ${args.join(' ')}\n[opendev] cwd: ${cwd}\n`;
    const broadcast = () => safeSend(IPC.RunsStatus, session);

    const proc = spawn(interpreter, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...cfg.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached so SIGTERM hits the whole tree (subprocesses, threads).
      detached: true
    });
    session.pid = proc.pid;
    this.sessions.set(id, { proc, session, log });
    // Emit initial banner so the panel renders something even before the
    // child writes its first byte.
    safeSend(IPC.RunsLog, { id, chunk: log });

    const pushLog = (chunk: Buffer) => {
      try {
        const s = chunk.toString('utf8');
        const entry = this.sessions.get(id);
        if (!entry) return;
        entry.log = (entry.log + s).slice(-LOG_TAIL * 1000);
        safeSend(IPC.RunsLog, { id, chunk: s });
        if (entry.session.status === 'starting') {
          entry.session.status = 'running';
          broadcast();
        }
      } catch { /* logging mustn't crash the run */ }
    };
    proc.stdout?.on('data', pushLog);
    proc.stderr?.on('data', pushLog);

    proc.on('exit', (code, signal) => {
      const entry = this.sessions.get(id);
      if (!entry) return;
      // Treat SIGTERM (user-initiated stop) as a clean stop, not an error.
      const final: RunStatus = (code === 0 || signal === 'SIGTERM') ? 'stopped' : 'error';
      entry.session.status = final;
      entry.session.exitCode = code;
      if (final === 'error') entry.session.lastError = signal ? `signal ${signal}` : `exit code ${code}`;
      broadcast();
    });
    proc.on('error', (err) => {
      const entry = this.sessions.get(id);
      if (!entry) return;
      entry.session.status = 'error';
      entry.session.lastError = err.message;
      entry.log += `\n[spawn error] ${err.message}\n`;
      safeSend(IPC.RunsLog, { id, chunk: `\n[spawn error] ${err.message}\n` });
      broadcast();
    });
    broadcast();
    return session;
  }

  async stop(id: string, opts: { waitMs?: number } = {}): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    const pid = entry.proc.pid;
    const killGroup = (sig: NodeJS.Signals) => {
      try { if (pid) process.kill(-pid, sig); }
      catch { try { entry.proc.kill(sig); } catch {} }
    };
    if (entry.proc.exitCode == null) killGroup('SIGTERM');
    const waitMs = opts.waitMs ?? 3000;
    await new Promise<void>((res) => {
      if (entry.proc.exitCode != null) return res();
      const t = setTimeout(() => { killGroup('SIGKILL'); res(); }, waitMs);
      entry.proc.once('exit', () => { clearTimeout(t); res(); });
    });
  }

  async stopAll(waitMs = 2500): Promise<void> {
    const ids = [...this.sessions.keys()];
    if (ids.length === 0) return;
    console.log(`[runs] stopping ${ids.length} on shutdown`);
    await Promise.all(ids.map((id) => this.stop(id, { waitMs })));
  }
}

function resolveTarget(root: string, target: string): string {
  if (isAbsolute(target)) return target;
  return resolve(root, target);
}

export const runManager = new RunManager();
onShutdown(() => runManager.stopAll());

export function registerRunConfigsIpc(): void {
  ipcMain.handle(IPC.RunConfigsList, () => runManager.list());
  ipcMain.handle(IPC.RunConfigsSave, (_e, cfg: PythonRunConfig) => runManager.save(cfg));
  ipcMain.handle(IPC.RunConfigsDelete, (_e, id: string) => runManager.delete(id));
  ipcMain.handle(IPC.RunsStart, (_e, configId: string) => runManager.start(configId));
  ipcMain.handle(IPC.RunsStartAdHoc, (_e, spec: Omit<PythonRunConfig, 'id'>) => runManager.startAdHoc(spec));
  ipcMain.handle(IPC.RunsStop, (_e, sessionId: string) => runManager.stop(sessionId));
  ipcMain.handle(IPC.RunsList, () => runManager.liveSessions());
  ipcMain.handle('runs:log-replay', (_e, id: string) => runManager.log(id));
}
