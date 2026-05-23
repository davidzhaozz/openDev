import { useEffect, useMemo, useRef, useState } from 'react';
import type { MlxAdapter, MlxProjectInfo, MlxTrainEvent } from '../../../shared/types';
import { useStore } from '../state/store';

// ML panel — visible only when the workspace has a lora_config.yaml.
// Three stacked sections:
//   1. Config summary (parsed lora_config.yaml: model, iters, batch, etc.)
//   2. Live training (latest metrics + small loss sparkline + start/stop)
//   3. Adapters / checkpoints (sortable list, copy-path / reveal-in-finder)
// State is held locally in the panel — training events arrive via the
// services log stream (since mlx training is an auto-service); on first
// mount we also replay any prior train.log via mlx.readLog().

type TrainPoint = { iter: number; loss: number; ts: number };
type ValPoint = { iter: number; loss: number };

export function MlxPanel() {
  const [info, setInfo] = useState<MlxProjectInfo | null>(null);
  const [adapters, setAdapters] = useState<MlxAdapter[]>([]);
  const [trainHistory, setTrainHistory] = useState<TrainPoint[]>([]);
  const [valHistory, setValHistory] = useState<ValPoint[]>([]);
  const [running, setRunning] = useState(false);
  const [latestTrain, setLatestTrain] = useState<TrainPoint | null>(null);
  const [latestVal, setLatestVal] = useState<ValPoint | null>(null);
  const [latestStats, setLatestStats] = useState<{ tokensPerSec: number; peakMemGb: number; lr: number } | null>(null);
  const [savedNote, setSavedNote] = useState<{ iter: number; ts: number } | null>(null);
  const showToast = useStore((s) => s.showToast);

  const handleEvent = (ev: MlxTrainEvent) => {
    if (ev.kind === 'train') {
      const pt: TrainPoint = { iter: ev.iter, loss: ev.trainLoss, ts: ev.ts };
      setTrainHistory((prev) => capTail([...prev, pt], 1000));
      setLatestTrain(pt);
      setLatestStats({ tokensPerSec: ev.tokensPerSec, peakMemGb: ev.peakMemGb, lr: ev.learningRate });
    } else if (ev.kind === 'val') {
      const pt: ValPoint = { iter: ev.iter, loss: ev.valLoss };
      setValHistory((prev) => capTail([...prev, pt], 200));
      setLatestVal(pt);
    } else if (ev.kind === 'saved') {
      setSavedNote({ iter: ev.iter, ts: ev.ts });
      // Refresh the adapter list — a new checkpoint just landed.
      window.opendev.mlx.listAdapters().then(setAdapters).catch(() => {});
    } else if (ev.kind === 'started') {
      setRunning(true);
      setSavedNote(null);
    } else if (ev.kind === 'exited') {
      setRunning(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const status = await window.opendev.mlx.status();
      if (!alive) return;
      setInfo(status.info ?? null);
      setRunning(status.running);
      // Replay live events
      for (const ev of status.events) handleEvent(ev);
      // If there's no live data yet, seed the chart from train.log
      const noLive = status.events.every((e) => e.kind !== 'train');
      if (noLive) {
        const logged = await window.opendev.mlx.readLog();
        if (!alive) return;
        const train: TrainPoint[] = [];
        const val: ValPoint[] = [];
        for (const ev of logged) {
          if (ev.kind === 'train') train.push({ iter: ev.iter, loss: ev.trainLoss, ts: ev.ts });
          else if (ev.kind === 'val') val.push({ iter: ev.iter, loss: ev.valLoss });
        }
        setTrainHistory(capTail(train, 1000));
        setValHistory(capTail(val, 200));
        if (train.length) setLatestTrain(train[train.length - 1]);
        if (val.length) setLatestVal(val[val.length - 1]);
      }
      const ads = await window.opendev.mlx.listAdapters();
      if (alive) setAdapters(ads);
    })();
    const off = window.opendev.mlx.onEvent(handleEvent);
    return () => { alive = false; off(); };
  }, []);

  const start = async () => {
    try { await window.opendev.mlx.start(); }
    catch (e: any) { showToast(`Failed to start training: ${e?.message || e}`, 5000); }
  };
  const stop = async () => {
    try { await window.opendev.mlx.stop(); }
    catch (e: any) { showToast(`Stop failed: ${e?.message || e}`, 4000); }
  };

  if (!info) {
    return (
      <div className="panel">
        <div className="panel-header"><span>ML</span></div>
        <div className="panel-body" style={{ padding: 14, color: 'var(--fg-3)' }}>
          No MLX project detected. Add a <code>lora_config.yaml</code> (root or <code>training/</code>) to enable.
        </div>
      </div>
    );
  }

  const pct = info.iters && latestTrain ? Math.min(100, Math.round((latestTrain.iter / info.iters) * 100)) : null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span>ML · MLX-LM LoRA</span>
        <span className="grow" />
        {!running && <button title="Start training" onClick={start}>▶ Train</button>}
        {running && <button title="Stop training" onClick={stop}>■ Stop</button>}
      </div>
      <div className="panel-body" style={{ overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ConfigSummary info={info} />
        <LiveSection
          running={running}
          latestTrain={latestTrain}
          latestVal={latestVal}
          latestStats={latestStats}
          pct={pct}
          totalIters={info.iters}
          trainHistory={trainHistory}
          valHistory={valHistory}
          savedNote={savedNote}
        />
        <AdaptersSection adapters={adapters} onRefresh={async () => setAdapters(await window.opendev.mlx.listAdapters())} />
      </div>
    </div>
  );
}

function ConfigSummary({ info }: { info: MlxProjectInfo }) {
  const rows: Array<[string, string | number | undefined]> = [
    ['Model', info.model],
    ['Type', info.fineTuneType],
    ['Layers', info.numLayers],
    ['Iters', info.iters],
    ['Batch', info.batchSize],
    ['LR', info.learningRate],
    ['Max seq', info.maxSeqLength],
    ['LoRA rank', info.loraRank],
    ['LoRA scale', info.loraScale],
    ['LoRA dropout', info.loraDropout],
    ['Data', info.data],
    ['Adapter dir', info.adapterPath],
    ['Python', info.python],
    ['venv', info.hasVenv ? 'yes (.venv/)' : 'no']
  ];
  const reveal = (p?: string | null) => { if (p) window.opendev.fs.reveal(p); };
  return (
    <div>
      <div className="ml-section-title">Config</div>
      <div className="ml-config-grid">
        {rows.map(([k, v]) => v == null || v === '' ? null : (
          <div key={k} className="ml-config-row">
            <span className="ml-config-key">{k}</span>
            <span className="ml-config-val" title={String(v)}>{String(v)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button onClick={() => reveal(info.configPath)}>Reveal config</button>
        {info.resolvedAdapterDir && <button onClick={() => reveal(info.resolvedAdapterDir!)}>Reveal adapters</button>}
        {info.resolvedDataDir && <button onClick={() => reveal(info.resolvedDataDir!)}>Reveal data</button>}
      </div>
    </div>
  );
}

function LiveSection({
  running, latestTrain, latestVal, latestStats, pct, totalIters, trainHistory, valHistory, savedNote
}: {
  running: boolean;
  latestTrain: TrainPoint | null;
  latestVal: ValPoint | null;
  latestStats: { tokensPerSec: number; peakMemGb: number; lr: number } | null;
  pct: number | null;
  totalIters?: number;
  trainHistory: TrainPoint[];
  valHistory: ValPoint[];
  savedNote: { iter: number; ts: number } | null;
}) {
  return (
    <div>
      <div className="ml-section-title">
        <span>Training</span>
        <span className={`ml-badge ${running ? 'on' : 'off'}`}>{running ? 'running' : 'idle'}</span>
      </div>
      <div className="ml-metrics">
        <Metric label="Iter" value={latestTrain ? `${latestTrain.iter}${totalIters ? ` / ${totalIters}` : ''}` : '—'} />
        <Metric label="Train loss" value={latestTrain ? latestTrain.loss.toFixed(4) : '—'} />
        <Metric label="Val loss" value={latestVal ? `${latestVal.loss.toFixed(4)}${latestVal ? ` @${latestVal.iter}` : ''}` : '—'} />
        <Metric label="Tokens/s" value={latestStats ? latestStats.tokensPerSec.toFixed(1) : '—'} />
        <Metric label="Peak mem" value={latestStats ? `${latestStats.peakMemGb.toFixed(2)} GB` : '—'} />
      </div>
      {pct != null && (
        <div className="ml-progress"><div className="ml-progress-fill" style={{ width: `${pct}%` }} /></div>
      )}
      <LossChart train={trainHistory} val={valHistory} />
      {savedNote && (
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>
          Last checkpoint: iter {savedNote.iter} · {new Date(savedNote.ts).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ml-metric">
      <div className="ml-metric-label">{label}</div>
      <div className="ml-metric-value">{value}</div>
    </div>
  );
}

function LossChart({ train, val }: { train: TrainPoint[]; val: ValPoint[] }) {
  // 480×80 inline SVG. Domain is iter range across both series; range is
  // min/max loss across both. We don't try to be axis-pretty — just enough
  // visual feedback to spot divergence / convergence at a glance.
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(120, e.contentRect.width));
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  const h = 90;
  const path = useMemo(() => {
    if (train.length < 2 && val.length < 2) return { trainD: '', valD: '', xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    const all = [...train.map((p) => p.iter), ...val.map((p) => p.iter)];
    const yAll = [...train.map((p) => p.loss), ...val.map((p) => p.loss)];
    const xMin = Math.min(...all);
    const xMax = Math.max(...all);
    const yMin = Math.min(...yAll);
    const yMax = Math.max(...yAll);
    const xSpan = xMax - xMin || 1;
    const ySpan = yMax - yMin || 1;
    const sx = (x: number) => ((x - xMin) / xSpan) * (w - 24) + 12;
    const sy = (y: number) => h - 6 - ((y - yMin) / ySpan) * (h - 18);
    const toD = (pts: Array<{ iter: number; loss: number }>) =>
      pts.length === 0 ? '' : pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.iter).toFixed(1)} ${sy(p.loss).toFixed(1)}`).join(' ');
    return { trainD: toD(train), valD: toD(val), xMin, xMax, yMin, yMax };
  }, [train, val, w]);

  return (
    <div ref={ref} className="ml-chart">
      <svg width={w} height={h} style={{ display: 'block' }}>
        <rect x={0} y={0} width={w} height={h} fill="transparent" />
        {path.trainD && <path d={path.trainD} stroke="var(--accent, #6cb)" strokeWidth={1.2} fill="none" />}
        {path.valD && <path d={path.valD} stroke="var(--danger, #d96)" strokeWidth={1.2} fill="none" strokeDasharray="3 2" />}
      </svg>
      <div className="ml-chart-legend">
        <span><i style={{ background: 'var(--accent, #6cb)' }} /> train</span>
        <span><i style={{ background: 'var(--danger, #d96)' }} /> val</span>
      </div>
    </div>
  );
}

function AdaptersSection({ adapters, onRefresh }: { adapters: MlxAdapter[]; onRefresh: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); showToast('Path copied', 1500); }
    catch { showToast('Copy failed', 2000); }
  };
  return (
    <div>
      <div className="ml-section-title">
        <span>Adapters / checkpoints</span>
        <span className="grow" />
        <button className="icon" title="Refresh" onClick={onRefresh}>↻</button>
      </div>
      {adapters.length === 0 ? (
        <div style={{ color: 'var(--fg-3)', fontSize: 12, padding: '6px 2px' }}>
          No checkpoints yet — they appear here after the first <code>save_every</code> hit.
        </div>
      ) : (
        <div className="ml-adapters">
          {adapters.map((a) => (
            <div key={a.path} className="ml-adapter-row">
              <div className="ml-adapter-name">
                {a.isLatestPointer ? <span className="ml-pill">latest</span> : <span className="ml-pill iter">iter {a.iter}</span>}
                <span title={a.name} style={{ marginLeft: 6 }}>{a.name}</span>
              </div>
              <div className="ml-adapter-meta">
                <span>{formatBytes(a.sizeBytes)}</span>
                <span>·</span>
                <span title={new Date(a.modifiedAt).toLocaleString()}>{relTime(a.modifiedAt)}</span>
              </div>
              <div className="ml-adapter-actions">
                <button title="Copy path" onClick={() => copy(a.path)}>copy</button>
                <button title="Reveal in Finder" onClick={() => window.opendev.fs.reveal(a.path)}>reveal</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function capTail<T>(arr: T[], max: number): T[] {
  return arr.length <= max ? arr : arr.slice(arr.length - max);
}
function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function relTime(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 60_000) return 'just now';
  if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86400_000) return `${Math.floor(dt / 3600_000)}h ago`;
  return `${Math.floor(dt / 86400_000)}d ago`;
}
