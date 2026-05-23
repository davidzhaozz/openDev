import { ipcMain } from 'electron';
import { promises as fs, existsSync } from 'fs';
import { join, basename, dirname, isAbsolute, resolve } from 'path';
import { IPC } from '@shared/ipc';
import type { MlxAdapter, MlxProjectInfo, MlxStatus, MlxTrainEvent } from '@shared/types';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { serviceManager } from './services.js';

// ---- minimal yaml parser ---------------------------------------------------
// lora_config.yaml is a flat scalar map with one optional level of nested
// mappings (lora_parameters). We avoid pulling in js-yaml just for this —
// the file format is constrained enough that a 30-line parser covers it.
// Anything fancier (anchors, multi-line strings, flow style) would need a
// real library; the IDE doesn't try to be that.

function coerce(v: string): unknown {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let nested: Record<string, unknown> | null = null;
  let nestedKey = '';
  let nestedIndent = -1;
  for (const rawLine of text.split(/\r?\n/)) {
    const noComment = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^\s*/)![0].length;
    const m = noComment.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2].trim();
    if (nested && (indent <= nestedIndent || rawValue === '')) {
      // End the previous nested block when indentation drops or a new
      // block starts at the same indent.
      out[nestedKey] = nested;
      nested = null;
      nestedIndent = -1;
    }
    if (rawValue === '') {
      nested = {};
      nestedKey = key;
      nestedIndent = indent;
      continue;
    }
    if (nested && indent > nestedIndent) {
      nested[key] = coerce(rawValue);
    } else {
      out[key] = coerce(rawValue);
    }
  }
  if (nested) out[nestedKey] = nested;
  return out;
}

// ---- locating things on disk ----------------------------------------------

function findConfigPath(root: string): string | null {
  const candidates = [
    join(root, 'lora_config.yaml'),
    join(root, 'lora_config.yml'),
    join(root, 'training', 'lora_config.yaml'),
    join(root, 'training', 'lora_config.yml')
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// Configs reference paths like "training/adapters_v2" which assume the
// repo root is the parent of `training/`. When the user opens the
// `training/` folder directly as the workspace, those paths don't
// resolve. Try a few interpretations and pick whichever exists.
function resolveProjectPath(workspaceRoot: string, configDir: string, value: string): string | null {
  if (isAbsolute(value)) return existsSync(value) ? value : null;
  const wsName = basename(workspaceRoot);
  const candidates = [
    join(configDir, value),
    join(workspaceRoot, value),
    // "training/adapters" stripped when workspace IS "training/"
    value.startsWith(wsName + '/') ? join(workspaceRoot, value.slice(wsName.length + 1)) : null,
    join(workspaceRoot, '..', value)
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

function findPython(workspaceRoot: string): { python: string; hasVenv: boolean } {
  const venvCandidates = [
    join(workspaceRoot, '.venv', 'bin', 'python'),
    join(workspaceRoot, 'venv', 'bin', 'python'),
    join(workspaceRoot, '..', '.venv', 'bin', 'python')
  ];
  for (const c of venvCandidates) {
    if (existsSync(c)) return { python: resolve(c), hasVenv: true };
  }
  return { python: 'python3', hasVenv: false };
}

// ---- public detection -----------------------------------------------------

export const MLX_AUTO_SERVICE_ID = 'auto-mlx-lora-train';

export async function detectMlxProject(): Promise<MlxProjectInfo | null> {
  const root = workspace.getRoot();
  if (!root) return null;
  const configPath = findConfigPath(root);
  if (!configPath) return null;
  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configPath, 'utf8');
    raw = parseSimpleYaml(text);
  } catch {
    return null;
  }
  const configDir = dirname(configPath);
  const adapterPath = typeof raw.adapter_path === 'string' ? (raw.adapter_path as string) : undefined;
  const dataPath = typeof raw.data === 'string' ? (raw.data as string) : undefined;
  const lora = (raw.lora_parameters as Record<string, unknown> | undefined) || {};
  const { python, hasVenv } = findPython(root);
  const info: MlxProjectInfo = {
    configPath,
    model: typeof raw.model === 'string' ? (raw.model as string) : undefined,
    data: dataPath,
    fineTuneType: typeof raw.fine_tune_type === 'string' ? (raw.fine_tune_type as string) : undefined,
    numLayers: typeof raw.num_layers === 'number' ? (raw.num_layers as number) : undefined,
    batchSize: typeof raw.batch_size === 'number' ? (raw.batch_size as number) : undefined,
    iters: typeof raw.iters === 'number' ? (raw.iters as number) : undefined,
    learningRate: typeof raw.learning_rate === 'number' ? (raw.learning_rate as number) : undefined,
    maxSeqLength: typeof raw.max_seq_length === 'number' ? (raw.max_seq_length as number) : undefined,
    gradCheckpoint: typeof raw.grad_checkpoint === 'boolean' ? (raw.grad_checkpoint as boolean) : undefined,
    stepsPerReport: typeof raw.steps_per_report === 'number' ? (raw.steps_per_report as number) : undefined,
    stepsPerEval: typeof raw.steps_per_eval === 'number' ? (raw.steps_per_eval as number) : undefined,
    valBatches: typeof raw.val_batches === 'number' ? (raw.val_batches as number) : undefined,
    saveEvery: typeof raw.save_every === 'number' ? (raw.save_every as number) : undefined,
    adapterPath,
    loraRank: typeof lora.rank === 'number' ? (lora.rank as number) : undefined,
    loraScale: typeof lora.scale === 'number' ? (lora.scale as number) : undefined,
    loraDropout: typeof lora.dropout === 'number' ? (lora.dropout as number) : undefined,
    raw,
    resolvedAdapterDir: adapterPath ? resolveProjectPath(root, configDir, adapterPath) : null,
    resolvedDataDir: dataPath ? resolveProjectPath(root, configDir, dataPath) : null,
    python,
    hasVenv,
    serviceId: MLX_AUTO_SERVICE_ID
  };
  return info;
}

// Build the command the auto-service should run. Caller owns the cwd
// (workspace root) so we hand back a string that will work from there.
// Honors the user's selected Python interpreter (status-bar picker) when
// set; falls back to .venv-side binaries and finally `python3 -m mlx_lm.lora`.
export async function buildTrainCommand(info: MlxProjectInfo): Promise<string> {
  const root = workspace.getRoot()!;
  const cfgRel = info.configPath.startsWith(root + '/') ? info.configPath.slice(root.length + 1) : info.configPath;
  // 1. User-selected interpreter wins. If it's the workspace .venv's python
  //    AND a mlx_lm.lora wrapper sits next to it, prefer the wrapper for the
  //    cleaner ps output.
  try {
    const { getSelectedInterpreter } = await import('./python.js');
    const sel = await getSelectedInterpreter();
    if (sel) {
      const wrapper = join(sel.path, '..', 'mlx_lm.lora');
      if (existsSync(wrapper)) return `${quote(rel(root, wrapper))} --config ${quote(cfgRel)}`;
      return `${quote(rel(root, sel.path))} -m mlx_lm.lora --config ${quote(cfgRel)}`;
    }
  } catch { /* fall through */ }

  // 2. Project-local .venv (legacy path — kept for users who haven't picked
  //    an interpreter yet).
  const venvLora = join(root, '.venv', 'bin', 'mlx_lm.lora');
  if (existsSync(venvLora)) {
    return `.venv/bin/mlx_lm.lora --config ${quote(cfgRel)}`;
  }
  const venvPy = join(root, '.venv', 'bin', 'python');
  if (existsSync(venvPy)) {
    return `.venv/bin/python -m mlx_lm.lora --config ${quote(cfgRel)}`;
  }
  return `python3 -m mlx_lm.lora --config ${quote(cfgRel)}`;
}

// Return `p` relative to `root` when it lives under root; otherwise the
// absolute path. Keeps the auto-service command compact for in-tree
// interpreters and unambiguous for ones that live elsewhere (pyenv, conda).
function rel(root: string, p: string): string {
  return p === root || p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

function quote(s: string): string {
  if (/^[A-Za-z0-9._/\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- adapter checkpoints --------------------------------------------------

const ADAPTER_FILE_RE = /^(?:(\d+)_)?adapters\.safetensors$/;

export async function listAdapters(): Promise<MlxAdapter[]> {
  const info = await detectMlxProject();
  const dir = info?.resolvedAdapterDir;
  if (!dir) return [];
  let entries: string[] = [];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const out: MlxAdapter[] = [];
  for (const name of entries) {
    const m = name.match(ADAPTER_FILE_RE);
    if (!m) continue;
    const abs = join(dir, name);
    try {
      const st = await fs.stat(abs);
      out.push({
        path: abs,
        name,
        iter: m[1] ? Number(m[1]) : null,
        sizeBytes: st.size,
        modifiedAt: st.mtimeMs,
        isLatestPointer: !m[1]
      });
    } catch { /* skipped on race */ }
  }
  // Iter checkpoints ascending, latest pointer last.
  out.sort((a, b) => {
    if (a.isLatestPointer && !b.isLatestPointer) return 1;
    if (!a.isLatestPointer && b.isLatestPointer) return -1;
    return (a.iter ?? 0) - (b.iter ?? 0);
  });
  return out;
}

// ---- log parsing ----------------------------------------------------------

const TRAIN_RE = /^Iter\s+(\d+):\s+Train loss\s+([0-9.]+),\s+Learning Rate\s+([0-9.eE+-]+),\s+It\/sec\s+([0-9.]+),\s+Tokens\/sec\s+([0-9.]+),\s+Trained Tokens\s+(\d+),\s+Peak mem\s+([0-9.]+)\s+GB/;
const VAL_RE = /^Iter\s+(\d+):\s+Val loss\s+([0-9.]+),\s+Val took\s+([0-9.]+)s/;
const SAVED_RE = /^Iter\s+(\d+):\s+Saved adapter weights to\s+(.+?)\.?$/;

export function parseTrainLine(line: string): MlxTrainEvent | null {
  const ts = Date.now();
  let m: RegExpMatchArray | null;
  if ((m = line.match(TRAIN_RE))) {
    return {
      kind: 'train',
      iter: Number(m[1]),
      trainLoss: Number(m[2]),
      learningRate: Number(m[3]),
      itPerSec: Number(m[4]),
      tokensPerSec: Number(m[5]),
      trainedTokens: Number(m[6]),
      peakMemGb: Number(m[7]),
      ts
    };
  }
  if ((m = line.match(VAL_RE))) {
    return { kind: 'val', iter: Number(m[1]), valLoss: Number(m[2]), valTookSec: Number(m[3]), ts };
  }
  if ((m = line.match(SAVED_RE))) {
    // The log uses " and " to separate the two saved paths.
    const paths = m[2].split(/\s+and\s+/).map((p) => p.trim()).filter(Boolean);
    return { kind: 'saved', iter: Number(m[1]), paths, ts };
  }
  return null;
}

// Reading a stored train.log file — used by the MLX panel to populate the
// loss chart with prior runs before a fresh training session starts.
export async function readTrainLog(absPath?: string): Promise<MlxTrainEvent[]> {
  const root = workspace.getRoot();
  if (!root) return [];
  // Auto-discover the most recent train log if no path was given.
  let target = absPath;
  if (!target) {
    const candidates = ['train_v2.log', 'train.log', 'training/train_v2.log', 'training/train.log'];
    for (const c of candidates) {
      const abs = join(root, c);
      if (existsSync(abs)) { target = abs; break; }
    }
  }
  if (!target || !existsSync(target)) return [];
  let text: string;
  try { text = await fs.readFile(target, 'utf8'); } catch { return []; }
  const events: MlxTrainEvent[] = [];
  // tqdm progress lines use \r within "Calculating loss..." blocks. Splitting
  // on either \r or \n keeps the actual Iter rows intact (those end with \n).
  for (const raw of text.split(/[\r\n]+/)) {
    if (!raw) continue;
    if (raw.startsWith('Calculating loss')) continue;
    const ev = parseTrainLine(raw);
    if (ev) events.push(ev);
  }
  return events;
}

// ---- live training state --------------------------------------------------

const MAX_EVENTS = 500;
const liveEvents: MlxTrainEvent[] = [];
let logBuffer = '';
let logSubscribed = false;

function pushEvent(ev: MlxTrainEvent): void {
  liveEvents.push(ev);
  if (liveEvents.length > MAX_EVENTS) liveEvents.splice(0, liveEvents.length - MAX_EVENTS);
  safeSend(IPC.MlxEvent, ev);
}

// Subscribe to the auto-service's stdout once. Each chunk gets line-buffered
// and parsed; matching events are broadcast to the renderer.
function ensureLogSubscription(): void {
  if (logSubscribed) return;
  logSubscribed = true;
  serviceManager.onLogChunk((id, chunk) => {
    if (id !== MLX_AUTO_SERVICE_ID) return;
    logBuffer += chunk;
    // Both \n (real events) and \r (tqdm progress) terminate "lines" for our
    // purposes. We keep the trailing partial in the buffer until more arrives.
    const parts = logBuffer.split(/[\r\n]+/);
    logBuffer = parts.pop() ?? '';
    for (const line of parts) {
      if (!line || line.startsWith('Calculating loss')) continue;
      const ev = parseTrainLine(line);
      if (ev) pushEvent(ev);
    }
  });
  serviceManager.onStatusChange((r) => {
    if (r.id !== MLX_AUTO_SERVICE_ID) return;
    if (r.status === 'starting') {
      // Fresh run — clear stale buffer but preserve old events so the
      // loss chart still shows context until new ones overwrite it.
      logBuffer = '';
      pushEvent({ kind: 'started', ts: Date.now() });
    } else if (r.status === 'stopped' || r.status === 'error') {
      pushEvent({ kind: 'exited', code: r.status === 'error' ? 1 : 0, ts: Date.now() });
    }
  });
}

export async function getMlxStatus(): Promise<MlxStatus> {
  const info = await detectMlxProject();
  if (!info) return { detected: false, running: false, events: [] };
  ensureLogSubscription();
  const rt = serviceManager.status(MLX_AUTO_SERVICE_ID);
  const running = rt.status === 'running' || rt.status === 'starting';
  return { detected: true, info, running, serviceId: MLX_AUTO_SERVICE_ID, events: [...liveEvents] };
}

export async function startMlxTraining(): Promise<void> {
  ensureLogSubscription();
  await serviceManager.start(MLX_AUTO_SERVICE_ID);
}

export async function stopMlxTraining(): Promise<void> {
  await serviceManager.stop(MLX_AUTO_SERVICE_ID);
}

export function registerMlxIpc(): void {
  ipcMain.handle(IPC.MlxDetect, () => detectMlxProject());
  ipcMain.handle(IPC.MlxListAdapters, () => listAdapters());
  ipcMain.handle(IPC.MlxReadLog, (_e, path?: string) => readTrainLog(path));
  ipcMain.handle(IPC.MlxStart, () => startMlxTraining());
  ipcMain.handle(IPC.MlxStop, () => stopMlxTraining());
  ipcMain.handle(IPC.MlxStatus, () => getMlxStatus());
}
