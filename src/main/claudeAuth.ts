import { ipcMain, shell } from 'electron';
import type { ChildProcess } from 'child_process';
import { IPC } from '@shared/ipc';
import type { ClaudeAuthStatus, ClaudeLoginEvent } from '@shared/types';
import { safeSend } from './safeSend.js';
import { onShutdown } from './lifecycle.js';
import { loadSettings } from './storage.js';
import { cliChildEnv, resolveBinPath, spawnBin, killTree } from './platform.js';

/**
 * Claude account management for Settings → AI.
 *
 * Why this exists rather than "run `claude auth login` in a terminal tab": a
 * tab is the user's own shell, so it deliberately keeps whatever
 * CLAUDE_CONFIG_DIR their profile sets (see ptyEnv in term.ts). The IDE's own
 * AI children do the opposite — cliChildEnv pins the store to `~/.claude`.
 * Logging in from a tab can therefore authenticate a completely different
 * account than the chat then uses, which is the exact confusion this row is
 * meant to end. Everything here runs under cliChildEnv, so the account shown
 * and the account the chat uses are the same by construction.
 *
 * The login itself is the CLI's paste-a-code OAuth flow: `claude auth login`
 * prints an authorize URL, opens a browser, and blocks on stdin waiting for
 * the code the browser hands back. It does that with or without a TTY, so a
 * plain piped child is enough — no PTY needed. We surface the URL and pipe
 * the code back to stdin.
 */

const STATUS_TIMEOUT_MS = 15_000;
// A login is a human walking through a browser consent screen. Generous, but
// not unbounded: an abandoned flow shouldn't leave a child holding stdin open
// for the life of the app.
const LOGIN_TIMEOUT_MS = 10 * 60_000;

function resolveClaudeBin(configured: string): { bin: string } | { error: string } {
  const bin = resolveBinPath(configured);
  if (bin) return { bin };
  return {
    error:
      `Claude CLI '${configured}' not found on PATH. Set Settings → AI → ` +
      `AI CLI paths → Claude to an absolute path (e.g. ` +
      `${process.env.HOME || '~'}/.local/bin/claude), or install Claude Code first.`
  };
}

/** Run a short, non-interactive `claude auth …` subcommand and collect stdout. */
function runAuth(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawnBin(bin, args, { env: cliChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stderr += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
      void killTree(proc.pid ?? 0, true);
      finish(-1);
    }, timeoutMs);
    timer.unref?.();
    proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => { stderr += String(err?.message || err); finish(-1); });
    proc.on('close', (code) => finish(code ?? -1));
  });
}

export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const settings = await loadSettings();
  const configured = settings.claudeCliPath?.trim() || 'claude';
  const r = resolveClaudeBin(configured);
  if ('error' in r) return { loggedIn: false, error: r.error };

  const { code, stdout, stderr } = await runAuth(r.bin, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS);
  // `--json` is the documented default, but an install that prints a banner
  // (update notice, migration warning) would break a whole-stdout parse — so
  // take the JSON object out of the stream instead of trusting all of it.
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      loggedIn: false,
      binPath: r.bin,
      error: `'claude auth status' returned no JSON (exit ${code}). ${(stderr || stdout).trim().slice(0, 400)}`
    };
  }
  try {
    const j = JSON.parse(match[0]) as Record<string, unknown>;
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : undefined);
    return {
      loggedIn: j.loggedIn === true,
      binPath: r.bin,
      email: str('email'),
      orgName: str('orgName'),
      subscriptionType: str('subscriptionType'),
      authMethod: str('authMethod'),
      apiProvider: str('apiProvider'),
      configDirectory: str('configDirectory')
    };
  } catch (e: any) {
    return { loggedIn: false, binPath: r.bin, error: `Couldn't parse 'claude auth status' output: ${e?.message || e}` };
  }
}

/* --------------------------------------------------------------- login flow */

// One login at a time. A second would race the first for the same credential
// file, and the UI has only one place to show a code prompt.
let login: ChildProcess | null = null;
let loginTimer: NodeJS.Timeout | null = null;

function emit(ev: ClaudeLoginEvent): void {
  safeSend(IPC.AiAuthLoginEvent, ev);
}

function endLogin(): void {
  if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
  login = null;
}

export async function startClaudeLogin(
  opts?: { console?: boolean; email?: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (login) return { ok: false, error: 'A sign-in is already in progress.' };
  const settings = await loadSettings();
  const configured = settings.claudeCliPath?.trim() || 'claude';
  const r = resolveClaudeBin(configured);
  if ('error' in r) return { ok: false, error: r.error };

  const args = ['auth', 'login', opts?.console ? '--console' : '--claudeai'];
  const email = opts?.email?.trim();
  if (email) args.push('--email', email);

  const proc = spawnBin(r.bin, args, { env: cliChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  login = proc;
  loginTimer = setTimeout(() => {
    emit({ kind: 'output', chunk: '\n[sign-in timed out — cancelled]\n' });
    void killTree(proc.pid ?? 0, true);
  }, LOGIN_TIMEOUT_MS);
  loginTimer.unref?.();

  // The CLI opens a browser itself, but that fails often enough (a
  // Finder-launched .app with a minimal env, Windows handing the URL to a
  // shim) that we also pull the "if the browser didn't open, visit:" URL out
  // and hand it to the renderer. Emitted once.
  let sawUrl = false;
  // Scan the accumulated text, not the individual chunk: the URL is ~400
  // characters and arrives split across pipe reads often enough that a
  // per-chunk match silently misses it.
  let acc = '';
  const scan = (chunk: string) => {
    emit({ kind: 'output', chunk });
    if (sawUrl) return;
    acc = (acc + chunk).slice(-8000);
    // Stop at whitespace, and also at the closing quote/paren/angle some
    // terminals wrap a link in. Requires a following boundary so a URL still
    // mid-arrival isn't emitted truncated.
    const m = acc.match(/(https:\/\/[^\s"'<>)]*oauth\/authorize[^\s"'<>)]*)\s/);
    if (m) {
      sawUrl = true;
      emit({ kind: 'url', url: m[1] });
    }
  };
  proc.stdout?.on('data', (b: Buffer) => scan(b.toString('utf8')));
  proc.stderr?.on('data', (b: Buffer) => scan(b.toString('utf8')));
  proc.on('error', (err) => {
    emit({ kind: 'output', chunk: `\n[failed to run ${r.bin}: ${err?.message || err}]\n` });
  });
  proc.on('close', async (code) => {
    endLogin();
    // Don't infer success from the CLI's own wording — ask the store. That
    // also refreshes the row to whatever account actually landed on disk.
    const status = await getClaudeAuthStatus();
    emit({ kind: 'done', code: code ?? -1, status });
  });
  return { ok: true };
}

/** Feed the browser's code back to the waiting CLI. */
export function submitClaudeLoginCode(code: string): boolean {
  if (!login?.stdin?.writable) return false;
  // The CLI reads one line. Trim so a paste that picked up surrounding
  // whitespace doesn't submit a stray empty second line.
  login.stdin.write(`${code.trim()}\n`);
  return true;
}

export async function cancelClaudeLogin(): Promise<boolean> {
  const proc = login;
  if (!proc) return false;
  endLogin();
  await killTree(proc.pid ?? 0, true);
  return true;
}

export async function claudeLogout(): Promise<ClaudeAuthStatus> {
  const settings = await loadSettings();
  const configured = settings.claudeCliPath?.trim() || 'claude';
  const r = resolveClaudeBin(configured);
  if ('error' in r) return { loggedIn: false, error: r.error };
  const { code, stdout, stderr } = await runAuth(r.bin, ['auth', 'logout'], STATUS_TIMEOUT_MS);
  const status = await getClaudeAuthStatus();
  // Only surface a logout failure if the account is in fact still signed in —
  // some versions exit non-zero on "already logged out", which isn't an error
  // the user needs to see.
  if (code !== 0 && !status.error && status.loggedIn) {
    status.error = `'claude auth logout' exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`;
  }
  return status;
}

export function registerClaudeAuthIpc(): void {
  ipcMain.handle(IPC.AiAuthStatus, () => getClaudeAuthStatus());
  ipcMain.handle(IPC.AiAuthLoginStart, (_e, opts?: { console?: boolean; email?: string }) => startClaudeLogin(opts));
  ipcMain.handle(IPC.AiAuthLoginSubmit, (_e, code: string) => submitClaudeLoginCode(String(code ?? '')));
  ipcMain.handle(IPC.AiAuthLoginCancel, () => cancelClaudeLogin());
  ipcMain.handle(IPC.AiAuthLogout, () => claudeLogout());
  // Opening the authorize URL is the renderer's to ask for and the main
  // process's to do — an external-scheme window.open from the renderer is
  // blocked by the app's window policy.
  ipcMain.handle(IPC.AiAuthOpenUrl, async (_e, url: string) => {
    if (!/^https:\/\//i.test(String(url || ''))) return false;
    await shell.openExternal(String(url));
    return true;
  });
}

onShutdown(async () => {
  const proc = login;
  if (!proc) return;
  endLogin();
  await killTree(proc.pid ?? 0, true);
});
