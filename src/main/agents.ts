import { ipcMain, dialog, app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, watch, type FSWatcher } from 'fs';
import { join, basename, extname } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { AgentInfo, AgentManifest, AgentRun, AgentRunStatus, AgentRunTarget } from '@shared/types';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { resolveBinPath } from './ai.js';
import { BUILTIN_AGENTS, BUILTIN_SLUGS } from './defaultAgents.js';
import { spawnBin } from './platform.js';

// Each agent is a self-contained Node.js app under .opendev/agents/<slug>/.
// This module is the manifest store + run manager, modeled on services.ts.

const LOG_TAIL = 2000;

// Starter entry file written for AI-created (blank) agents. Documents the
// runtime contract inline so a hand-edited agent stays correct.
const STARTER_INDEX = `// OpenDev IDE agent — a standalone Node.js app run against the workspace codebase.
//
// Runtime contract:
//   - cwd is the workspace root (the codebase you operate on).
//   - process.env.OPENDEV_WORKSPACE_ROOT  — absolute path to the codebase.
//   - process.env.OPENDEV_AGENT_DIR       — absolute path to this agent's folder.
//   - Write results to stdout. If the FIRST thing you print is a full HTML
//     document (starts with <!doctype html> or <html>), the IDE renders it
//     in a sandboxed iframe; otherwise stdout streams as a plain log.
//   - Bundle any npm deps inside this agent folder.

const root = process.env.OPENDEV_WORKSPACE_ROOT;
console.log('Agent running against:', root);
`;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent';
}

class AgentManager {
  private runs = new Map<string, { proc: ChildProcess; run: AgentRun; log: string[] }>();
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private builtinsReady = false;

  private agentsDir(): string {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    return join(root, '.opendev', 'agents');
  }

  // Built-in agents live app-globally (not per-workspace) — they ship with
  // OpenDev IDE. We materialize them to disk so run() treats them exactly
  // like user agents. Re-materialized once per launch to pick up updates.
  private builtinDir(): string {
    return join(app.getPath('appData'), 'openDev', 'builtin-agents');
  }

  private async ensureBuiltins(): Promise<void> {
    if (this.builtinsReady) return;
    for (const a of BUILTIN_AGENTS) {
      const dir = join(this.builtinDir(), a.manifest.slug);
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, a.manifest.entry), a.source, 'utf8');
        await fs.writeFile(join(dir, 'agent.json'), JSON.stringify(a.manifest, null, 2), 'utf8');
      } catch (err) {
        console.error(`[agents] failed to materialize built-in ${a.manifest.slug}`, err);
      }
    }
    this.builtinsReady = true;
  }

  private builtinInfos(): AgentInfo[] {
    return BUILTIN_AGENTS.map((a) => ({
      ...a.manifest,
      dir: join(this.builtinDir(), a.manifest.slug)
    }));
  }

  // (Re)point a shallow watcher at the current workspace's agents dir. Called
  // from list() so it always tracks the active workspace — same on-demand
  // re-watch philosophy as workspace.ts.
  private ensureWatcher(dir: string): void {
    if (this.watchedDir === dir && this.watcher) return;
    if (this.watcher) { try { this.watcher.close(); } catch {} this.watcher = null; }
    this.watchedDir = dir;
    try {
      this.watcher = watch(dir, { persistent: true, recursive: true }, () => {
        if (this.changeTimer) clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => safeSend(IPC.AgentsChanged), 150);
      });
      this.watcher.on('error', () => {
        if (this.watcher) { try { this.watcher.close(); } catch {} }
        this.watcher = null;
        this.watchedDir = null;
      });
    } catch {
      // Dir may not exist yet — that's fine; next list() retries.
      this.watchedDir = null;
    }
  }

  async list(): Promise<AgentInfo[]> {
    await this.ensureBuiltins();
    // Built-in agents always appear first, regardless of whether a
    // workspace is open.
    const builtins = this.builtinInfos();
    const root = workspace.getRoot();
    if (!root) return builtins;
    const dir = this.agentsDir();
    try { await fs.mkdir(dir, { recursive: true }); } catch {}
    this.ensureWatcher(dir);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return builtins;
    }
    const user: AgentInfo[] = [];
    for (const name of entries) {
      const agentDir = join(dir, name);
      try {
        const stat = await fs.stat(agentDir);
        if (!stat.isDirectory()) continue;
        const raw = await fs.readFile(join(agentDir, 'agent.json'), 'utf8');
        const m = JSON.parse(raw) as AgentManifest;
        if (!m.slug || !m.entry) continue;
        user.push({ ...m, dir: agentDir });
      } catch {
        // Skip dirs without a valid manifest.
      }
    }
    user.sort((a, b) => b.createdAt - a.createdAt);
    return [...builtins, ...user];
  }

  private async uniqueSlug(base: string): Promise<string> {
    const dir = this.agentsDir();
    let slug = slugify(base);
    let n = 2;
    // Loop until the candidate folder doesn't exist.
    while (true) {
      try {
        await fs.access(join(dir, slug));
        slug = `${slugify(base)}-${n++}`;
      } catch {
        return slug;
      }
    }
  }

  async create(args: { name: string; description: string }): Promise<AgentInfo> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    const slug = await this.uniqueSlug(args.name || 'agent');
    const agentDir = join(this.agentsDir(), slug);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(join(agentDir, 'index.js'), STARTER_INDEX, 'utf8');
    const manifest: AgentManifest = {
      slug,
      name: args.name || slug,
      description: args.description || '',
      entry: 'index.js',
      runtime: 'node',
      createdBy: 'ai',
      createdAt: Date.now()
    };
    await fs.writeFile(join(agentDir, 'agent.json'), JSON.stringify(manifest, null, 2), 'utf8');
    safeSend(IPC.AgentsChanged);
    return { ...manifest, dir: agentDir };
  }

  // Detect the entry file inside an imported folder: package.json `main`,
  // else the first conventional entry name.
  private async detectEntry(folder: string): Promise<string> {
    try {
      const pkg = JSON.parse(await fs.readFile(join(folder, 'package.json'), 'utf8'));
      if (typeof pkg.main === 'string' && pkg.main) {
        if (await this.exists(join(folder, pkg.main))) return pkg.main;
      }
    } catch {}
    for (const cand of ['index.ts', 'index.js', 'index.mjs', 'main.ts', 'main.js', 'main.mjs']) {
      if (await this.exists(join(folder, cand))) return cand;
    }
    throw new Error('Could not find an entry file (index.js / index.ts / package.json main) in the imported folder');
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
  }

  async importFrom(srcPath: string): Promise<AgentInfo> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    const stat = await fs.stat(srcPath);
    const base = basename(srcPath).replace(/\.(ts|js|mjs)$/i, '');
    const slug = await this.uniqueSlug(base);
    const agentDir = join(this.agentsDir(), slug);
    await fs.mkdir(agentDir, { recursive: true });

    let entry: string;
    if (stat.isFile()) {
      entry = basename(srcPath);
      await fs.copyFile(srcPath, join(agentDir, entry));
    } else {
      await fs.cp(srcPath, agentDir, { recursive: true });
      entry = await this.detectEntry(agentDir);
    }
    const runtime = extname(entry).toLowerCase() === '.ts' ? 'tsx' : 'node';
    const manifest: AgentManifest = {
      slug,
      name: base,
      description: `Imported from ${srcPath}`,
      entry,
      runtime,
      createdBy: 'import',
      createdAt: Date.now()
    };
    await fs.writeFile(join(agentDir, 'agent.json'), JSON.stringify(manifest, null, 2), 'utf8');
    safeSend(IPC.AgentsChanged);
    return { ...manifest, dir: agentDir };
  }

  async delete(slug: string): Promise<boolean> {
    if (BUILTIN_SLUGS.has(slug)) {
      throw new Error('Built-in agents cannot be deleted.');
    }
    // Stop any in-flight runs for this agent first.
    for (const [runId, r] of this.runs) {
      if (r.run.agentSlug === slug) await this.stop(runId);
    }
    const agentDir = join(this.agentsDir(), slug);
    await fs.rm(agentDir, { recursive: true, force: true });
    safeSend(IPC.AgentsChanged);
    return true;
  }

  private async loadManifest(slug: string): Promise<{ manifest: AgentManifest; dir: string }> {
    // Built-in agents resolve to the app-global materialized dir; everything
    // else lives in the workspace's .opendev/agents/.
    const dir = BUILTIN_SLUGS.has(slug)
      ? join(this.builtinDir(), slug)
      : join(this.agentsDir(), slug);
    const raw = await fs.readFile(join(dir, 'agent.json'), 'utf8');
    return { manifest: JSON.parse(raw) as AgentManifest, dir };
  }

  // Resolve the interpreter + env for an agent. node => the node binary (or
  // the bundled Electron-as-node fallback); tsx => the tsx binary, which the
  // user must have installed. Shared by run() and runAndCollect().
  private resolveAgentCommand(
    manifest: AgentManifest, dir: string, entryAbs: string, root: string
  ): { cmd: string; args: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENDEV_WORKSPACE_ROOT: root,
      OPENDEV_AGENT_DIR: dir,
      FORCE_COLOR: '1'
    };
    if (manifest.runtime === 'tsx') {
      const tsx = resolveBinPath('tsx');
      if (!tsx) {
        throw new Error('This agent is TypeScript and needs tsx. Install it with: npm i -g tsx');
      }
      return { cmd: tsx, args: [entryAbs], env };
    }
    const node = resolveBinPath('node');
    if (node) return { cmd: node, args: [entryAbs], env };
    // Fall back to running the bundled Electron binary as plain Node.
    return { cmd: process.execPath, args: [entryAbs], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }

  // Run an agent and resolve with its full output once it exits. Used by the
  // MCP `ide_run_agent` tool so the main AI can invoke an agent and read the
  // result synchronously (no IPC streaming, no center tab).
  async runAndCollect(
    slug: string, opts: { timeoutMs?: number } = {}
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    await this.ensureBuiltins();
    const { manifest, dir } = await this.loadManifest(slug);
    const entryAbs = join(dir, manifest.entry);
    if (!(await this.exists(entryAbs))) {
      throw new Error(`Agent entry not found: ${manifest.entry}`);
    }
    const { cmd, args, env } = this.resolveAgentCommand(manifest, dir, entryAbs, root);
    const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? 120_000), 600_000);
    const cap = 2 * 1024 * 1024;
    return new Promise((resolveP) => {
      const proc = spawnBin(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
      let output = '';
      let timedOut = false;
      const onData = (b: Buffer) => { if (output.length < cap) output += b.toString('utf8'); };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      const t = setTimeout(() => { timedOut = true; try { proc.kill('SIGTERM'); } catch {} }, timeoutMs);
      proc.on('exit', (code) => {
        clearTimeout(t);
        resolveP({ output: output.slice(0, cap), exitCode: code, timedOut });
      });
      proc.on('error', (e) => {
        clearTimeout(t);
        resolveP({ output: output + `\n[spawn error] ${e.message}`, exitCode: -1, timedOut });
      });
    });
  }

  async run(slug: string, target: AgentRunTarget = 'local'): Promise<AgentRun> {
    // Remote dispatch is wired in Milestone 3; for now only 'local' runs here.
    if (target !== 'local') {
      const { dispatchAgentRun } = await import('./peers.js');
      return dispatchAgentRun(slug, target);
    }
    const root = workspace.getRoot();
    if (!root) throw new Error('No workspace open');
    await this.ensureBuiltins();
    const { manifest, dir } = await this.loadManifest(slug);
    const entryAbs = join(dir, manifest.entry);
    if (!(await this.exists(entryAbs))) {
      throw new Error(`Agent entry not found: ${manifest.entry}`);
    }

    const { cmd, args, env } = this.resolveAgentCommand(manifest, dir, entryAbs, root);

    const runId = `ar-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const streamId = runId;
    const proc = spawnBin(cmd, args, {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    const run: AgentRun = {
      runId,
      agentSlug: slug,
      streamId,
      status: 'running',
      startedAt: Date.now(),
      target: 'local'
    };
    const log: string[] = [];
    this.runs.set(runId, { proc, run, log });

    const pushLog = (chunk: Buffer) => {
      try {
        const s = chunk.toString('utf8');
        log.push(s);
        while (log.length > LOG_TAIL) log.shift();
        safeSend(IPC.AgentStream, { streamId, chunk: s });
      } catch { /* logging mustn't crash */ }
    };
    proc.stdout?.on('data', pushLog);
    proc.stderr?.on('data', pushLog);

    proc.on('exit', (code, signal) => {
      try {
        const r = this.runs.get(runId);
        if (!r) return;
        const status: AgentRunStatus = (code === 0 || signal === 'SIGTERM') ? 'stopped' : 'error';
        r.run.status = status;
        r.run.exitCode = code ?? undefined;
        safeSend(IPC.AgentStream, { streamId, done: true, status, exitCode: code ?? undefined });
      } catch { /* window torn down mid-exit */ }
    });
    proc.on('error', (err) => {
      try {
        const r = this.runs.get(runId);
        if (!r) return;
        r.run.status = 'error';
        const msg = `\n[agent spawn error] ${err.message}\n`;
        log.push(msg);
        safeSend(IPC.AgentStream, { streamId, chunk: msg });
        safeSend(IPC.AgentStream, { streamId, done: true, status: 'error' });
      } catch { /* window torn down mid-error */ }
    });

    return run;
  }

  async stop(runId: string): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r) {
      // Not a local run — it may be dispatched to a peer.
      const { stopRemoteRun } = await import('./peers.js');
      return stopRemoteRun(runId);
    }
    const pid = r.proc.pid;
    const killGroup = (sig: NodeJS.Signals) => {
      try { if (pid) process.kill(-pid, sig); }
      catch { try { r.proc.kill(sig); } catch {} }
    };
    if (r.proc.exitCode == null) killGroup('SIGTERM');
    await new Promise<void>((resolve) => {
      if (r.proc.exitCode != null) return resolve();
      const t = setTimeout(() => { killGroup('SIGKILL'); resolve(); }, 4000);
      r.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
    return true;
  }
}

export const agentManager = new AgentManager();

export function registerAgentsIpc() {
  ipcMain.handle(IPC.AgentsList, () => agentManager.list());
  ipcMain.handle(IPC.AgentsCreate, (_e, a: { name: string; description: string }) => agentManager.create(a));
  ipcMain.handle(IPC.AgentsImport, (_e, p: string) => agentManager.importFrom(p));
  ipcMain.handle(IPC.AgentsImportPick, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return agentManager.importFrom(r.filePaths[0]);
  });
  ipcMain.handle(IPC.AgentsRun, (_e, args: { slug: string; target?: AgentRunTarget }) =>
    agentManager.run(args.slug, args.target ?? 'local'));
  ipcMain.handle(IPC.AgentsStop, (_e, runId: string) => agentManager.stop(runId));
  ipcMain.handle(IPC.AgentsDelete, (_e, slug: string) => agentManager.delete(slug));
}
