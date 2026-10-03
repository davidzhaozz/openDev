// A single, long-lived PowerShell that answers queries over stdin.
//
// Windows has no in-process way to read the process table's parent links, so
// the only options are a child process or a native addon. Spawning
// `powershell.exe` per query is what we used to do, and it is ruinous: the
// CLR cold-starts every time, and an EDR agent that inspects process creation
// inspects each one. Measured on a developer laptop here: 1.5-2.8s of wall
// time and roughly a full core's worth of CPU per spawn. The services panel
// polls every 4s, so the IDE was burning ~35% of a core around the clock doing
// nothing but re-launching PowerShell.
//
// So we launch it once and keep it. Queries are newline-delimited commands on
// stdin; each reply is terminated by a sentinel line. Steady-state cost of a
// full process-table read drops from ~2800ms to ~17ms.
//
// Inside that resident host we P/Invoke CreateToolhelp32Snapshot, which is the
// actual kernel call for "list processes and their parents" — WMI's
// Win32_Process answers the same question but populates far more per row and
// costs ~330ms. If Add-Type can't compile (locked-down .NET, no csc), the host
// silently falls back to the WMI query, which is still a ~10x win over
// spawning. Everything here is a no-op off Windows.
//
// The host script lives in resources/procmap.ps1 and is run with -File. It
// used to be inlined here and passed to -EncodedCommand, which worked fine but
// is one of the highest-signal indicators an EDR agent looks for: base64 on a
// PowerShell command line is how obfuscated payloads are delivered, so the
// IDE's steady-state behaviour looked like a loader re-arming itself every few
// seconds. Nothing here needs hiding, so it ships as a readable file instead.
//
// -Command with the script on stdin is the other way to avoid base64, and it
// does not work for us: stdin is already the query channel this host reads
// with [Console]::In.ReadLine(), and -Command - makes PowerShell consume that
// same stream as its script text. Piping the script through an environment
// variable and Invoke-Expression avoids both problems and is, as far as an EDR
// is concerned, exactly as suspicious as the base64 we started with.
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { onShutdown } from './lifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deliberately not imported from platform.ts: that module is this one's only
// consumer, and taking the constant from it would close an import cycle for
// the sake of a one-line predicate.
const IS_WIN = process.platform === 'win32';

// Both are duplicated as literals in resources/procmap.ps1, which no longer
// goes through a TS template and so cannot interpolate them. Change one,
// change the other.
const SENTINEL = '<<OPENDEV-EOF>>';
const READY = '<<OPENDEV-READY>>';

// Startup has to compile the P/Invoke shim; steady-state queries are ~20ms.
const READY_TIMEOUT_MS = 20000;
const QUERY_TIMEOUT_MS = 15000;
// A host that dies repeatedly is a host that is never going to work (no
// PowerShell on PATH, policy blocking it). Stop trying and let callers fall
// back rather than spawning in a loop — the spawn is the expensive part.
const MAX_RESTARTS = 3;

/**
 * resources/procmap.ps1, wherever it landed for this build.
 *
 * Packaged, electron-builder's extraResources puts it directly in
 * <resourcesPath> — outside the asar, because PowerShell cannot open a -File
 * path inside an archive. In dev, electron-vite has built us to out/main, so
 * the repo's resources/ is two levels up. Mirrors the resolution lsp.ts does
 * for its unpacked server binaries.
 */
function resolveScriptPath(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'procmap.ps1') : null,
    join(__dirname, '..', '..', 'resources', 'procmap.ps1')
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

type Pending = {
  resolve: (out: string | null) => void;
  timer: NodeJS.Timeout;
};

let proc: ChildProcess | null = null;
let ready: Promise<boolean> | null = null;
let buf = '';
let restarts = 0;
let disposed = false;
const queue: Pending[] = [];

/** Fail every in-flight query and drop the host. Next query restarts it. */
function teardown(): void {
  const p = proc;
  proc = null;
  ready = null;
  buf = '';
  while (queue.length > 0) {
    const q = queue.shift()!;
    clearTimeout(q.timer);
    q.resolve(null);
  }
  if (p) {
    try { p.stdin?.end(); } catch { /* already gone */ }
    try { p.kill(); } catch { /* already gone */ }
  }
}

function onStdout(chunk: string): void {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf(SENTINEL)) !== -1) {
    const reply = buf.slice(0, i);
    buf = buf.slice(i + SENTINEL.length).replace(/^\r?\n/, '');
    const q = queue.shift();
    if (q) {
      clearTimeout(q.timer);
      q.resolve(reply);
    }
  }
}

function start(): Promise<boolean> {
  if (ready) return ready;
  if (disposed || !IS_WIN || restarts >= MAX_RESTARTS) return Promise.resolve(false);

  ready = new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (!ok) teardown();
      resolve(ok);
    };

    // A missing script is not a transient failure — burn the whole restart
    // budget so callers fall back immediately instead of re-checking a path
    // that will not appear.
    const scriptPath = resolveScriptPath();
    if (!scriptPath) {
      restarts = MAX_RESTARTS;
      done(false);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn('powershell', [
        '-NoProfile', '-NonInteractive', '-NoLogo',
        // -File, not -EncodedCommand: see the note at the top of this file.
        // The script is signed at build time, so an AllSigned execution policy
        // (or a Mark-of-the-Web on the installed copy) still lets it run.
        '-File', scriptPath
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      restarts += 1;
      done(false);
      return;
    }

    proc = child;
    // Keeping a PowerShell alive must not hold the app open at quit time.
    child.unref();
    child.stdout?.setEncoding('utf8');
    // PowerShell serializes its error stream as CLIXML noise; none of it is
    // actionable and reading it only matters so the pipe never fills up.
    child.stderr?.resume();

    const readyTimer = setTimeout(() => {
      restarts += 1;
      done(false);
    }, READY_TIMEOUT_MS);

    const waitForReady = (chunk: string) => {
      buf += chunk;
      const at = buf.indexOf(READY);
      if (at === -1) return;
      buf = buf.slice(at + READY.length).replace(/^\r?\n/, '');
      clearTimeout(readyTimer);
      child.stdout?.off('data', waitForReady);
      child.stdout?.on('data', onStdout);
      done(true);
    };
    child.stdout?.on('data', waitForReady);

    child.on('error', () => { restarts += 1; clearTimeout(readyTimer); done(false); });
    child.on('exit', () => {
      clearTimeout(readyTimer);
      // Only an unexpected death counts against the restart budget; a
      // teardown() we initiated has already cleared `proc`.
      if (proc === child) {
        restarts += 1;
        teardown();
      }
      done(false);
    });
  });

  return ready;
}

/**
 * Run one query against the resident host. Resolves `null` if the host is
 * unavailable or the query times out — callers must treat that as "could not
 * read", never as "the answer is empty".
 */
export async function psQuery(cmd: string): Promise<string | null> {
  if (!IS_WIN || disposed) return null;
  if (!(await start())) return null;
  const child = proc;
  if (!child?.stdin?.writable) return null;

  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      // A late reply would be matched against the *next* query and silently
      // return the wrong answer, so a timeout costs us the whole host.
      const at = queue.findIndex((q) => q.timer === timer);
      if (at !== -1) queue.splice(at, 1);
      resolve(null);
      teardown();
    }, QUERY_TIMEOUT_MS);

    queue.push({ resolve, timer });
    try {
      child.stdin!.write(`${cmd}\n`);
    } catch {
      clearTimeout(timer);
      const at = queue.findIndex((q) => q.timer === timer);
      if (at !== -1) queue.splice(at, 1);
      resolve(null);
      teardown();
    }
  });
}

onShutdown(() => {
  disposed = true;
  teardown();
});
