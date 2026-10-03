import { app, session, webContents } from 'electron';
import type { BrowserTokenInfo } from '@shared/types';

// Bearer tokens borrowed from the browser panel, so a REST request can run as
// whoever is signed in there without anyone copying a token out of DevTools.
//
// Two feeds:
//   1. Request headers. Every `Authorization: Bearer …` a <webview> sends is
//      remembered against the origin it was sent to — which is the API host,
//      not the page, and is exactly what a REST request to that API needs.
//   2. Web storage, on demand. An SPA that has signed in but not yet made a
//      call has its token sitting in local/sessionStorage (MSAL, Auth0 and
//      friends all do this); a scan picks JWTs out of it.
//
// Tokens live in memory only. The renderer and MCP get a masked preview; the
// raw value leaves main only when the user explicitly copies it into a
// request, or when rest.ts resolves an `auth: {kind:'browser'}` at send time.

type Captured = {
  token: string;
  origin: string;
  url: string;
  seenAt: number;
  source: 'header' | 'storage';
  expiresAt?: number;
};

/** Keyed by `${source}|${origin}` so a header capture never loses to a storage one. */
const captured = new Map<string, Captured>();
const hookedSessions = new WeakSet<object>();

function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

/** JWT `exp` in ms, or undefined for an opaque token. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
}

function remember(c: Omit<Captured, 'expiresAt'>): void {
  captured.set(`${c.source}|${c.origin}`, { ...c, expiresAt: jwtExpiry(c.token) });
}

function preview(token: string): string {
  return token.length <= 16 ? '•'.repeat(token.length) : `${token.slice(0, 8)}…${token.slice(-6)}`;
}

function toInfo(c: Captured): BrowserTokenInfo {
  return { origin: c.origin, url: c.url, seenAt: c.seenAt, source: c.source, preview: preview(c.token), expiresAt: c.expiresAt };
}

function hookSession(contents: Electron.WebContents): void {
  const ses = contents.session;
  if (!ses || hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  // A session gets ONE onBeforeSendHeaders listener — registering another
  // replaces this one. Nothing else in main hooks it today; anything that
  // needs to later has to go through here. The webview shares the default
  // session with the IDE window, hence the webview-only filter.
  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try {
      if (details.webContents?.getType() === 'webview') {
        const auth = Object.entries(details.requestHeaders)
          .find(([k]) => k.toLowerCase() === 'authorization')?.[1];
        const m = auth && /^Bearer\s+(\S+)$/i.exec(auth);
        const origin = originOf(details.url);
        if (m && origin) remember({ token: m[1], origin, url: details.url, seenAt: Date.now(), source: 'header' });
      }
    } catch { /* never let capture break a request */ }
    callback({ requestHeaders: details.requestHeaders });
  });
}

// Runs inside the webview. Returns every JWT-shaped string in web storage,
// with the key it came from so access tokens can win over id tokens.
const STORAGE_SCAN_SCRIPT = `(() => {
  const re = /eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}/g;
  const out = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) || '';
        const val = store.getItem(key) || '';
        for (const m of val.match(re) || []) out.push({ key, token: m });
      }
    } catch (e) { /* storage blocked for this origin */ }
  }
  return { url: location.href, hits: out };
})()`;

/** Pull JWTs out of every live webview's storage. Returns how many were found. */
export async function scanBrowserStorage(): Promise<number> {
  let found = 0;
  let views: Electron.WebContents[] = [];
  try { views = webContents.getAllWebContents().filter((w) => w.getType() === 'webview') as Electron.WebContents[]; }
  catch { return 0; }
  for (const wc of views) {
    try {
      const r = await wc.executeJavaScript(STORAGE_SCAN_SCRIPT) as { url: string; hits: Array<{ key: string; token: string }> };
      const origin = originOf(r?.url || '');
      if (!origin || !r.hits?.length) continue;
      const now = Date.now();
      // Prefer an unexpired access token; an id token is for the SPA, not the API.
      const ranked = r.hits
        .map((h) => ({ ...h, exp: jwtExpiry(h.token) ?? Infinity }))
        .filter((h) => h.exp > now)
        .sort((a, b) => {
          const acc = (k: string) => (/access/i.test(k) ? 0 : /id.?token/i.test(k) ? 2 : 1);
          return acc(a.key) - acc(b.key) || b.exp - a.exp;
        });
      if (!ranked.length) continue;
      remember({ token: ranked[0].token, origin, url: r.url, seenAt: now, source: 'storage' });
      found++;
    } catch { /* page mid-navigation */ }
  }
  return found;
}

function live(c: Captured): boolean {
  return c.expiresAt == null || c.expiresAt > Date.now();
}

/**
 * The token a request to `targetUrl` should borrow. With `pinnedOrigin`, only
 * that origin qualifies. Otherwise: the request's own origin first (header,
 * then storage), then the most recent capture of any origin — a SPA on :3000
 * calling an API on :8080 is the normal case, and the header capture is keyed
 * by the API, so the exact match usually hits.
 */
function pick(targetUrl: string, pinnedOrigin?: string): Captured | null {
  const all = [...captured.values()].sort((a, b) => b.seenAt - a.seenAt);
  const pool = all.filter(live).length ? all.filter(live) : all;
  if (pinnedOrigin) {
    const want = originOf(pinnedOrigin) ?? pinnedOrigin;
    return pool.find((c) => c.origin === want && c.source === 'header')
      ?? pool.find((c) => c.origin === want) ?? null;
  }
  const target = originOf(targetUrl);
  return pool.find((c) => c.origin === target && c.source === 'header')
    ?? pool.find((c) => c.origin === target)
    ?? pool.find((c) => c.source === 'header')
    ?? pool[0] ?? null;
}

/** Resolve a raw token for sending, scanning storage once if nothing is held. */
export async function resolveBrowserToken(targetUrl: string, pinnedOrigin?: string): Promise<string | null> {
  let hit = pick(targetUrl, pinnedOrigin);
  if (!hit) { await scanBrowserStorage(); hit = pick(targetUrl, pinnedOrigin); }
  return hit?.token ?? null;
}

/**
 * Cookie-session fallback. Apps like next-auth keep the session in an httpOnly
 * cookie and never send a bearer, so neither feed above sees anything. The
 * webview shares the default session, so its cookie jar is right here; this
 * returns a ready `Cookie` header for `targetUrl`, or null when there are none.
 */
export async function browserCookieHeader(targetUrl: string): Promise<{ header: string; count: number } | null> {
  if (!originOf(targetUrl)) return null;
  try {
    const jar = await session.defaultSession.cookies.get({ url: targetUrl });
    if (!jar.length) return null;
    return { header: jar.map((c) => `${c.name}=${c.value}`).join('; '), count: jar.length };
  } catch { return null; }
}

export function listBrowserTokens(): BrowserTokenInfo[] {
  return [...captured.values()].sort((a, b) => b.seenAt - a.seenAt).map(toInfo);
}

/** Which capture `targetUrl` would borrow right now — for the Auth tab's preview. */
export function previewBrowserToken(targetUrl: string, pinnedOrigin?: string): BrowserTokenInfo | null {
  const hit = pick(targetUrl, pinnedOrigin);
  return hit ? toInfo(hit) : null;
}

export function installBrowserTokenCapture(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') hookSession(contents);
  });
}
