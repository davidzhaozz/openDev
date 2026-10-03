import { app, ipcMain, webContents } from 'electron';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { NetEntry, NetEntrySummary, NetSource } from '@shared/types';
import { safeSend } from './safeSend.js';

// Unified network log behind the NETWORK tab.
//
// Two feeds land in one list:
//   1. The IDE's own HTTP — captured by wrapping `globalThis.fetch` once.
//      Every current call site (REST client, Jira, Elasticsearch, local LLM
//      probes) and every future one goes through it for free, including the
//      AI SDKs, which use global fetch under the hood.
//   2. The browser panel — captured over the Chrome DevTools Protocol, which
//      is the only route that yields response *bodies*; webRequest gives
//      headers and timing but never the payload.
//
// Headers, URLs and bodies are kept verbatim — the same thing Chrome DevTools
// shows for the same traffic. Bodies are capped only so a large download can't
// sit in main's memory.

/** Rows kept in the ring. Old ones fall off the front. */
const MAX_ENTRIES = 500;
/** Per-body cap. Anything past this is dropped and the row says so. */
const MAX_BODY = 256 * 1024;
/**
 * Budget for all retained bodies together. Without it the ring could pin
 * MAX_ENTRIES × 2 × MAX_BODY (~250 MB) in main. Past it, the oldest rows
 * give up their bodies first; their URL, status, headers and timing stay.
 */
const MAX_TOTAL_BODY = 32 * 1024 * 1024;
const BODY_DROPPED = '<body dropped: older than the capture memory budget>';

const entries: NetEntry[] = [];
const byId = new Map<string, NetEntry>();
let capturing = true;

/* ------------------------------------------------------------- the store */

function summarize(e: NetEntry): NetEntrySummary {
  const { requestHeaders, requestBody, requestBodyTruncated, responseHeaders, responseBody, responseBodyTruncated, ...rest } = e;
  return rest;
}

function splitUrl(raw: string): { host: string; path: string } {
  try {
    const u = new URL(raw);
    return { host: u.host, path: `${u.pathname}${u.search}` || '/' };
  } catch { return { host: '', path: raw }; }
}

function bodyBytes(e: NetEntry): number {
  return (e.requestBody?.length ?? 0) + (e.responseBody?.length ?? 0);
}

function enforceBodyBudget(): void {
  let total = 0;
  for (const e of entries) total += bodyBytes(e);
  for (const e of entries) {
    if (total <= MAX_TOTAL_BODY) return;
    if (e.pending) continue;
    const n = bodyBytes(e);
    if (n <= BODY_DROPPED.length * 2) continue;
    if (e.requestBody) { e.requestBody = BODY_DROPPED; e.requestBodyTruncated = true; }
    if (e.responseBody) { e.responseBody = BODY_DROPPED; e.responseBodyTruncated = true; }
    total -= n - bodyBytes(e);
  }
}

function add(e: NetEntry): void {
  entries.push(e);
  byId.set(e.id, e);
  while (entries.length > MAX_ENTRIES) {
    const dropped = entries.shift();
    if (dropped) byId.delete(dropped.id);
  }
  enforceBodyBudget();
  safeSend(IPC.NetworkEntry, summarize(e));
}

function patch(id: string, p: Partial<NetEntry>): void {
  const e = byId.get(id);
  if (!e) return;
  Object.assign(e, p);
  if (p.responseBody !== undefined || p.requestBody !== undefined) enforceBodyBudget();
  safeSend(IPC.NetworkEntry, summarize(e));
}

/* ---------------------------------------------------------- origin tagging */

// Which subsystem is making the call. An async-local tag beats sniffing the
// URL: the same host can serve the REST client and a Jira integration, and
// only the caller actually knows which is which.
const originStore = new AsyncLocalStorage<string>();

/** Tag every fetch made inside `fn` with `origin`. */
export function withNetOrigin<T>(origin: string, fn: () => T): T {
  return originStore.run(origin, fn);
}

/**
 * A `fetch` that labels its calls in the network log. Call sites swap one
 * identifier (`fetch(` → `esFetch(`) instead of wrapping a multi-line call,
 * and behave exactly like fetch otherwise.
 */
export function netFetch(origin: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    withNetOrigin(origin, () => globalThis.fetch(input, init));
}

/** Fallback for calls made outside a tagged scope (SDKs, stray helpers). */
function guessOrigin(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('atlassian.net') || u.includes('/rest/api/')) return 'jira';
  if (u.includes('api.anthropic.com') || u.includes('api.openai.com')) return 'ai';
  if (/\/_(search|bulk|cat|mapping|doc)\b/.test(u) || u.includes(':9200')) return 'es';
  if (u.includes('/v1/chat/completions') || u.includes('/v1/models') || u.includes(':11434')) return 'llm';
  return 'http';
}

/* ------------------------------------------------------- IDE fetch capture */

function headersToObject(h: HeadersInit | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  try {
    if (typeof (h as Headers).forEach === 'function' && !Array.isArray(h)) {
      (h as Headers).forEach((v, k) => { out[k] = v; });
      return out;
    }
    if (Array.isArray(h)) {
      for (const [k, v] of h as Array<[string, string]>) out[String(k)] = String(v);
      return out;
    }
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k] = String(v);
  } catch { /* exotic header bag — better an empty map than a thrown request */ }
  return out;
}

/**
 * A NUL byte in a utf8 decode means the payload was never text. Only the
 * head is scanned — binary formats announce themselves in the first few
 * bytes, and this runs on every captured response.
 */
function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 4096);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true;
  return false;
}

function describeBody(body: unknown): { text?: string; truncated?: boolean } {
  if (body == null) return {};
  try {
    if (typeof body === 'string') {
      return body.length > MAX_BODY
        ? { text: body.slice(0, MAX_BODY), truncated: true }
        : { text: body };
    }
    if (body instanceof URLSearchParams) return { text: body.toString() };
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      const buf = Buffer.from(body as Uint8Array);
      // Only decode what is plausibly text; a PNG upload as mojibake helps
      // nobody and costs a megabyte of renderer string.
      const slice = buf.subarray(0, Math.min(buf.length, MAX_BODY));
      const text = slice.toString('utf8');
      const printable = !looksBinary(text);
      return printable
        ? { text, truncated: buf.length > MAX_BODY }
        : { text: `<binary, ${buf.length} bytes>` };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) return { text: '<form-data>' };
    return { text: '<stream>' };
  } catch { return { text: '<unreadable>' }; }
}

/**
 * Read a response body without disturbing the caller's copy, stopping at the
 * cap. The clone has to be taken synchronously — once the caller starts
 * reading, cloning throws.
 */
async function readCapped(res: Response): Promise<{ text?: string; truncated?: boolean; size?: number }> {
  const ct = res.headers.get('content-type') || '';
  // Server-sent events never "finish"; teeing one would buffer the whole
  // conversation in main for as long as it runs.
  if (/text\/event-stream/i.test(ct)) return { text: '<streaming response — body not captured>' };
  if (!res.body) return { size: 0 };

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (!truncated) {
          const room = MAX_BODY - chunks.reduce((n, c) => n + c.length, 0);
          if (room <= 0) truncated = true;
          else if (value.byteLength > room) { chunks.push(Buffer.from(value.subarray(0, room))); truncated = true; }
          else chunks.push(Buffer.from(value));
        }
      }
    }
  } catch {
    truncated = true;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const buf = Buffer.concat(chunks);
  const text = buf.toString('utf8');
  return { text: looksBinary(text) ? `<binary, ${total} bytes>` : text, truncated, size: total };
}

/** Wrap global fetch. Idempotent — a second call is a no-op. */
export function installFetchCapture(): void {
  const original = globalThis.fetch;
  if (!original || (original as unknown as { __opendevNetlog?: boolean }).__opendevNetlog) return;

  const wrapped: typeof fetch = async (input, init) => {
    if (!capturing) return original(input as RequestInfo, init);

    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    const method = (init?.method || (input as Request)?.method || 'GET').toUpperCase();
    const reqHeaders = headersToObject(init?.headers ?? (input as Request)?.headers);
    const reqBody = describeBody(init?.body);
    const { host, path } = splitUrl(url);

    const id = randomUUID();
    const startedAt = Date.now();
    add({
      id,
      source: 'ide' as NetSource,
      origin: originStore.getStore() || guessOrigin(url),
      method, url, host, path,
      startedAt,
      pending: true,
      requestHeaders: reqHeaders,
      requestBody: reqBody.text,
      requestBodyTruncated: reqBody.truncated
    });

    try {
      const res = await original(input as RequestInfo, init);
      // Clone now, read later — awaiting the body here would add its download
      // time to every call the IDE makes.
      let probe: Response | null = null;
      try { probe = res.clone(); } catch { probe = null; }

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });
      patch(id, {
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - startedAt,
        contentType: res.headers.get('content-type') || undefined,
        responseHeaders,
        pending: !!probe
      });

      if (probe) {
        void readCapped(probe)
          .then((b) => patch(id, {
            responseBody: b.text,
            responseBodyTruncated: b.truncated,
            responseSize: b.size,
            pending: false
          }))
          .catch(() => patch(id, { pending: false }));
      }
      return res;
    } catch (err: any) {
      patch(id, {
        pending: false,
        durationMs: Date.now() - startedAt,
        error: err?.message || String(err)
      });
      throw err;
    }
  };

  (wrapped as unknown as { __opendevNetlog?: boolean }).__opendevNetlog = true;
  globalThis.fetch = wrapped;
}

/* --------------------------------------------------- browser panel capture */

// API calls only. Page navigations, scripts, stylesheets, images, fonts and
// media are all deliberately absent — this panel is for the calls an app
// makes, not for everything the network happens to carry.
const BROWSER_TYPES = new Set(['XHR', 'Fetch', 'EventSource', 'WebSocket']);

type Attached = { detach: () => void };
const attached = new Map<number, Attached>();

function attachDebugger(wc: Electron.WebContents): void {
  if (attached.has(wc.id)) return;
  try {
    wc.debugger.attach('1.3');
  } catch (err: any) {
    // Almost always "another debugger is already attached" — i.e. the user
    // has DevTools open on the browser panel. Their tools win; we skip.
    console.log('[netlog] browser capture unavailable:', err?.message || err);
    return;
  }

  // CDP request id → our entry id.
  const live = new Map<string, string>();

  const onMessage = (_e: unknown, method: string, params: any) => {
    try {
      if (method === 'Network.requestWillBeSent') {
        const type = params.type || 'Other';
        if (!BROWSER_TYPES.has(type)) return;
        const url = params.request?.url || '';
        if (/^(data|blob|chrome-extension):/i.test(url)) return;
        const { host, path } = splitUrl(url);
        const id = randomUUID();
        live.set(params.requestId, id);
        const body = describeBody(params.request?.postData);
        add({
          id,
          source: 'browser',
          origin: 'browser',
          method: (params.request?.method || 'GET').toUpperCase(),
          url, host, path,
          startedAt: Date.now(),
          pending: true,
          resourceType: String(type).toLowerCase(),
          requestHeaders: params.request?.headers || {},
          requestBody: body.text,
          requestBodyTruncated: body.truncated
        });
        return;
      }

      const id = live.get(params?.requestId);
      if (!id) return;

      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        patch(id, {
          status: r.status,
          statusText: r.statusText,
          contentType: r.mimeType,
          responseHeaders: r.headers || {}
        });
        return;
      }

      if (method === 'Network.loadingFinished') {
        const entry = byId.get(id);
        const startedAt = entry?.startedAt ?? Date.now();
        patch(id, { durationMs: Date.now() - startedAt, responseSize: params.encodedDataLength });
        wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then((r: any) => {
            const raw: string = r?.body ?? '';
            const text = r?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
            const truncated = text.length > MAX_BODY;
            patch(id, {
              responseBody: looksBinary(text) ? '<binary response>' : (truncated ? text.slice(0, MAX_BODY) : text),
              responseBodyTruncated: truncated,
              pending: false
            });
          })
          .catch(() => patch(id, { pending: false }));
        live.delete(params.requestId);
        return;
      }

      if (method === 'Network.loadingFailed') {
        patch(id, { pending: false, error: params.errorText || 'request failed' });
        live.delete(params.requestId);
      }
    } catch { /* a malformed CDP frame must never take the window down */ }
  };

  wc.debugger.on('message', onMessage);
  // Another client (DevTools) can take the debugger from us at any time.
  wc.debugger.on('detach', () => { attached.delete(wc.id); });

  wc.debugger.sendCommand('Network.enable', {
    maxTotalBufferSize: 16 * 1024 * 1024,
    maxResourceBufferSize: 8 * 1024 * 1024
  }).catch(() => { /* attach raced a teardown */ });

  attached.set(wc.id, {
    detach: () => {
      try { wc.debugger.removeListener('message', onMessage); } catch {}
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
    }
  });
}

function detachAll(): void {
  for (const [, a] of attached) a.detach();
  attached.clear();
}

/** Start watching the browser panel's webviews as they appear. */
export function installBrowserCapture(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    if (capturing) attachDebugger(contents);
    contents.on('destroyed', () => {
      attached.get(contents.id)?.detach();
      attached.delete(contents.id);
    });
  });
}

/* ------------------------------------------------------------------- ipc */

export function registerNetworkIpc(): void {
  installFetchCapture();
  installBrowserCapture();

  ipcMain.handle(IPC.NetworkList, (): NetEntrySummary[] => entries.map(summarize));
  ipcMain.handle(IPC.NetworkGet, (_e, id: string): NetEntry | null => byId.get(id) ?? null);

  ipcMain.handle(IPC.NetworkClear, () => {
    entries.length = 0;
    byId.clear();
    safeSend(IPC.NetworkCleared);
    return true;
  });

  ipcMain.handle(IPC.NetworkSetCapture, (_e, on: boolean) => {
    capturing = !!on;
    // Pausing releases the debugger, which is also the escape hatch when the
    // user wants DevTools on the browser panel instead.
    if (!capturing) detachAll();
    else for (const wc of webContentsWebviews()) attachDebugger(wc);
    safeSend(IPC.NetworkCaptureState, capturing);
    return capturing;
  });

  ipcMain.handle(IPC.NetworkCaptureState, () => capturing);
}

/** Live webviews, for re-attaching when capture is switched back on. */
function webContentsWebviews(): Electron.WebContents[] {
  try {
    return webContents.getAllWebContents().filter((w) => w.getType() === 'webview');
  } catch { return []; }
}
