#!/usr/bin/env node
// Headless smoke test for openDev.
// Replays the load-bearing mechanics of the IDE's main process against a
// real workspace, without launching the Electron UI. Used to prove "the
// IDE works" claims with a runnable check.
//
// Usage: SMOKE_WORKSPACE=/path/to/project node scripts/smoke.mjs

import { promises as fs } from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { rgPath } from '@vscode/ripgrep';

const pexec = promisify(exec);
const WORKSPACE = process.env.SMOKE_WORKSPACE;
if (!WORKSPACE) {
  console.error('Set SMOKE_WORKSPACE=/path/to/project to run.');
  process.exit(2);
}
const results = [];
let passed = 0, failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) passed++; else failed++;
  const tag = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (e) {
    record(name, false, e?.message || String(e));
  }
}

async function walkAllFiles(root, max = 50000) {
  const out = [];
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.turbo', '.vite']);
  async function walk(dir) {
    if (out.length >= max) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else { out.push(full); if (out.length >= max) return; }
    }
  }
  await walk(root);
  return out;
}

async function autoDetectServices(root) {
  const candidates = [];
  for (const dir of ['apps', 'packages']) {
    const parent = join(root, dir);
    let entries;
    try { entries = await fs.readdir(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const pkg = JSON.parse(await fs.readFile(join(parent, e.name, 'package.json'), 'utf8'));
        const cmd = pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm run start' : null;
        if (!cmd) continue;
        candidates.push({ id: `auto-${dir}-${e.name}`, name: e.name, command: cmd, cwd: `${dir}/${e.name}` });
      } catch {}
    }
  }
  return candidates;
}

async function listListeningPorts() {
  const { stdout } = await pexec('lsof -nP -iTCP -sTCP:LISTEN -F pcPn', { maxBuffer: 4 * 1024 * 1024 });
  const ports = [];
  let cur = {};
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0]; const val = line.slice(1);
    if (tag === 'p') { if (cur.port && cur.pid) ports.push(cur); cur = { pid: Number(val), protocol: 'tcp' }; }
    else if (tag === 'c') cur.command = val;
    else if (tag === 'n') { const m = val.match(/:(\d+)$/); if (m) cur.port = Number(m[1]); }
    else if (tag === 'P') cur.protocol = val.toLowerCase() === 'udp' ? 'udp' : 'tcp';
  }
  if (cur.port && cur.pid) ports.push(cur);
  return ports;
}

async function startServiceAndWaitForPort(def, root, expectedPort, timeoutMs) {
  const cwd = resolve(root, def.cwd);
  const proc = spawn(def.command, {
    cwd,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  const logs = [];
  let stdoutSeen = false;
  proc.stdout.on('data', b => { stdoutSeen = true; logs.push(b.toString('utf8')); });
  proc.stderr.on('data', b => { stdoutSeen = true; logs.push(b.toString('utf8')); });
  const start = Date.now();
  let found = null;
  try {
    while (Date.now() - start < timeoutMs) {
      const ports = await listListeningPorts();
      const hit = expectedPort ? ports.find(p => p.port === expectedPort) : null;
      if (hit) { found = hit; break; }
      if (proc.exitCode != null) break;
      await new Promise(r => setTimeout(r, 400));
    }
  } finally {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }, 2000);
  }
  return { found, stdoutSeen, logs: logs.join('').slice(-1500), exitCode: proc.exitCode };
}

async function ripgrepFirstMatch(cwd) {
  // Pick a generic token we expect any non-empty project to contain.
  for (const q of ['function', 'import', 'const', 'class', 'def']) {
    const n = await new Promise((resolveP, rejectP) => {
      const p = spawn(rgPath, ['--json', '--max-count', '1', q, '.'], { cwd });
      let count = 0;
      let err = '';
      p.stdout.on('data', (b) => {
        for (const line of b.toString('utf8').split('\n')) {
          if (!line) continue;
          try { if (JSON.parse(line).type === 'match') count++; } catch {}
        }
      });
      p.stderr.on('data', (b) => { err += b.toString('utf8'); });
      p.on('close', (code) => {
        if (code != null && code > 1) rejectP(new Error(`rg exit ${code}: ${err}`));
        else resolveP(count);
      });
    });
    if (n > 0) return { query: q, count: n };
  }
  throw new Error('ripgrep produced no matches for any common token');
}

async function gitWorktreeRoundTrip(root) {
  await pexec('git rev-parse --is-inside-work-tree', { cwd: root });
  const name = `opendev-smoke-${Date.now()}`;
  const wtRoot = join(root, '.opendev', 'worktrees-smoke');
  await fs.mkdir(wtRoot, { recursive: true });
  const wtPath = join(wtRoot, name);
  const branch = `opendev/${name}`;
  try {
    await pexec(`git worktree add -b ${branch} '${wtPath}'`, { cwd: root });
  } finally {
    try { await pexec(`git worktree remove --force '${wtPath}'`, { cwd: root }); } catch {}
    try { await pexec(`git branch -D ${branch}`, { cwd: root }); } catch {}
    try { await fs.rm(wtRoot, { recursive: true, force: true }); } catch {}
  }
  return `worktree create + remove ok (${name})`;
}

async function main() {
  console.log(`\n→ Smoke test against ${WORKSPACE}\n`);

  await check('workspace exists', async () => {
    const st = await fs.stat(WORKSPACE);
    if (!st.isDirectory()) throw new Error('not a directory');
    return WORKSPACE.split('/').slice(-2).join('/');
  });

  let files = [];
  await check('filesystem walk', async () => {
    files = await walkAllFiles(WORKSPACE);
    if (files.length === 0) throw new Error('no files found');
    return `${files.length} files`;
  });

  let services = [];
  await check('auto-detect services', async () => {
    services = await autoDetectServices(WORKSPACE);
    return services.length > 0
      ? `${services.length} services: ${services.map(s => s.name).join(', ')}`
      : 'no services detected (no apps/ or packages/ monorepo layout) — skipping service tests';
  });

  await check('lsof port listing', async () => {
    const ports = await listListeningPorts();
    return `${ports.length} listening ports observed`;
  });

  await check('ripgrep search', async () => {
    const r = await ripgrepFirstMatch(WORKSPACE);
    return `${r.count} files matched "${r.query}"`;
  });

  if (services.length > 0) {
    await check(`service spawn + log capture (${services[0].name})`, async () => {
      const r = await startServiceAndWaitForPort(services[0], WORKSPACE, null, 6_000);
      if (!r.stdoutSeen) throw new Error(`no stdout/stderr captured in 6s (exit=${r.exitCode})`);
      return `captured ${r.logs.length} bytes of output`;
    });
  }

  await check('git worktree round-trip (skipped if no .git)', async () => {
    try {
      await pexec('git rev-parse --is-inside-work-tree', { cwd: WORKSPACE });
    } catch {
      return 'skipped: workspace is not a git repo';
    }
    return gitWorktreeRoundTrip(WORKSPACE);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
