import { useEffect, useRef, useState } from 'react';
import type { MlxAdapter, MlxServerStatus } from '../../../shared/types';
import { useStore } from '../state/store';

// Local LLM control panel — MLX-LM only. Start/stop an OpenAI-compatible
// server backed by an MLX base model + optional LoRA adapter, copy its
// endpoint, and watch its log. Recent (model + adapter) combos are kept in
// localStorage so a freshly-opened workspace can resume with one click.

const RECENT_KEY = 'opendev:mlx-server:recents:v1';
const RECENT_CAP = 6;

type RecentEntry = { model: string; adapter: string | null };

function readRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && typeof e.model === 'string').slice(0, RECENT_CAP);
  } catch { return []; }
}
function writeRecents(entries: RecentEntry[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, RECENT_CAP))); } catch {}
}
function pushRecent(model: string, adapter: string | null): RecentEntry[] {
  const cur = readRecents();
  const dedup = cur.filter((e) => !(e.model === model && (e.adapter || null) === (adapter || null)));
  const next = [{ model, adapter: adapter || null }, ...dedup].slice(0, RECENT_CAP);
  writeRecents(next);
  return next;
}

// A handful of community-published MLX models that work out of the box on a
// 24 GB M-series — sized so they don't OOM the most common dev machine.
const SUGGESTED: string[] = [
  'mlx-community/Qwen2.5-7B-Instruct-4bit',
  'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
  'mlx-community/Llama-3.1-8B-Instruct-4bit',
  'mlx-community/Mistral-7B-Instruct-v0.3-4bit',
  'mlx-community/Phi-3.5-mini-instruct-4bit'
];

export function LlmPanel() {
  const [status, setStatus] = useState<MlxServerStatus>({ running: false });
  const [model, setModel] = useState('mlx-community/Qwen2.5-7B-Instruct-4bit');
  const [adapter, setAdapter] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<MlxAdapter[]>([]);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState<'starting' | 'stopping' | 'testing' | null>(null);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [copyOk, setCopyOk] = useState(false);
  // Parsed log state surfaced as a status banner above the raw pre — turns
  // the wall-of-text uvicorn output into something you can read at a glance.
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [requestCount, setRequestCount] = useState(0);
  const [lastRequestStatus, setLastRequestStatus] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; ms?: number } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const showToast = useStore((s) => s.showToast);

  // Initial hydration: live server status, detected adapters, recent picks.
  useEffect(() => {
    (async () => {
      try { setStatus(await window.opendev.llm.mlxStatus()); } catch { /* no prior state */ }
      try { setAdapters(await window.opendev.mlx.listAdapters()); } catch { /* not an MLX project */ }
    })();
    setRecents(readRecents());
    const offStatus = window.opendev.llm.onMlxStatus((s) => {
      setStatus(s);
      if (!s.running) setPhase((p) => (p === 'failed' ? 'failed' : 'idle'));
    });
    const offLog = window.opendev.llm.onMlxLog((chunk) => {
      setLog((prev) => (prev + chunk).slice(-12000));
      // Parse known mlx_lm.server / uvicorn lines to drive the status
      // banner. This isn't exhaustive — it just lifts the meaningful
      // milestones so the user can tell "loading" from "ready" without
      // squinting at the raw stderr.
      for (const line of chunk.split('\n')) {
        if (!line) continue;
        if (/Fetching\b/.test(line) || /Loading\b/.test(line) || /downloading/i.test(line)) {
          setPhase((p) => (p === 'ready' ? p : 'loading'));
        }
        if (/Uvicorn running on/i.test(line) || /Application startup complete/i.test(line) || /Starting MLX server/i.test(line)) {
          setPhase('ready');
        }
        if (/Address already in use|EADDRINUSE/i.test(line) || /ERROR:/i.test(line)) {
          setPhase('failed');
        }
        // Uvicorn access log: "127.0.0.1:12345 - \"POST /v1/chat/completions HTTP/1.1\" 200 OK"
        const reqMatch = line.match(/"(?:GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+\/\S+\s+HTTP\/[\d.]+"\s+(\d{3})/);
        if (reqMatch) {
          setRequestCount((n) => n + 1);
          setLastRequestStatus(Number(reqMatch[1]));
        }
      }
    });
    return () => { offStatus(); offLog(); };
  }, []);

  // Hydrate inputs from the running server's config — so reopening the IDE
  // mid-session doesn't blank the fields.
  useEffect(() => {
    if (status.model) setModel(status.model);
    if (status.adapter !== undefined) setAdapter(status.adapter || null);
  }, [status.model, status.adapter]);

  // Autoscroll log when new lines arrive (only while pinned to bottom).
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [log]);

  const endpoint = status.running && status.port ? `http://127.0.0.1:${status.port}/v1` : null;

  const start = async () => {
    if (!model.trim()) { showToast('Model id is required', 3000); return; }
    setBusy('starting');
    setLog('');
    setPhase('loading');
    setRequestCount(0);
    setLastRequestStatus(null);
    setTestResult(null);
    try {
      await window.opendev.llm.mlxStart({ model: model.trim(), adapter: adapter || null });
      setRecents(pushRecent(model.trim(), adapter || null));
      showToast('MLX server starting…', 2000);
    } catch (e: any) {
      showToast(`Start failed: ${e?.message || e}`, 5000);
      setPhase('failed');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!status.running || !status.port) return;
    setBusy('testing');
    setTestResult(null);
    const t0 = Date.now();
    try {
      // Tiny chat request so the user can confirm the endpoint actually
      // answers. Short max_tokens keeps the test cheap on big models.
      const r = await fetch(`http://127.0.0.1:${status.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: status.model || model,
          messages: [{ role: 'user', content: 'Say hi in one short sentence.' }],
          max_tokens: 40,
          temperature: 0.2
        })
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        const body = await r.text();
        setTestResult({ ok: false, text: `HTTP ${r.status}: ${body.slice(0, 200)}`, ms });
        return;
      }
      const body = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content || '(empty response)';
      setTestResult({ ok: true, text: text.trim(), ms });
    } catch (e: any) {
      setTestResult({ ok: false, text: e?.message || String(e), ms: Date.now() - t0 });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy('stopping');
    try {
      await window.opendev.llm.mlxStop();
    } catch (e: any) {
      showToast(`Stop failed: ${e?.message || e}`, 5000);
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    await stop();
    // Give the OS a beat to release the port + drop the previous model
    // from unified memory before we spawn fresh.
    await new Promise((r) => setTimeout(r, 400));
    await start();
  };

  const copyEndpoint = async () => {
    if (!endpoint) return;
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch {
      showToast('Copy failed', 2000);
    }
  };

  // When the user picks a model from the datalist (or just types one that
  // matches a previous run), restore the adapter pairing they used last time
  // — saves a second click for the common "rerun what I had" workflow.
  const onModelChange = (next: string) => {
    setModel(next);
    if (status.running) return;
    const recent = recents.find((r) => r.model === next);
    if (recent) setAdapter(recent.adapter);
  };

  // Combined options for the datalist: recents first (most useful), then
  // suggested base models, deduped by string.
  const datalistModels = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of recents) if (!seen.has(r.model)) { seen.add(r.model); out.push(r.model); }
    for (const m of SUGGESTED) if (!seen.has(m)) { seen.add(m); out.push(m); }
    return out;
  })();

  // Pre-flight check: warn if the chosen adapter doesn't exist on disk
  // anymore. Common after switching workspaces or cleaning up checkpoints.
  const adapterMissing = !!adapter && !adapters.some((a) => a.path === adapter);

  return (
    <div className="panel llm-panel">
      <div className="panel-header">
        <span>Local LLM · MLX-LM server</span>
        <span className="grow" />
        <span className={`llm-badge ${status.running ? 'on' : 'off'}`}>
          {status.running ? `running · :${status.port}` : 'stopped'}
        </span>
      </div>

      <div className="panel-body llm-mlx-body">
        <div className="llm-mlx-fields">
          <label>Model</label>
          <input
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="mlx-community/Qwen2.5-7B-Instruct-4bit"
            disabled={status.running}
            list="llm-model-suggestions"
          />
          <datalist id="llm-model-suggestions">
            {datalistModels.map((m) => <option key={m} value={m} />)}
          </datalist>
          <label>Adapter</label>
          <select
            value={adapter || ''}
            onChange={(e) => setAdapter(e.target.value || null)}
            disabled={status.running}
            title={adapter || '(none)'}
          >
            <option value="">(none)</option>
            {adapters.map((a) => (
              <option key={a.path} value={a.path}>
                {a.isLatestPointer ? 'latest' : `iter ${a.iter}`} · {a.name}
              </option>
            ))}
            {adapterMissing && <option value={adapter || ''}>{`(missing) ${adapter}`}</option>}
          </select>
        </div>

        {adapters.length === 0 && (
          <div className="llm-hint" style={{ margin: '4px 0 8px' }}>
            No adapters detected in this workspace. Open a project with <code>lora_config.yaml</code> to use a fine-tune; otherwise leave Adapter empty for base-model serving.
          </div>
        )}

        <div className="llm-mlx-actions">
          {!status.running
            ? <button onClick={start} disabled={!!busy || !model.trim()} className="primary">
                {busy === 'starting' ? 'Starting…' : '▶ Start'}
              </button>
            : <>
                <button onClick={stop} disabled={!!busy}>{busy === 'stopping' ? 'Stopping…' : '■ Stop'}</button>
                <button onClick={restart} disabled={!!busy} title="Stop then start">↻ Restart</button>
                <button onClick={test} disabled={!!busy || phase !== 'ready'} title="Send a tiny chat request to verify the server is responding">
                  {busy === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </>}
          {endpoint && (
            <button
              className="llm-mlx-endpoint-btn"
              onClick={copyEndpoint}
              title="Click to copy"
            >
              {copyOk ? 'copied ✓' : endpoint}
            </button>
          )}
        </div>

        {status.running && (
          <div className={`llm-mlx-banner phase-${phase}`}>
            <span className="llm-mlx-phase">
              {phase === 'loading' && '⏳ Loading model…'}
              {phase === 'ready' && '✓ Ready'}
              {phase === 'failed' && '✕ Failed — see log below'}
              {phase === 'idle' && '… initializing'}
            </span>
            {phase === 'ready' && (
              <span className="llm-mlx-stats">
                {requestCount > 0
                  ? <>· {requestCount} request{requestCount === 1 ? '' : 's'}{lastRequestStatus != null ? ` · last ${lastRequestStatus}` : ''}</>
                  : <>· awaiting first request</>}
              </span>
            )}
          </div>
        )}

        {testResult && (
          <div className={`llm-mlx-test ${testResult.ok ? 'ok' : 'err'}`}>
            <div className="llm-mlx-test-head">
              <span>{testResult.ok ? 'Test response' : 'Test failed'}</span>
              {testResult.ms != null && <span className="llm-mlx-test-ms">{testResult.ms} ms</span>}
              <span className="grow" />
              <button onClick={() => setTestResult(null)} title="Dismiss">✕</button>
            </div>
            <div className="llm-mlx-test-body">{testResult.text}</div>
          </div>
        )}

        {status.lastError && <div className="llm-error">{status.lastError}</div>}

        <pre ref={logRef} className="llm-mlx-log">{log || '(no output yet — start the server to populate this)'}</pre>
      </div>
    </div>
  );
}

