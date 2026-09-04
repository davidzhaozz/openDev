import { ipcMain } from 'electron';
import { spawn, exec, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, resolve, isAbsolute, basename, delimiter } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { ServiceDef, ServiceRuntime, ServiceStatus } from '@shared/types';
import { workspace } from './workspace.js';
import { onShutdown } from './lifecycle.js';
import { freePort, listListeningPorts } from './ports.js';
import { IS_WIN, commandShell, descendantPids, detachedSpawnOptions, killTree } from './platform.js';
import { safeSend } from './safeSend.js';
import { baseName, isWithin } from '@shared/paths';

const pexec = promisify(exec);

// Which ports is this service actually holding? On POSIX the spawned shell
// and its children share a process group, so lsof can filter by it directly.
// Windows has no equivalent, so we walk the parent/child links and match the
// listener table against that PID set.
async function listeningPortsForService(rootPid: number): Promise<number[]> {
  if (IS_WIN) {
    try {
      const pids = new Set(await descendantPids(rootPid));
      const listeners = await listListeningPorts();
      const ports = new Set(listeners.filter((l) => pids.has(l.pid)).map((l) => l.port));
      return [...ports].sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await pexec(`lsof -nP -iTCP -sTCP:LISTEN -a -g ${rootPid} -F n`, { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue;
      const m = line.match(/:(\d+)$/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

type StoreShape = { items: ServiceDef[] };

const LOG_TAIL = 1000;

class ServiceManager {
  private runtimes = new Map<string, { proc: ChildProcess; runtime: ServiceRuntime; log: string[] }>();
  // Internal listeners — other main-process modules (e.g. mlx.ts) hook
  // these to parse a service's stdout without re-spawning the process.
  private logListeners = new Set<(id: string, chunk: string) => void>();
  private statusListeners = new Set<(r: ServiceRuntime) => void>();

  onLogChunk(cb: (id: string, chunk: string) => void): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }
  onStatusChange(cb: (r: ServiceRuntime) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
  private emitLog(id: string, chunk: string): void {
    for (const cb of this.logListeners) {
      try { cb(id, chunk); } catch (e) { console.error('[services] log listener threw', e); }
    }
  }
  private emitStatus(r: ServiceRuntime): void {
    for (const cb of this.statusListeners) {
      try { cb(r); } catch (e) { console.error('[services] status listener threw', e); }
    }
  }

  storePath(): string {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    return join(root, '.opendev', 'services.json');
  }

  legacyPath(): string {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    return join(root, '.idea', 'opendev', 'services.json');
  }

  async list(): Promise<ServiceDef[]> {
    const root = workspace.getRoot();
    if (!root) return [];
    let store: StoreShape | null = null;
    try {
      const raw = await fs.readFile(this.storePath(), 'utf8');
      store = JSON.parse(raw);
    } catch {}
    if (!store) {
      try {
        const raw = await fs.readFile(this.legacyPath(), 'utf8');
        const legacy = JSON.parse(raw) as { items: Array<{ id: string; name: string; command: string; workingDir: string }> };
        store = { items: legacy.items.map(i => ({ id: i.id, name: i.name, command: i.command, cwd: i.workingDir })) };
      } catch {}
    }
    const userItems = store?.items ?? [];
    const autoItems = await this.autoServices(root);
    // Auto items appear first, but a user-saved item with the same id wins
    // (lets a user customize the auto-detected MLX command without losing it
    // on next workspace open). Filter overrides out of the auto list.
    const userIds = new Set(userItems.map((s) => s.id));
    const merged = [...autoItems.filter((s) => !userIds.has(s.id)), ...userItems];
    return merged;
  }

  // Workspace-derived "auto" services that show up without the user
  // explicitly adding them. Currently: MLX-LM LoRA training. id is stable
  // and prefixed with "auto-" so the UI hides delete/edit affordances.
  private async autoServices(root: string): Promise<ServiceDef[]> {
    const out: ServiceDef[] = [];
    try {
      const { detectMlxProject, buildTrainCommand, MLX_AUTO_SERVICE_ID } = await import('./mlx.js');
      const info = await detectMlxProject();
      if (info) {
        out.push({
          id: MLX_AUTO_SERVICE_ID,
          name: 'mlx-lora-train',
          cwd: '.',
          command: await buildTrainCommand(info)
        });
      }
    } catch (e) {
      // mlx import failing must never break the services list.
      console.warn('[services] auto-detect mlx failed', (e as Error).message);
    }
    return out;
  }

  async deriveFromDir(absPath: string): Promise<{ name: string; command: string; cwd: string }> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace');
    const norm = absPath.replace(/\/+$/, '');
    if (!isWithin(norm, root)) throw new Error('Path outside workspace');
    const cwd = norm === root ? '.' : norm.slice(root.length + 1);
    // Always use the folder name — package.json's `name` is often scoped/internal
    // and doesn't match what you'd recognize in the services list.
    const name = cwd === '.' ? baseName(root) || 'service' : baseName(cwd) || cwd;

    const has = async (f: string): Promise<boolean> => {
      try { await fs.access(join(norm, f)); return true; } catch { return false; }
    };
    const read = async (f: string): Promise<string | null> => {
      try { return await fs.readFile(join(norm, f), 'utf8'); } catch { return null; }
    };

    // 1. Node / npm — pick the most "run"-like script.
    const pkgRaw = await read('package.json');
    if (pkgRaw) {
      try {
        const scripts = (JSON.parse(pkgRaw).scripts || {}) as Record<string, string>;
        let command = 'npm start';
        if (scripts.dev) command = 'npm run dev';
        else if (scripts.start) command = 'npm run start';
        else if (scripts.serve) command = 'npm run serve';
        return { name, command, cwd };
      } catch {
        // Malformed package.json — fall through to other detectors.
      }
    }

    // 2. Maven (pom.xml) — prefer the project's wrapper if present.
    const pom = await read('pom.xml');
    if (pom) {
      const mvn = (await has('mvnw')) ? './mvnw' : 'mvn';
      const command = /spring-boot/.test(pom)
        ? `${mvn} spring-boot:run`
        : `${mvn} compile exec:java`;
      return { name, command, cwd };
    }

    // 3. Gradle (build.gradle / build.gradle.kts).
    const gradleBuild = (await read('build.gradle')) ?? (await read('build.gradle.kts'));
    if (gradleBuild) {
      const gradle = (await has('gradlew')) ? './gradlew' : 'gradle';
      const command = /spring-boot|org\.springframework\.boot/.test(gradleBuild)
        ? `${gradle} bootRun`
        : `${gradle} run`;
      return { name, command, cwd };
    }

    // 4. .NET / dotnet — any *.csproj or *.sln in this folder counts.
    try {
      const entries = await fs.readdir(norm);
      const hasCsproj = entries.some(e => e.endsWith('.csproj'));
      const hasSln = entries.some(e => e.endsWith('.sln'));
      if (hasCsproj || hasSln) {
        // `dotnet run` from a folder containing a .csproj just works; with a
        // .sln you may need --project, but `dotnet run` will pick the single
        // project if there's only one — leaves the trivial case clean.
        return { name, command: 'dotnet run', cwd };
      }
    } catch { /* unreadable dir — fall through */ }

    // 5. MLX-LM LoRA — a lora_config.yaml signals an MLX fine-tune project.
    //    Prefer a project-local .venv when present.
    if (await has('lora_config.yaml')) {
      const venvLora = join(norm, '.venv', 'bin', 'mlx_lm.lora');
      const venvPy = join(norm, '.venv', 'bin', 'python');
      let command = 'python3 -m mlx_lm.lora --config lora_config.yaml';
      try { await fs.access(venvLora); command = '.venv/bin/mlx_lm.lora --config lora_config.yaml'; }
      catch {
        try { await fs.access(venvPy); command = '.venv/bin/python -m mlx_lm.lora --config lora_config.yaml'; } catch {}
      }
      return { name, command, cwd };
    }

    // 6. Generic Python — pick the most "entry"-looking script. Doesn't try
    //    to be clever about pyproject scripts; the user can edit.
    try {
      const entries = await fs.readdir(norm);
      const pyEntry = ['main.py', 'app.py', 'run.py', 'server.py', 'train.py'].find((f) => entries.includes(f));
      const hasPy = pyEntry || entries.some((e) => e.endsWith('.py'));
      if (hasPy || (await has('requirements.txt')) || (await has('pyproject.toml'))) {
        const venvPy = join(norm, '.venv', 'bin', 'python');
        let pyBin = 'python3';
        try { await fs.access(venvPy); pyBin = '.venv/bin/python'; } catch {}
        const command = pyEntry ? `${pyBin} ${pyEntry}` : `${pyBin}`;
        return { name, command, cwd };
      }
    } catch { /* unreadable dir — fall through */ }

    // Nothing recognized — leave a generic placeholder for the user to edit.
    return { name, command: 'npm run dev', cwd };
  }

  async save(def: ServiceDef): Promise<ServiceDef> {
    const list = await this.readUserList();
    const out: ServiceDef = { ...def, id: def.id || randomUUID() };
    const idx = list.findIndex(s => s.id === out.id);
    if (idx >= 0) list[idx] = out; else list.push(out);
    await this.writeUserList(list);
    safeSend(IPC.ServicesChanged);
    return out;
  }

  async delete(id: string): Promise<void> {
    const list = (await this.readUserList()).filter(s => s.id !== id);
    await this.writeUserList(list);
    safeSend(IPC.ServicesChanged);
  }

  private async readUserList(): Promise<ServiceDef[]> {
    try {
      const raw = await fs.readFile(this.storePath(), 'utf8');
      return (JSON.parse(raw) as StoreShape).items ?? [];
    } catch { return []; }
  }

  private async writeUserList(items: ServiceDef[]): Promise<void> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace');
    await fs.mkdir(join(root, '.opendev'), { recursive: true });
    await fs.writeFile(this.storePath(), JSON.stringify({ items }, null, 2), 'utf8');
  }

  async start(id: string): Promise<ServiceRuntime> {
    const list = await this.list();
    const def = list.find(s => s.id === id);
    if (!def) throw new Error(`Service ${id} not found`);
    if (this.runtimes.has(id)) {
      const existing = this.runtimes.get(id)!;
      if (existing.runtime.status === 'running' || existing.runtime.status === 'starting') {
        return existing.runtime;
      }
    }
    const root = workspace.getRoot()!;
    const cwd = isAbsolute(def.cwd) ? def.cwd : resolve(root, def.cwd);
    const log: string[] = [];
    const runtime: ServiceRuntime = { id, status: 'starting', startedAt: Date.now() };
    const broadcast = () => { safeSend(IPC.ServicesStatus, runtime); this.emitStatus(runtime); };

    // Pre-flight: if this service has a known port (def.port), free it
    // before spawning. Otherwise the new process will EADDRINUSE-fail
    // immediately. This is the "always make the port available" behavior
    // the user wanted.
    if (def.port) {
      try {
        const r = await freePort(def.port);
        if (r.killed.length > 0) {
          const msg = `[opendev] freed port ${def.port} (killed PID${r.killed.length === 1 ? '' : 's'} ${r.killed.join(', ')})\n`;
          log.push(msg);
          safeSend(IPC.ServicesLog, { id, chunk: msg });
        }
      } catch { /* keep going — start() may still succeed on a different port */ }
    }

    log.push(`[opendev] $ ${def.command}\n[opendev] cwd: ${cwd}\n[opendev] PATH=${(process.env.PATH || '').split(delimiter).slice(0, 6).join(delimiter)}…\n`);
    // On POSIX, detached:true puts the shell + children into a new process
    // group so we can signal the whole tree on shutdown — without it, killing
    // the wrapping shell leaves npm/tsx/node orphans bound to dev ports. On
    // Windows detached would open a console window per service, so the tree is
    // walked by taskkill at stop time instead (see platform.killTree).
    const proc = spawn(def.command, {
      cwd,
      shell: commandShell(),
      env: { ...process.env, FORCE_COLOR: '1', ...def.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...detachedSpawnOptions()
    });
    runtime.pid = proc.pid;
    this.runtimes.set(id, { proc, runtime, log });

    // Recovery state — guards against thrashing if the conflicting
    // process keeps respawning (we only attempt recovery once per start).
    let attemptedRecovery = false;
    const tryRecoverEaddrInUse = async (text: string) => {
      if (attemptedRecovery) return;
      const m = text.match(/EADDRINUSE[^\d]*:?(\d{2,5})\b/);
      if (!m) return;
      const conflictPort = Number(m[1]);
      if (!Number.isFinite(conflictPort) || conflictPort < 1) return;
      attemptedRecovery = true;
      const msg = `\n[opendev] detected EADDRINUSE on :${conflictPort} — killing holder and restarting…\n`;
      log.push(msg);
      safeSend(IPC.ServicesLog, { id, chunk: msg });
      try {
        const r = await freePort(conflictPort);
        const done = `[opendev] freed :${conflictPort} (killed PID${r.killed.length === 1 ? '' : 's'} ${r.killed.join(', ') || 'none'})\n`;
        log.push(done);
        safeSend(IPC.ServicesLog, { id, chunk: done });
      } catch { /* fall through to restart anyway */ }
      // Kill current shell (it already failed). The exit handler will
      // mark status=stopped; we then kick off a fresh start.
      const pid = proc.pid;
      try { if (pid) process.kill(-pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      // Defer restart to next tick so the exit handler runs first.
      setTimeout(() => {
        this.start(id).catch((err) => {
          const errMsg = `\n[opendev] auto-restart failed: ${err?.message || err}\n`;
          log.push(errMsg);
          safeSend(IPC.ServicesLog, { id, chunk: errMsg });
        });
      }, 250);
    };

    const pushLog = (chunk: Buffer) => {
      try {
        const s = chunk.toString('utf8');
        log.push(s);
        while (log.length > LOG_TAIL) log.shift();
        safeSend(IPC.ServicesLog, { id, chunk: s });
        this.emitLog(id, s);
        if (runtime.status === 'starting') {
          runtime.status = 'running';
          broadcast();
        }
        // Detect "address in use" failures and auto-recover.
        if (/EADDRINUSE/i.test(s)) void tryRecoverEaddrInUse(s);
      } catch { /* logging mustn't crash the process */ }
    };
    proc.stdout?.on('data', pushLog);
    proc.stderr?.on('data', pushLog);

    proc.on('exit', (code, signal) => {
      try {
        const r = this.runtimes.get(id);
        if (!r) return;
        r.runtime.status = (code === 0 || signal === 'SIGTERM') ? 'stopped' : 'error';
        r.runtime.lastError = code !== 0 && signal !== 'SIGTERM' ? `exit code ${code}` : undefined;
        broadcast();
      } catch { /* window torn down mid-exit */ }
    });
    proc.on('error', (err) => {
      try {
        runtime.status = 'error';
        runtime.lastError = err.message;
        log.push(`\n[spawn error] ${err.message}\n`);
        broadcast();
      } catch { /* window torn down mid-error */ }
    });
    broadcast();
    return runtime;
  }

  async stop(id: string, opts: { waitMs?: number } = {}): Promise<void> {
    const r = this.runtimes.get(id);
    if (!r) return;
    const pid = r.proc.pid;
    const kill = async (force: boolean) => {
      if (pid) await killTree(pid, force);
      else { try { r.proc.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ } }
    };
    if (r.proc.exitCode == null) await kill(false);

    const waitMs = opts.waitMs ?? 4000;
    await new Promise<void>((resolve) => {
      if (r.proc.exitCode != null) return resolve();
      const t = setTimeout(() => { void kill(true).then(resolve); }, waitMs);
      r.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  async restart(id: string): Promise<ServiceRuntime> {
    const existing = this.runtimes.get(id);
    if (existing) {
      await this.stop(id);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4500);
        existing.proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    return this.start(id);
  }

  status(id: string): ServiceRuntime {
    const r = this.runtimes.get(id);
    return r?.runtime ?? { id, status: 'stopped' as ServiceStatus };
  }

  allStatuses(): ServiceRuntime[] {
    return [...this.runtimes.values()].map(r => r.runtime);
  }

  async allPorts(): Promise<Record<string, number[]>> {
    const out: Record<string, number[]> = {};
    await Promise.all([...this.runtimes.entries()].map(async ([id, r]) => {
      if (r.runtime.status !== 'running' && r.runtime.status !== 'starting') return;
      if (!r.proc.pid) return;
      const ports = await listeningPortsForService(r.proc.pid);
      if (ports.length) out[id] = ports;
    }));
    return out;
  }

  log(id: string): string {
    const r = this.runtimes.get(id);
    if (!r) return '';
    return r.log.join('');
  }

  async stopAll(waitMs = 3500): Promise<void> {
    const ids = [...this.runtimes.keys()];
    if (ids.length === 0) return;
    console.log(`[services] stopping ${ids.length} on shutdown`);
    await Promise.all(ids.map(id => this.stop(id, { waitMs })));
  }

  // Shutdown-path variant: skip graceful SIGTERM entirely and ALSO kill
  // whatever's still listening on the ports each service was using. With
  // shell:true + node/npm child trees, some processes escape the group
  // kill (vite cluster workers, npm respawn-on-crash, etc) and keep the
  // dev port held even after the parent shell exits — which is exactly
  // what the user is seeing. Targeting the port directly is the only
  // reliable cleanup.
  async stopAllImmediate(): Promise<void> {
    const entries = [...this.runtimes.entries()];
    if (entries.length === 0) return;
    console.log(`[services] hard-killing ${entries.length} on quit`);

    // 1) Snapshot the ports each service was holding BEFORE we kill —
    //    once the shell exits the lsof query loses the group context.
    const portsByService: number[][] = await Promise.all(entries.map(async ([, r]) => {
      if (!r.proc.pid) return [];
      try { return await listeningPortsForService(r.proc.pid); }
      catch { return []; }
    }));

    // 2) Hard-kill each tree immediately. No grace period.
    await Promise.all(entries.map(async ([, r]) => {
      const pid = r.proc.pid;
      if (pid) await killTree(pid, true);
      else { try { r.proc.kill('SIGKILL'); } catch { /* already gone */ } }
    }));

    // 3) Belt-and-suspenders: any process still listening on those ports
    //    after the tree kill is an orphan. freePort() finds and kills it the
    //    same way on every platform.
    const allPorts = new Set<number>();
    for (const ports of portsByService) for (const p of ports) allPorts.add(p);
    if (allPorts.size > 0) {
      console.log(`[services] freeing ports ${[...allPorts].join(', ')}`);
      await Promise.all([...allPorts].map((port) => freePort(port).catch(() => ({ killed: [] }))));
    }
  }
}

export const serviceManager = new ServiceManager();
// Use the aggressive path on shutdown — the graceful one was leaking
// child processes that kept ports bound after the app exited.
onShutdown(() => serviceManager.stopAllImmediate());

export function registerServicesIpc() {
  ipcMain.handle(IPC.ServicesList, () => serviceManager.list());
  ipcMain.handle(IPC.ServicesSave, (_e, def: ServiceDef) => serviceManager.save(def));
  ipcMain.handle(IPC.ServicesDelete, (_e, id: string) => serviceManager.delete(id));
  ipcMain.handle(IPC.ServicesStart, (_e, id: string) => serviceManager.start(id));
  ipcMain.handle(IPC.ServicesStop, (_e, id: string) => serviceManager.stop(id));
  ipcMain.handle(IPC.ServicesRestart, (_e, id: string) => serviceManager.restart(id));
  ipcMain.handle(IPC.ServicesDeriveFromDir, (_e, absPath: string) => serviceManager.deriveFromDir(absPath));
  ipcMain.handle(IPC.ServicesStatus, () => serviceManager.allStatuses());
  ipcMain.handle(IPC.ServicesLog, (_e, id: string) => serviceManager.log(id));
  ipcMain.handle(IPC.ServicesPorts, () => serviceManager.allPorts());
}

export function describeAutoService(name: string): string {
  return basename(name);
}
