import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

let resolved = false;

const COMMON_BINS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  `${process.env.HOME}/.nvm/versions/node/current/bin`,
  `${process.env.HOME}/.volta/bin`,
  `${process.env.HOME}/.bun/bin`,
  `${process.env.HOME}/.cargo/bin`,
  `${process.env.HOME}/.local/bin`
];

function dedupePath(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(':');
}

function pathFromLoginShell(): string | null {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/zsh';
  // `-ilc` = interactive login command. Sourcing rc files is what `which npm`
  // depends on when the user invokes things from Terminal.
  try {
    const r = spawnSync(shell, ['-ilc', 'echo __ODPATH__$PATH'], {
      timeout: 4000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8'
    });
    const stdout = r.stdout ?? '';
    const m = stdout.match(/__ODPATH__(.+)/);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

export function hydrateShellPath(): void {
  if (resolved) return;
  resolved = true;
  const original = process.env.PATH ?? '';
  const loginPath = pathFromLoginShell();
  const fallback = COMMON_BINS.filter(p => p && existsSync(p));
  const merged = dedupePath([
    ...(loginPath ? loginPath.split(':') : []),
    ...fallback,
    ...original.split(':')
  ]);
  process.env.PATH = merged;
  if (process.env.OPENDEV_VERBOSE === '1') {
    console.log('[shell-env] hydrated PATH:', merged);
  }
}
