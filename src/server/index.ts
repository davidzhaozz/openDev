// OpenDev Web — the IDE's main process, served to a browser.
//
// Everything under src/main/ runs here unchanged (the build aliases 'electron'
// to src/server/electron.ts). This file replaces the two things Electron used
// to provide: a window to render into, and an IPC channel to reach it. The
// window becomes a static bundle of the same renderer; the IPC channel becomes
// a WebSocket.
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createReadStream, existsSync, promises as fsp, statSync } from 'fs';
import { extname, join, normalize, resolve } from 'path';
import { randomBytes } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';

import { app, dispatchInvoke, dispatchSync, setBroadcaster } from './electron.js';
import { registerIpc } from '../main/ipc.js';
import { initStorage, getStorageDir } from '../main/storage.js';
import { shutdownAll } from '../main/lifecycle.js';
import { hydrateShellPath } from '../main/shellEnv.js';
import { initFileLogger, getLogPath } from '../main/log.js';
import { registerRemoteFilesIpc } from './remoteFiles.js';
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
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const PORT = Number(flag('port', process.env.OPENDEV_WEB_PORT || '5199'));
const HOST = flag('host', process.env.OPENDEV_WEB_HOST || '127.0.0.1')!;
const WEB_ROOT = resolve(flag('web-root', process.env.OPENDEV_WEB_ROOT || join(app.getAppPath(), 'out-web', 'renderer'))!);

/* ------------------------------------------------------------------- auth */

// A browser tab that reaches this server gets a shell, the filesystem, and the
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

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'od_token') return decodeURIComponent(v.join('='));
  }
  return null;
}

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

function authed(req: IncomingMessage, url: URL): 'ok' | 'query' | 'no' {
  const cookie = cookieToken(req);
  if (cookie && timingSafeEqual(cookie, TOKEN)) return 'ok';
  const q = url.searchParams.get('token');
  if (q && timingSafeEqual(q, TOKEN)) return 'query';
  return 'no';
}

// Cross-site WebSocket hijacking guard: a cookie-authenticated upgrade must
// come from a page this server served.
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, tests)
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/* ------------------------------------------------------------- static files */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

function serveFile(res: ServerResponse, file: string): void {
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    // Hashed asset filenames are immutable; index.html must not be cached or
    // a rebuild leaves stale script tags behind.
    'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable'
  });
  const stream = createReadStream(file);
  // Without this an unreadable file takes the whole server down with an
  // unhandled 'error' event.
  stream.on('error', () => res.end());
  stream.pipe(res);
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>OpenDev Web</title>
<body style="background:#1e1e1e;color:#d4d4d4;font:14px -apple-system,BlinkMacSystemFont,sans-serif;padding:48px">
<h2 style="color:#f48771;margin:0 0 8px">${code}</h2><p>${message}</p></body>`);
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
  registerRemoteFilesIpc();
  startSystemStatsBroadcaster();
  startMemoryWatchdog();

  const clients = new Set<WebSocket>();
  setBroadcaster((channel, args) => {
    const frame = JSON.stringify({ t: 'ev', ch: channel, args });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) { try { ws.send(frame); } catch { /* closing */ } }
    }
  });

  const http = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const auth = authed(req, url);
    if (auth === 'no') {
      deny(res, 401, 'Missing or invalid access token. Open the URL printed by <code>npm run web</code>.');
      return;
    }
    if (auth === 'query') {
      // Move the token out of the URL bar (and out of Referer headers) as soon
      // as the first request lands.
      url.searchParams.delete('token');
      res.writeHead(302, {
        'set-cookie': `od_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        location: url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : ''),
        'cache-control': 'no-store'
      });
      res.end();
      return;
    }

    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(WEB_ROOT, rel);
    if (!file.startsWith(WEB_ROOT)) { deny(res, 403, 'Forbidden'); return; }
    // Anything that isn't a real file — including a directory — falls back to
    // the app shell, which is also how ?popout=… URLs get served.
    if (!isFile(file)) file = join(WEB_ROOT, 'index.html');
    if (!existsSync(file)) {
      deny(res, 500, 'Web bundle not found. Run <code>npm run web:build</code> first.');
      return;
    }
    serveFile(res, file);
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/rpc' || authed(req, url) === 'no' || !sameOrigin(req)) {
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
    const url = `http://${shown}:${PORT}/?token=${TOKEN}`;
    console.log('');
    console.log(`  OpenDev Web ${app.getVersion()}`);
    console.log(`  ${url}`);
    console.log(`  serving ${WEB_ROOT}`);
    console.log(`  log ${getLogPath()}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log('');
      console.log('  ! Bound beyond loopback. Anyone who reaches this port and has the');
      console.log('    token gets a shell on this machine. Put it behind a VPN or TLS proxy.');
    }
    console.log('');
    if (hasFlag('open')) {
      import('child_process').then(({ spawn }) => {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
      });
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
        ? `Memory pressure critical (${mb(rss)} RSS). Close some tabs/services or restart the server.`
        : level === 'warn'
          ? `Memory usage high (${mb(rss)} RSS). Consider closing unused tabs.`
          : ''
    });
  }, 30_000);
  timer.unref?.();
}

main().catch((err) => {
  console.error('[opendev-web] failed to start', err);
  process.exit(1);
});
