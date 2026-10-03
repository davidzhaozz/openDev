import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';

let resolved = false;

// Where package managers put things that a GUI-launched process won't have on
// PATH: a Finder-launched .app starts with /usr/bin:/bin:/usr/sbin:/sbin.
function commonBinDirs(): string[] {
  const home = homedir();
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.nvm', 'versions', 'node', 'current', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.local', 'bin')
  ];
}

function dedupePath(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(delimiter);
}

function pathFromLoginShell(): string | null {
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
  const fallback = commonBinDirs().filter(p => p && existsSync(p));
  const merged = dedupePath([
    ...(loginPath ? loginPath.split(delimiter) : []),
    ...fallback,
    ...original.split(delimiter)
  ]);
  process.env.PATH = merged;
  if (process.env.OPENDEV_VERBOSE === '1') {
    console.log('[shell-env] hydrated PATH:', merged);
  }
}
