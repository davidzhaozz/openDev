// The single place OS differences live.
//
// Everything the IDE does that isn't portable — finding an executable,
// choosing a shell, listing who owns a port, killing a process tree — is
// answered here so the rest of main/ can stay platform-blind. macOS behaviour
// is unchanged; Windows takes the other branch.
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const pexecFile = promisify(execFile);

/* ------------------------------------------------------------------ shells */

/** Interactive shell for terminal tabs. PowerShell 7 wins if it's installed. */
export function terminalShell(): { file: string; args: string[] } {
  if (!IS_WIN) return { file: process.env.SHELL || '/bin/zsh', args: [] };
  const pwsh = resolveBinPath('pwsh');
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
  const powershell = resolveBinPath('powershell');
  if (powershell) return { file: powershell, args: ['-NoLogo'] };
  return { file: process.env.COMSPEC || 'cmd.exe', args: [] };
}

/**
 * Shell for running a service's command line. `spawn(cmd, { shell })` on
 * Windows defaults to cmd.exe, which is what npm scripts expect — PowerShell
 * would reject `FOO=bar npm run dev` and mangle `&&`.
 */
export function commandShell(): string | boolean {
  return IS_WIN ? (process.env.COMSPEC || true) : true;
}

/* --------------------------------------------------------- executable lookup */

/**
 * Resolve a CLI name to an absolute path by walking PATH ourselves.
 *
 * We don't trust spawn's own lookup because a Finder-launched .app gets a
 * minimal PATH; reporting "not found, here's where we looked" beats an
 * ENOENT surfacing as "[claude cli exited -2]". On Windows this also has to
 * try PATHEXT — `npm`, `tsx` and `claude` are all `.cmd` shims there, and a
 * bare `npm` matches nothing on disk.
 */
export function resolveBinPath(nameOrPath: string): string | null {
  if (isAbsolute(nameOrPath)) return existsSync(nameOrPath) ? nameOrPath : null;
  for (const dir of searchDirs()) {
    for (const candidate of withExtensions(join(dir, nameOrPath))) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Every extension a bare command name might actually have on disk. */
export function withExtensions(base: string): string[] {
  if (!IS_WIN) return [base];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  // An explicit extension (`node.exe`) shouldn't get a second one appended.
  if (exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()))) return [base];
  return exts.map((e) => base + e.toLowerCase());
}

function searchDirs(): string[] {
  const home = homedir();
  const extras = IS_WIN
    ? [
        join(home, 'AppData', 'Roaming', 'npm'),
        join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
        join(home, 'scoop', 'shims'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin')
      ]
    : [
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
  // Shell builtins and Store aliases don't exist as files; ask the OS too.
  try {
    const out = IS_WIN
      ? execFileSync('where', [cmd], { encoding: 'utf8', timeout: 2000, windowsHide: true })
      : execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8', timeout: 2000 });
    return Boolean(out && out.trim());
  } catch { return false; }
}

/* -------------------------------------------------------------------- spawning */

// cmd.exe quoting. Wrapping each token in double quotes covers the case that
// actually bites — install paths with spaces, e.g. C:\Program Files\nodejs.
function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Spawn a resolved executable.
 *
 * On Windows most dev CLIs — npm, npx, tsx, claude, codex — are `.cmd` shims,
 * and since the Node 20 CVE fix `spawn()` refuses to execute a batch file
 * without a shell (EINVAL). Routing those through cmd.exe with explicit
 * quoting is the fix; everything else spawns directly, exactly as before.
 */
export function spawnBin(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return spawn(line, { ...options, shell: true, windowsHide: true });
  }
  return spawn(file, args, { ...options, windowsHide: true });
}

/* -------------------------------------------------------------- process trees */

/**
 * Spawn options that make a child killable as a whole tree.
 *
 * POSIX: `detached` puts the shell and its children in a new process group so
 * one signal reaches all of them. Windows has no process groups in that sense
 * — `detached` there would spawn a *console* window per service — so the tree
 * is walked by taskkill at kill time instead.
 */
export function detachedSpawnOptions(): { detached: boolean; windowsHide: boolean } {
  return { detached: !IS_WIN, windowsHide: true };
}

/** SIGTERM-equivalent for a whole tree. Resolves once the request is issued. */
export async function killTree(pid: number, force: boolean): Promise<void> {
  if (!pid) return;
  if (IS_WIN) {
    // /T = the process and its descendants. There is no graceful variant for
    // a console-less child on Windows, so both paths use /F.
    try { await pexecFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }); }
    catch { /* already exited */ }
    return;
  }
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already exited */ } }
}

/** Kill a flat list of PIDs, hard. Used to reclaim a port. */
export async function killPids(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  if (IS_WIN) {
    await Promise.all(pids.map((pid) =>
      pexecFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }).catch(() => {})
    ));
    return;
  }
  await new Promise<void>((resolve) => {
    const p = spawn('kill', ['-9', ...pids.map(String)], { stdio: 'ignore' });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

/** PIDs of `pid` and everything descended from it. Windows only; POSIX uses process groups. */
export async function descendantPids(pid: number): Promise<number[]> {
  if (!IS_WIN || !pid) return [pid].filter(Boolean);
  try {
    // A single WMIC-free query: PowerShell CIM walks the parent links for us.
    const { stdout } = await pexecFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      // Breadth-first walk of the parent links. @() around the query keeps
      // array semantics when a process has exactly one child, or none.
      `$ids=@(${pid}); $i=0; while($i -lt $ids.Count){ $c=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $ids[$i]) | Select-Object -ExpandProperty ProcessId); foreach($x in $c){ if($ids -notcontains $x){ $ids+=$x } }; $i++ }; $ids -join ','`
    ], { timeout: 6000, windowsHide: true });
    return stdout.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [pid];
  }
}
