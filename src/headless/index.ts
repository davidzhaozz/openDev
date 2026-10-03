// Headless test harness — the IDE's main process on plain Node, for CI.
//
// Not a product: OpenDev ships as the desktop app only. Everything under
// src/main/ runs here unchanged (the build aliases 'electron' to
// src/headless/electron.ts), and the IPC channels are carried over a WebSocket
// so scripts/smoke-headless.mjs can exercise the real filesystem, git, search,
// ports, terminal and Python code on whatever OS the CI runner is.
import { createServer } from 'http';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';

import { app, dispatchInvoke, dispatchSync, setBroadcaster } from './electron.js';
import { registerIpc } from '../main/ipc.js';
import { initStorage, getStorageDir } from '../main/storage.js';
import { shutdownAll } from '../main/lifecycle.js';
import { hydrateShellPath } from '../main/shellEnv.js';
import { initFileLogger, getLogPath } from '../main/log.js';
import { startSystemStatsBroadcaster } from '../main/systemStats.js';
import { safeSend } from '../main/safeSend.js';
import { LIMITS } from '../main/limits.js';
import { IPC } from '@shared/ipc';

/* ------------------------------------------------------------------- args */

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}

const PORT = Number(flag('port', process.env.OPENDEV_WEB_PORT || '5199'));
const HOST = flag('host', process.env.OPENDEV_WEB_HOST || '127.0.0.1')!;

/* ------------------------------------------------------------------- auth */

// Whatever reaches this server gets a shell, the filesystem, and the
// user's AI credentials. Access is gated on a token, and the listener binds to
// loopback unless --host says otherwise.
let TOKEN = '';

async function loadToken(): Promise<string> {
  const fromEnvOrFlag = flag('token', process.env.OPENDEV_WEB_TOKEN);
  if (fromEnvOrFlag) return fromEnvOrFlag;
  const tokenFile = join(getStorageDir(), 'web-token');
  try {
    const saved = (await fsp.readFile(tokenFile, 'utf8')).trim();
    if (saved) return saved;
  } catch { /* first run */ }
  const fresh = randomBytes(24).toString('hex');
  await fsp.writeFile(tokenFile, fresh, { mode: 0o600 });
  return fresh;
}

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

function authed(url: URL): boolean {
  const q = url.searchParams.get('token');
  return !!q && timingSafeEqual(q, TOKEN);
}

/* ------------------------------------------------------------------ server */

async function main(): Promise<void> {
  // A Finder-launched terminal or a launchd job has a stripped PATH; every
  // service start and LSP spawn depends on the login shell's version.
  hydrateShellPath();
  initFileLogger();
  await initStorage();
  TOKEN = await loadToken();

  registerIpc();
  startSystemStatsBroadcaster();
  startMemoryWatchdog();

  const clients = new Set<WebSocket>();
  setBroadcaster((channel, args) => {
    const frame = JSON.stringify({ t: 'ev', ch: channel, args });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) { try { ws.send(frame); } catch { /* closing */ } }
    }
  });

  // No pages are served — only the health check and the /rpc upgrade below.
  const http = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const ok = url.pathname === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(ok ? 'ok' : 'not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/rpc' || !authed(url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ t: 'hello', version: app.getVersion(), platform: process.platform }));

    ws.on('message', async (raw) => {
      let msg: { t: string; id?: number; ch?: string; args?: unknown[] };
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.t === 'call' && msg.ch) {
        try {
          const value = await dispatchInvoke(msg.ch, msg.args || []);
          ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, v: value ?? null }));
        } catch (err: any) {
          ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: err?.message || String(err) }));
        }
        return;
      }

      if (msg.t === 'sync' && msg.ch) {
        let value: unknown = null;
        try { value = dispatchSync(msg.ch, msg.args || []) ?? null; } catch { /* stays null */ }
        ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, v: value }));
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  http.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    // smoke-headless.mjs reads the token back out of this line.
    console.log(`  OpenDev headless ${app.getVersion()} http://${shown}:${PORT}/rpc?token=${TOKEN}`);
    console.log(`  log ${getLogPath()}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log('  ! Bound beyond loopback: anyone with the token gets a shell on this machine.');
    }
  });

  let quitting = false;
  const stop = async () => {
    if (quitting) return;
    quitting = true;
    console.log('\nshutting down…');
    const cap = setTimeout(() => process.exit(0), 6000);
    try { await shutdownAll(); } catch (err) { console.error('shutdown error', err); }
    clearTimeout(cap);
    for (const ws of clients) { try { ws.close(); } catch { /* already gone */ } }
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/* -------------------------------------------------------------- watchdog */

// Same contract as the desktop app's watchdog (src/main/index.ts): sample RSS
// and tell the renderer when it crosses a threshold, so the bottom bar can
// warn before the machine starts swapping.
function startMemoryWatchdog(): void {
  let lastLevel: 'ok' | 'warn' | 'critical' = 'ok';
  const timer = setInterval(() => {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const level = rss > LIMITS.rssCriticalBytes ? 'critical' : rss > LIMITS.rssWarnBytes ? 'warn' : 'ok';
    if (level === lastLevel) return;
    lastLevel = level;
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
    if (level !== 'ok') console.warn(`[memory ${level}] rss=${mb(rss)}`);
    safeSend(IPC.MemoryWarning, {
      level,
      rss,
      heapUsed,
      heapTotal,
      message: level === 'critical'
        ? `Memory pressure critical (${mb(rss)} RSS). Restart the headless server.`
        : level === 'warn'
          ? `Memory usage high (${mb(rss)} RSS). Consider closing unused tabs.`
          : ''
    });
  }, 30_000);
  timer.unref?.();
}

main().catch((err) => {
  console.error('[opendev-headless] failed to start', err);
  process.exit(1);
});
