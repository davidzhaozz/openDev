import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import type { RestRequestSpec, RestResponse, RestResult, RestSavedRequest } from '@shared/types';
import { workspace } from './workspace.js';

// REST client: HTTP send + per-workspace saved-request collection. The
// saved collection lives at .opendev/rest-collection.json so it travels
// with the project. History is handled by queryHistory.ts (kind='rest').

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB cap on response body
const SEND_TIMEOUT_MS = 60_000;

function collectionPath(): string {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return join(root, '.opendev', 'rest-collection.json');
}

async function readCollection(): Promise<RestSavedRequest[]> {
  if (!workspace.getRoot()) return [];
  try {
    const raw = await fs.readFile(collectionPath(), 'utf8');
    const parsed = JSON.parse(raw) as { requests?: RestSavedRequest[] };
    return parsed.requests ?? [];
  } catch {
    return [];
  }
}

async function writeCollection(requests: RestSavedRequest[]): Promise<void> {
  const root = workspace.getRoot();
  if (!root) return;
  await fs.mkdir(join(root, '.opendev'), { recursive: true });
  await fs.writeFile(collectionPath(), JSON.stringify({ requests }, null, 2), 'utf8');
}

function buildUrl(baseUrl: string, params: RestRequestSpec['params']): string {
  const enabled = params.filter((p) => (p.enabled ?? true) && p.key);
  if (enabled.length === 0) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  const qs = enabled.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  return baseUrl + sep + qs;
}

function buildHeaders(spec: RestRequestSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of spec.headers) {
    if ((h.enabled ?? true) && h.key) out[h.key] = h.value;
  }
  // Auth header — overrides any manually-set Authorization since the
  // auth tab is the canonical place for that intent.
  if (spec.auth.kind === 'bearer' && spec.auth.token) {
    out['Authorization'] = `Bearer ${spec.auth.token}`;
  } else if (spec.auth.kind === 'basic' && (spec.auth.username || spec.auth.password)) {
    const enc = Buffer.from(`${spec.auth.username}:${spec.auth.password}`, 'utf8').toString('base64');
    out['Authorization'] = `Basic ${enc}`;
  }
  // Body content-type — only set if the user hasn't already.
  const hasCT = Object.keys(out).some((k) => k.toLowerCase() === 'content-type');
  if (!hasCT) {
    if (spec.body.kind === 'json') out['Content-Type'] = 'application/json';
    else if (spec.body.kind === 'text' && spec.body.contentType) out['Content-Type'] = spec.body.contentType;
    else if (spec.body.kind === 'form') out['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return out;
}

function buildBody(spec: RestRequestSpec): BodyInit | undefined {
  if (spec.method === 'GET' || spec.method === 'HEAD') return undefined;
  if (spec.body.kind === 'none') return undefined;
  if (spec.body.kind === 'json' || spec.body.kind === 'text') return spec.body.text;
  if (spec.body.kind === 'form') {
    const enabled = spec.body.fields.filter((f) => (f.enabled ?? true) && f.key);
    return enabled.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&');
  }
  return undefined;
}

async function send(spec: RestRequestSpec): Promise<RestResult> {
  if (!spec.url || !spec.url.trim()) return { error: 'URL is required' };
  let url: string;
  try {
    url = buildUrl(spec.url.trim(), spec.params);
    // Validate via URL constructor so we fail fast with a useful message.
    new URL(url);
  } catch (e: any) {
    return { error: `Invalid URL: ${e?.message || String(e)}` };
  }
  const headers = buildHeaders(spec);
  const body = buildBody(spec);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: spec.method,
      headers,
      body,
      signal: controller.signal,
      // Don't follow redirects silently for HEAD/OPTIONS so the user sees what
      // the server actually returned. fetch's default ('follow') is fine for
      // the common case — leave it alone.
      redirect: 'follow'
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_RESPONSE_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf;
    const text = slice.toString('utf8') + (truncated ? `\n\n[…truncated at ${MAX_RESPONSE_BYTES} bytes]` : '');
    const outHeaders: Array<[string, string]> = [];
    res.headers.forEach((v, k) => outHeaders.push([k, v]));
    const ct = res.headers.get('content-type') || undefined;
    const response: RestResponse = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
      body: text,
      contentType: ct,
      durationMs: Date.now() - startedAt,
      sizeBytes: buf.length,
      url
    };
    return response;
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return { error: aborted ? `Timed out after ${SEND_TIMEOUT_MS / 1000}s` : (e?.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

async function saveRequest(req: RestSavedRequest): Promise<RestSavedRequest[]> {
  const list = await readCollection();
  const idx = list.findIndex((r) => r.id === req.id);
  const next: RestSavedRequest = { ...req, updatedAt: Date.now() };
  if (idx >= 0) list[idx] = next; else list.unshift(next);
  await writeCollection(list);
  return list;
}

async function deleteRequest(id: string): Promise<RestSavedRequest[]> {
  const list = (await readCollection()).filter((r) => r.id !== id);
  await writeCollection(list);
  return list;
}

export function registerRestIpc(): void {
  ipcMain.handle(IPC.RestSend, async (_e, spec: RestRequestSpec) => send(spec));
  ipcMain.handle(IPC.RestListSaved, async () => readCollection());
  ipcMain.handle(IPC.RestSave, async (_e, req: RestSavedRequest) => saveRequest(req));
  ipcMain.handle(IPC.RestDelete, async (_e, id: string) => deleteRequest(id));
}

// Exposed so the MCP layer can call the same code path the renderer uses.
export const restApi = { send, readCollection, saveRequest, deleteRequest };
