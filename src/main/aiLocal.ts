import { ipcMain } from 'electron';
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

async function fetchJson(url: string, apiKey?: string, timeoutMs = 5000): Promise<{ ok: boolean; status: number; body: any }> {
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

export async function listLocalModels(): Promise<ListLocalModelsResult> {
  const settings = await loadSettings();
  const baseUrl = settings.aiLocalBaseUrl?.trim() || 'http://localhost:11434/v1';
  const apiKey = settings.aiLocalApiKey?.trim();

  // Try OpenAI-compatible /models first — it's the surface OpenCode itself
  // talks to, so if this works the CLI will work with the same settings.
  try {
    const r = await fetchJson(`${trimSlash(baseUrl)}/models`, apiKey);
    if (r.ok && r.body && Array.isArray(r.body.data)) {
      const models: LocalModelInfo[] = r.body.data
        .map((m: any) => ({ id: String(m?.id ?? '') }))
        .filter((m: LocalModelInfo) => !!m.id);
      return { ok: true, models, source: 'openai', baseUrl };
    }
  } catch { /* fall through */ }

  // Ollama native API — strip the trailing /v1 since /api/tags lives at the root.
  const ollamaRoot = trimSlash(baseUrl).replace(/\/v1$/, '');
  try {
    const r = await fetchJson(`${ollamaRoot}/api/tags`, apiKey);
    if (r.ok && r.body && Array.isArray(r.body.models)) {
      const models: LocalModelInfo[] = r.body.models.map((m: any) => ({
        id: String(m?.name ?? ''),
        size: typeof m?.size === 'number' ? m.size : undefined,
        modifiedAt: m?.modified_at ? String(m.modified_at) : undefined
      })).filter((m: LocalModelInfo) => !!m.id);
      return { ok: true, models, source: 'ollama', baseUrl };
    }
  } catch (e: any) {
    return { ok: false, error: `Could not reach ${baseUrl}: ${e?.message || e}`, baseUrl };
  }
  return { ok: false, error: `No models returned by ${baseUrl}. Check that your local backend (Ollama, llama.cpp, …) is running and the base URL is correct.`, baseUrl };
}

export function registerAiLocalIpc(): void {
  ipcMain.handle(IPC.AiLocalListModels, () => listLocalModels());
}
