import { ipcMain, dialog } from 'electron';
import { IPC } from '@shared/ipc';
import { loadSettings } from './storage.js';

// Local-AI helpers: model discovery for the OpenCode CLI's configured
// backend. OpenCode itself talks the OpenAI chat protocol — so any
// compatible endpoint exposes /v1/models (Ollama, llama.cpp, vLLM, etc.).
// We hit that first; if it's missing we fall back to Ollama's native
// /api/tags so first-time Ollama users still see their installed models.

export type LocalModelInfo = {
  id: string;
  size?: number;          // bytes, when the backend reports it
  modifiedAt?: string;    // ISO timestamp, when reported
};

export type ListLocalModelsResult =
  | { ok: true; models: LocalModelInfo[]; source: 'openai' | 'ollama'; baseUrl: string }
  | { ok: false; error: string; baseUrl: string };

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

// Normalise what the user typed into something fetch() will actually probe:
// - `192.168.2.219:11434` → `http://192.168.2.219:11434`
//   (without a scheme, fetch parses `192.168.2.219:` AS the scheme and dies)
// - leading/trailing whitespace + trailing slashes are stripped
// We default to http (not https) because that's the convention for local
// LLM backends (Ollama, llama.cpp serve plain http by default).
function normalizeBaseUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  const scheme = /^https?:\/\//i.test(s) ? '' : 'http://';
  return trimSlash(scheme + s);
}

async function fetchJson(url: string, apiKey?: string, timeoutMs = 10000): Promise<{ ok: boolean; status: number; body: any }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const r = await fetch(url, { headers, signal: controller.signal });
    let body: any = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

export async function listLocalModels(overrideBaseUrl?: string): Promise<ListLocalModelsResult> {
  const settings = await loadSettings();
  const raw = (overrideBaseUrl ?? settings.aiLocalBaseUrl) || 'http://localhost:11434/v1';
  const apiKey = settings.aiLocalApiKey?.trim();

  const baseUrl = normalizeBaseUrl(raw);
  const trimmed = baseUrl;
  if (!/^https?:\/\//i.test(trimmed)) {
    // Should be unreachable post-normalize, but if the user typed something
    // truly weird (e.g. only whitespace) bail with a clear message.
    return { ok: false, error: `Couldn't make sense of base URL "${raw}". Expected something like http://localhost:11434 or http://192.168.1.50:11434.`, baseUrl: raw };
  }

  // Probe Ollama's native /api/tags FIRST — it's the default backend, the
  // endpoint name is canonical (no /v1 guessing), and the response carries
  // model sizes the OpenAI shape doesn't expose. Only fall through to the
  // OpenAI-compat endpoints when the server clearly isn't Ollama.
  const ollamaRoot = trimmed.replace(/\/v1$/, '');
  const tagsUrl = `${ollamaRoot}/api/tags`;
  const attempts: Array<{ url: string; ok?: boolean; status?: number; error?: string }> = [];
  let ollamaBodyPreview = '';
  try {
    const r = await fetchJson(tagsUrl, apiKey);
    attempts.push({ url: tagsUrl, ok: r.ok, status: r.status });
    console.log(`[aiLocal] probe ${tagsUrl} → status=${r.status} ok=${r.ok}`);
    if (r.ok && r.body) {
      if (Array.isArray(r.body.models)) {
        const models: LocalModelInfo[] = r.body.models.map((m: any) => ({
          id: String(m?.name ?? m?.model ?? ''),
          size: typeof m?.size === 'number' ? m.size : undefined,
          modifiedAt: m?.modified_at ? String(m.modified_at) : undefined
        })).filter((m: LocalModelInfo) => !!m.id);
        console.log(`[aiLocal] discovered ${models.length} models via ollama at ${tagsUrl}`);
        return { ok: true, models, source: 'ollama', baseUrl };
      }
      try { ollamaBodyPreview = JSON.stringify(r.body).slice(0, 400); } catch { ollamaBodyPreview = String(r.body).slice(0, 400); }
    }
  } catch (e: any) {
    const msg = e?.cause?.code || e?.code || e?.message || String(e);
    attempts.push({ url: tagsUrl, error: msg });
    console.warn(`[aiLocal] probe ${tagsUrl} failed: ${msg}`);
  }

  // OpenAI-compatible /models (for llama.cpp server, vLLM, hosted backends,
  // and Ollama's own compat layer when /api/tags somehow doesn't apply).
  const openAiCandidates = [`${trimmed}/models`];
  if (!/\/v1$/.test(trimmed)) openAiCandidates.push(`${trimmed}/v1/models`);
  for (const url of openAiCandidates) {
    try {
      const r = await fetchJson(url, apiKey);
      attempts.push({ url, ok: r.ok, status: r.status });
      console.log(`[aiLocal] probe ${url} → status=${r.status} ok=${r.ok}`);
      if (r.ok && r.body && Array.isArray(r.body.data)) {
        const models: LocalModelInfo[] = r.body.data
          .map((m: any) => ({ id: String(m?.id ?? '') }))
          .filter((m: LocalModelInfo) => !!m.id);
        if (models.length > 0) {
          console.log(`[aiLocal] discovered ${models.length} models via openai at ${url}`);
          return { ok: true, models, source: 'openai', baseUrl };
        }
      }
    } catch (e: any) {
      const msg = e?.cause?.code || e?.code || e?.message || String(e);
      attempts.push({ url, error: msg });
      console.warn(`[aiLocal] probe ${url} failed: ${msg}`);
    }
  }

  // Last-ditch reachability check — does the root respond at all? Ollama
  // returns plaintext "Ollama is running" on GET /. This lets us tell the
  // user "server is alive, but doesn't speak the API we expect" rather than
  // implying it's offline.
  const rootUrl = ollamaRoot;
  let rootAlive = false;
  let rootBodyPreview = '';
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetch(rootUrl, { signal: controller.signal });
      rootAlive = r.ok || r.status === 200;
      const txt = await r.text().catch(() => '');
      rootBodyPreview = txt.slice(0, 200).trim();
    } finally {
      clearTimeout(t);
    }
    console.log(`[aiLocal] root probe ${rootUrl} → alive=${rootAlive} preview="${rootBodyPreview}"`);
  } catch (e: any) {
    console.warn(`[aiLocal] root probe ${rootUrl} failed: ${e?.message || e}`);
  }

  const errCodes = attempts.map(a => a.error || '').join(' ');
  const looksLikeNetwork = !rootAlive && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|abort|AbortError|fetch failed/i.test(errCodes);
  const hint = looksLikeNetwork
    ? `\n\nServer not reachable. Ollama only listens on 127.0.0.1 by default — on the remote machine, restart with OLLAMA_HOST=0.0.0.0:11434 (or set the env var in your launchd / systemd unit) so it accepts LAN connections.`
    : rootAlive
      ? `\n\nServer at ${rootUrl} responded ("${rootBodyPreview}") but /api/tags didn't return a recognisable model list. ${ollamaBodyPreview ? `Raw /api/tags body: ${ollamaBodyPreview}` : 'Check that the Ollama version on this machine is recent — older versions used a different endpoint.'}`
      : '';
  const detail = attempts.map(a =>
    a.error ? `  • ${a.url} — ${a.error}` : `  • ${a.url} — HTTP ${a.status}${a.ok ? ' (no models in response)' : ''}`
  ).join('\n');
  return {
    ok: false,
    error: `No models discovered at ${baseUrl}.\nTried:\n${detail}${hint}`,
    baseUrl
  };
}

export function registerAiLocalIpc(): void {
  ipcMain.handle(IPC.AiLocalListModels, (_e, baseUrl?: string) => listLocalModels(baseUrl));
  ipcMain.handle(IPC.AiLocalPickBinary, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Select OpenCode binary',
      properties: ['openFile'],
      buttonLabel: 'Use this binary',
      // OpenCode is a Rust binary with no extension on macOS, so don't
      // restrict to extensions — but offer "All Files" explicitly.
      filters: [{ name: 'All Files', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
}
