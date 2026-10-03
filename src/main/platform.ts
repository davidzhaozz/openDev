// The single place OS differences live.
//
// Everything the IDE does that isn't portable — finding an executable,
// choosing a shell, listing who owns a port, killing a process tree — is
// answered here so the rest of main/ can stay platform-blind. macOS behaviour
// is unchanged; Windows takes the other branch.
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { homedir, userInfo } from 'os';
import { promisify } from 'util';
import { psQuery } from './psHost.js';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const pexecFile = promisify(execFile);

/* --------------------------------------------------------------- home dir */

/**
 * The user's real home directory, taken from the OS rather than the
 * environment.
 *
 * `os.homedir()` is *not* good enough for our purposes: on Windows it returns
 * `%USERPROFILE%` when that variable is set, and on POSIX `$HOME` — so a
 * launcher, a dev shell or a PowerShell profile that exported a different HOME
 * silently relocates every `~`-relative path a child CLI resolves, including
 * `~/.claude` (the Claude CLI's config *and* credential store). Git Bash, WSL
 * interop and roaming-profile setups all do this in practice.
 *
 * `os.userInfo().homedir` reads the account database instead (the process
 * token / GetUserProfileDirectory on Windows, the passwd entry on POSIX), so
 * it cannot be redirected by an inherited variable. It can throw when the user
 * has no passwd entry, so `homedir()` stays as the fallback.
 */
export function realHome(): string {
  try {
    const h = userInfo().homedir;
    if (h) return h;
  } catch { /* no passwd entry — fall through */ }
  return homedir();
}

/* ------------------------------------------------------------------ shells */

/**
 * Turn on PSReadLine's inline history prediction: the dim type-ahead that
 * zsh-autosuggestions gives you on macOS, accepted with Right-arrow or End.
 *
 * This runs in the same pre-prompt phase a profile runs in, so the option is
 * still set once the REPL takes over. Both guards are load-bearing:
 *
 *  - PredictionSource does not exist before PSReadLine 2.1, where the property
 *    reads back as null. `-eq 'None'` is false against null, so an old shell
 *    skips the call instead of printing a parameter-binding error into the
 *    pane. That in-band check is also why there is no separate version probe:
 *    spawning one more process to ask costs seconds on a machine whose EDR
 *    agent inspects process creation (see processParentMap below).
 *  - Any value other than None means the user's own profile already picked a
 *    prediction mode, so we leave their choice alone. pwsh 7.2+ already
 *    defaults to HistoryAndPlugin and falls out here untouched.
 *
 * History itself needs nothing from us — PSReadLine saves incrementally to
 * ConsoleHost_history.txt as each line is accepted, so a tab closed with the
 * PTY still killed underneath it keeps everything typed in it.
 */
const PSREADLINE_INIT =
  "try { if ((Get-PSReadLineOption).PredictionSource -eq 'None') { " +
  'Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView' +
  ' } } catch {}';

/** Interactive shell for terminal tabs. PowerShell 7 wins if it's installed. */
export function terminalShell(): { file: string; args: string[] } {
  if (!IS_WIN) return { file: process.env.SHELL || '/bin/zsh', args: [] };
  // -NoExit keeps the shell interactive after -Command runs; -Command has to
  // come last because it swallows the rest of the command line.
  const psArgs = ['-NoLogo', '-NoExit', '-Command', PSREADLINE_INIT];
  const pwsh = resolveBinPath('pwsh');
  if (pwsh) return { file: pwsh, args: psArgs };
  const powershell = resolveBinPath('powershell');
  if (powershell) return { file: powershell, args: psArgs };
  // cmd.exe has no line-editor prediction to enable.
  return { file: process.env.COMSPEC || 'cmd.exe', args: [] };
}

/**
 * Shell for running a service's command line. `spawn(cmd, { shell })` on
 * Windows expects cmd.exe, which is what npm scripts assume — PowerShell
 * would reject `FOO=bar npm run dev` and mangle `&&`.
 *
 * Deliberately NOT `process.env.COMSPEC`: see systemCmdExe.
 */
export function commandShell(): string | boolean {
  return IS_WIN ? systemCmdExe() : true;
}

/**
 * The real cmd.exe, located from %SystemRoot% rather than %COMSPEC%.
 *
 * COMSPEC is a user-writable variable, and some people point it at
 * powershell.exe/pwsh.exe. That is not a cosmetic difference for us, because
 * of how Node implements `spawn(cmd, { shell: true })`: it takes the shell
 * from COMSPEC, and only passes the cmd.exe flag set `/d /s /c` when the
 * filename actually looks like cmd. Anything else gets `-c` — which
 * PowerShell happily accepts as an abbreviation of `-Command`. So a
 * PowerShell COMSPEC turns every shell-routed spawn into
 * `powershell -c "<command>"`, and *that* loads the user's PowerShell
 * profile before running it.
 *
 * A profile is arbitrary code: `$env:CLAUDE_CONFIG_DIR = ...` or
 * `$env:USERPROFILE = ...` in one would re-inject exactly what cliChildEnv
 * just stripped, after we can no longer see it, and point the Claude CLI at
 * another credential store. Pinning cmd.exe keeps the flags on the `/d /s /c`
 * path too, and `/d` is what suppresses the
 * HKCU\...\Command Processor\AutoRun script — cmd.exe's own equivalent of a
 * profile.
 *
 * Falls back to `true` (Node's own default) only if System32\cmd.exe is
 * somehow missing, which is a broken Windows install rather than a
 * configuration we should support.
 */
export function systemCmdExe(): string | true {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const dir of [join(root, 'System32'), root]) {
    const candidate = join(dir, 'cmd.exe');
    if (existsSync(candidate)) return candidate;
  }
  return true;
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
        join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
        // A zip/portable Node unpacked under ~/.local (node24, node-v22.x, ...)
        // is on nobody's PATH until the user edits it by hand, and an app that
        // was already running when they did still carries the stale copy. Look
        // there directly so "node not found" doesn't hinge on a re-login.
        join(home, '.local', 'bin'),
        ...portableNodeDirs(home)
      ]
    : [
        join(home, '.local', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.volta', 'bin'),
        join(home, '.cargo', 'bin')
      ];
  return [...(process.env.PATH || '').split(delimiter), ...extras].filter(Boolean);
}

/** Portable Node unpacks: any ~/.local/node* directory that really holds node.exe. */
function portableNodeDirs(home: string): string[] {
  try {
    return readdirSync(join(home, '.local'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^node/i.test(e.name))
      .map((e) => join(home, '.local', e.name))
      .filter((d) => existsSync(join(d, 'node.exe')));
  } catch {
    return [];
  }
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

/* ------------------------------------------------------------------- child env */

/**
 * Environment for a CLI we spawn on the user's behalf (claude, codex,
 * opencode, terminal tabs).
 *
 * Starts from our own env — PATH, HOME, locale and user-set API keys all have
 * to survive or the child behaves differently than it would from a terminal —
 * and drops only the vars that would make it behave *wrong*:
 *
 *  - `ELECTRON_*`: a Finder-launched .app passes ELECTRON_RUN_AS_NODE and
 *    friends down; they confuse child tools and leak Electron behaviour into
 *    hook subshells.
 *  - `NODE_OPTIONS`: ours is set for the Electron main process, not for a
 *    child's Node.
 *  - `CLAUDE_CONFIG_DIR`: points the Claude CLI at a different config *and
 *    credential* store. Whoever launched the IDE may have had it set (an
 *    agent session, a dev shell, a PowerShell profile juggling two
 *    accounts), and inheriting it silently runs the user's chat against a
 *    different account than they think they are using. Dropped here and then
 *    re-set below to this account's own `~/.claude`.
 *
 * ...and then pins the home directory itself, because CLAUDE_CONFIG_DIR only
 * decides *which variable* names the store — `~` still decides where it
 * lives. HOME/USERPROFILE are forced to `realHome()` (the account's own
 * directory, per the OS) so `~/.claude` is this user's
 * `~/.claude` no matter what the IDE was launched from. On Windows
 * HOMEDRIVE/HOMEPATH go with them: they are the pair many tools join instead
 * of reading USERPROFILE, so leaving them stale just moves the problem.
 *
 * Names are matched case-insensitively. Windows environment blocks are
 * case-insensitive, so `$env:claude_config_dir` set in a profile arrives as a
 * lowercase key here and would sail past an `===` check while the child still
 * reads it as CLAUDE_CONFIG_DIR.
 */
const DROPPED_CHILD_VARS = new Set(['node_options', 'claude_config_dir']);

/**
 * Set on every CLI child so a shell profile can tell "openDev launched me"
 * from "the user opened a terminal", and leave the pinned credential store
 * alone. See the PowerShell note in WINDOWS.md: a profile that assigns
 * `$env:CLAUDE_CONFIG_DIR` unconditionally re-injects it into any shell the
 * AI spawns *after* we scrubbed it, which no amount of parent-side scrubbing
 * can reach. Guarding the assignment on this variable is the fix, and the
 * guard lives in the profile because the profile is the thing overwriting us.
 */
export const CLAUDE_CONFIG_PIN_MARKER = 'OPENDEV_CLAUDE_CONFIG_PINNED';

export function cliChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    const key = k.toLowerCase();
    if (key.startsWith('electron_')) continue;
    if (DROPPED_CHILD_VARS.has(key)) continue;
    if (key === 'home' || key === 'userprofile') continue;
    if (IS_WIN && (key === 'homedrive' || key === 'homepath')) continue;
    env[k] = v;
  }
  const home = realHome();
  env.HOME = home;
  // Name the store outright instead of deleting the variable and trusting
  // whatever `~` resolves to further down the chain. Same directory the CLI
  // would have picked on its own, but now it survives a hop through a shell
  // or a wrapper that re-derives the home directory, and it is a value the
  // rest of the IDE can point at when explaining which account is in use.
  env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  env[CLAUDE_CONFIG_PIN_MARKER] = '1';
  if (IS_WIN) {
    env.USERPROFILE = home;
    // C:\Users\me -> HOMEDRIVE=C:, HOMEPATH=\Users\me. A UNC home has no
    // drive letter, so leave that pair unset rather than inventing one.
    const m = /^([A-Za-z]:)(.*)$/.exec(home);
    if (m) {
      env.HOMEDRIVE = m[1];
      env.HOMEPATH = m[2] || '\\';
    }
  }
  return env;
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
 *
 * `claude` on Windows is one of those shims, so this is the shell hop the AI
 * chat actually takes — hence the pinned cmd.exe (systemCmdExe) instead of
 * `shell: true`, which would honour a COMSPEC pointing at PowerShell and let
 * a profile rewrite the env we scrubbed in cliChildEnv.
 */
export function spawnBin(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return spawn(line, { ...options, shell: systemCmdExe(), windowsHide: true });
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

// Building a parent/child view of the process table used to cost one child
// process per refresh, and on a machine whose EDR agent inspects every process
// creation that spawn took seconds — measured at 1.5-2.8s here for even a
// trivial PowerShell. That is now served by the resident host in psHost.ts,
// which pays the spawn once per session and answers in ~20ms.
//
// The cache stays regardless: the map is shared by every caller within a TTL
// instead of being rebuilt once per service per poll.
type ParentMap = Map<number, number[]>;
let parentMapCache: { at: number; map: ParentMap } | null = null;
let parentMapInFlight: Promise<ParentMap | null> | null = null;

/**
 * pid -> its direct children, for the whole machine. `null` means the table
 * could not be read — which callers must treat differently from "no children",
 * or a slow query silently reads as "this service owns nothing".
 */
export async function processParentMap(maxAgeMs = 8000): Promise<ParentMap | null> {
  if (!IS_WIN) return null;
  if (parentMapCache && Date.now() - parentMapCache.at < maxAgeMs) return parentMapCache.map;
  if (parentMapInFlight) return parentMapInFlight;
  parentMapInFlight = (async () => {
    try {
      const stdout = await psQuery('pmap');
      // null means the host is unavailable or the query timed out. That is
      // "could not read", which callers must not confuse with "no children".
      if (stdout === null) return null;
      const map: ParentMap = new Map();
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(\d+),(\d+)/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        const kids = map.get(ppid);
        if (kids) kids.push(pid); else map.set(ppid, [pid]);
      }
      if (map.size === 0) return null;
      parentMapCache = { at: Date.now(), map };
      return map;
    } catch {
      return null;
    } finally {
      parentMapInFlight = null;
    }
  })();
  return parentMapInFlight;
}

/** Walk a prebuilt map. Cheap — no process spawn. */
export function descendantsOf(root: number, map: ParentMap): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const child of map.get(out[i]) || []) {
      if (!out.includes(child)) out.push(child);
    }
  }
  return out;
}

/**
 * PIDs of `pid` and everything descended from it. Windows only; POSIX uses
 * process groups. `null` when the process table couldn't be read.
 */
export async function descendantPids(pid: number): Promise<number[] | null> {
  if (!IS_WIN || !pid) return [pid].filter(Boolean);
  const map = await processParentMap();
  return map ? descendantsOf(pid, map) : null;
}

