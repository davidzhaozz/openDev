#!/usr/bin/env node
// Cross-platform smoke test for the IDE's main process.
//
// Unlike scripts/smoke.mjs — which re-implements the mechanics it checks —
// this drives the *real* code. The web server in src/server/ runs every module
// under src/main/ on plain Node, so starting it and exercising its IPC
// channels tests the actual filesystem, git, search, ports, terminal and
// Python paths, on whatever OS the runner happens to be.
//
// That's what makes it useful in CI: a Windows runner here proves the Windows
// branches in platform.ts / ports.ts / term.ts work, without anyone owning a
// Windows machine.
//
// Usage: node scripts/smoke-headless.mjs [workspace]   (defaults to this repo)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(process.argv[2] || REPO);
const SERVER = join(REPO, 'out-web', 'server', 'index.mjs');
const PORT = Number(process.env.SMOKE_PORT || 5288);

let passed = 0;
let failed = 0;

function record(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try { record(name, true, await fn()); }
  catch (e) { record(name, false, e?.message || String(e)); }
}

/** Boot the server and resolve once it prints its URL. */
function startServer() {
  return new Promise((resolveP, rejectP) => {
    if (!existsSync(SERVER)) {
      rejectP(new Error(`${SERVER} missing — run "npm run web:build" first`));
      return;
    }
    const proc = spawn(process.execPath, [SERVER, '--port', String(PORT), '--host', '127.0.0.1'], {
      cwd: REPO,
      // A second MCP listener would collide with a running desktop app.
      env: { ...process.env, OPENDEV_MCP_PORT: String(PORT + 1) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      rejectP(new Error(`server did not start within 60s. Output:\n${out}`));
    }, 60_000);
    proc.stdout.on('data', (b) => {
      out += b.toString('utf8');
      const m = out.match(/http:\/\/[^\s]*\?token=([a-f0-9]+)/);
      if (m) { clearTimeout(timer); resolveP({ proc, token: m[1] }); }
    });
    proc.stderr.on('data', (b) => { out += b.toString('utf8'); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      rejectP(new Error(`server exited with ${code}. Output:\n${out}`));
    });
  });
}

function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/rpc?token=${token}`, {
    headers: { origin: `http://127.0.0.1:${PORT}` }
  });
  const pending = new Map();
  const events = [];
  let id = 0;

  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'ev') { events.push(m); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.res(m.v) : p.rej(new Error(m.e));
  });

  const call = (channel, args = []) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ t: 'call', id: n, ch: channel, args }));
    setTimeout(() => { if (pending.delete(n)) rej(new Error(`timeout: ${channel}`)); }, 30_000);
  });

  const ready = new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  return { ws, call, events, ready };
}

async function main() {
  console.log(`\n→ Headless smoke against ${WORKSPACE} (${process.platform})\n`);
  const { proc, token } = await startServer();
  const { ws, call, events, ready } = connect(token);
  await ready;

  try {
    await check('workspace opens', async () => {
      const root = await call('workspace:open', [WORKSPACE]);
      if (!root) throw new Error('no root returned');
      return root;
    });

    await check('file listing', async () => {
      const files = await call('fs:list', []);
      if (!Array.isArray(files) || files.length === 0) throw new Error('empty listing');
      return `${files.length} entries`;
    });

    await check('file read', async () => {
      const text = await call('fs:read', [join(WORKSPACE, 'package.json')]);
      if (!text.includes('"name"')) throw new Error('unexpected contents');
      return `${text.length} bytes`;
    });

    await check('file write + delete round-trip', async () => {
      const probe = join(WORKSPACE, `.opendev-smoke-${Date.now()}.txt`);
      await call('fs:write', [probe, 'smoke']);
      const back = await call('fs:read', [probe]);
      await call('fs:delete', [probe]);
      if (back !== 'smoke') throw new Error(`read back ${JSON.stringify(back)}`);
      return 'ok';
    });

    await check('fuzzy search (ripgrep)', async () => {
      const hits = await call('search:fuzzy', ['package', 20]);
      if (!hits.length) throw new Error('no matches');
      return `${hits.length} hits`;
    });

    await check('git status', async () => {
      const status = await call('git:status');
      if (!Array.isArray(status)) throw new Error('not an array');
      return `${status.length} changed files`;
    });

    await check('listening ports', async () => {
      const ports = await call('ports:list');
      if (!Array.isArray(ports)) throw new Error('not an array');
      // The smoke server itself is listening, so the list can never be empty.
      if (!ports.some((p) => p.port === PORT)) throw new Error(`own port ${PORT} not found in ${ports.length} entries`);
      return `${ports.length} listeners, found own port ${PORT}`;
    });

    await check('terminal spawns and echoes', async () => {
      const term = await call('term:create', [{ cwd: WORKSPACE, cols: 80, rows: 24 }]);
      const marker = `OPENDEV_SMOKE_${Date.now()}`;
      // `echo` exists in every shell we launch: zsh, bash, PowerShell, cmd.
      await call('term:write', [term.id, `echo ${marker}\r`]);
      const deadline = Date.now() + 20_000;
      let seen = '';
      while (Date.now() < deadline) {
        seen = events.filter((e) => e.ch === 'term:data' && e.args[0]?.id === term.id)
          .map((e) => e.args[0].data).join('');
        if (seen.includes(marker)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      await call('term:kill', [term.id]);
      if (!seen.includes(marker)) throw new Error(`no echo after 20s (got ${JSON.stringify(seen.slice(-160))})`);
      return 'pty echo received';
    });

    await check('python interpreters enumerate', async () => {
      const list = await call('python:list', [true]);
      if (!Array.isArray(list)) throw new Error('not an array');
      // Zero is a legitimate answer on a machine with no Python; the point is
      // that detection runs without throwing on this platform.
      return list.length ? `${list.length} found (${list[0].label || list[0].path})` : 'none installed';
    });

    await check('built-in agents materialize', async () => {
      const agents = await call('agents:list');
      if (!agents.length) throw new Error('no agents');
      return agents.map((a) => a.slug).join(', ');
    });

    await check('project templates', async () => {
      const templates = await call('projects:list');
      if (!templates.length) throw new Error('none');
      return `${templates.length} templates`;
    });

    await check('settings round-trip', async () => {
      const before = await call('settings:get');
      if (typeof before !== 'object') throw new Error('not an object');
      return `theme=${before.theme}`;
    });
  } finally {
    try { ws.close(); } catch { /* already closing */ }
    proc.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nsmoke harness failed:', err.message);
  process.exit(1);
});
