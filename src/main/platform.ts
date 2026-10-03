// The single place OS-level process plumbing lives.
//
// This is the macOS edition: finding an executable, choosing a shell, listing
// who owns a port, killing a process tree — all answered for macOS here so the
// rest of main/ doesn't repeat it. The Windows edition lives on the
// windows-develop / windows-release branches.
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { homedir } from 'os';

/* ------------------------------------------------------------------ shells */

/** Interactive shell for terminal tabs: the user's login shell. */
export function terminalShell(): { file: string; args: string[] } {
  return { file: process.env.SHELL || '/bin/zsh', args: [] };
}

/** Shell for running a service's command line (`spawn(cmd, { shell })`). */
export function commandShell(): string | boolean {
  return true;
}

/* --------------------------------------------------------- executable lookup */

/**
 * Resolve a CLI name to an absolute path by walking PATH ourselves.
 *
 * We don't trust spawn's own lookup because a Finder-launched .app gets a
 * minimal PATH; reporting "not found, here's where we looked" beats an
 * ENOENT surfacing as "[claude cli exited -2]".
 */
export function resolveBinPath(nameOrPath: string): string | null {
  if (isAbsolute(nameOrPath)) return existsSync(nameOrPath) ? nameOrPath : null;
  for (const dir of searchDirs()) {
    const candidate = join(dir, nameOrPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function searchDirs(): string[] {
  const home = homedir();
  const extras = [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin')
  ];
  return [...(process.env.PATH || '').split(delimiter), ...extras].filter(Boolean);
}

/** Is this command available at all? Cheaper than resolveBinPath's full walk for a yes/no. */
export function hasBin(cmd: string): boolean {
  if (resolveBinPath(cmd)) return true;
  // Shell builtins don't exist as files; ask the OS too.
  try {
    const out = execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8', timeout: 2000 });
    return Boolean(out && out.trim());
  } catch { return false; }
}

/* -------------------------------------------------------------------- spawning */

/** Spawn a resolved executable. */
export function spawnBin(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(file, args, options);
}

/* -------------------------------------------------------------- process trees */

/**
 * Spawn options that make a child killable as a whole tree: `detached` puts
 * the shell and its children in a new process group so one signal reaches all
 * of them.
 */
export function detachedSpawnOptions(): { detached: boolean } {
  return { detached: true };
}

/** SIGTERM (or SIGKILL) to a whole process group. Resolves once the request is issued. */
export async function killTree(pid: number, force: boolean): Promise<void> {
  if (!pid) return;
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already exited */ } }
}

/** Kill a flat list of PIDs, hard. Used to reclaim a port. */
export async function killPids(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  await new Promise<void>((resolve) => {
    const p = spawn('kill', ['-9', ...pids.map(String)], { stdio: 'ignore' });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}
