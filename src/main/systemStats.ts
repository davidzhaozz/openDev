import { cpus, freemem, loadavg, platform, totalmem } from 'os';
import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import { IPC } from '@shared/ipc';
import type { SystemStats } from '@shared/types';
import { safeSend } from './safeSend.js';

// Whole-system memory + CPU sampler. Broadcast to the renderer every ~2s
// so the bottom-bar chip can show MEM x.x/yy G · CPU NN%. Independent of
// the per-process memory watchdog in index.ts — that one warns when the
// IDE itself is bloating; this one shows the user how much headroom they
// have on the whole machine.

const SAMPLE_INTERVAL_MS = 2000;
let timer: NodeJS.Timeout | null = null;
let prevCpu: { idle: number; total: number } | null = null;
let lastBroadcast: SystemStats | null = null;

function snapshotCpu(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function computeCpuPct(): number {
  const cur = snapshotCpu();
  if (!prevCpu) {
    prevCpu = cur;
    return 0;
  }
  const idleDelta = cur.idle - prevCpu.idle;
  const totalDelta = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDelta <= 0) return 0;
  const usage = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(100, Math.round(usage * 1000) / 10));
}

// macOS-specific "used" calculation. Node's os.freemem() returns only the
// vm_statistics64.free_count bucket — it ignores inactive (cached) and
// speculative pages, which macOS treats as immediately reclaimable. As a
// result `total - free` reads ~99% on a normally-loaded Mac, scaring the
// user when the machine actually has plenty of headroom.
//
// vm_stat output we care about:
//   Mach Virtual Memory Statistics: (page size of 16384 bytes)
//   Pages free:                  16324.
//   Pages active:               629571.
//   Pages inactive:             624185.
//   Pages speculative:           11265.
//   Pages wired down:           173239.
//   Pages occupied by compressor: 73737.
//
// "Used" (matches Activity Monitor's "Memory Used") = wired + active +
// compressed. Inactive + speculative + free are all available headroom.

const isDarwin = platform() === 'darwin';
const isWindows = platform() === 'win32';
let lastDarwinUsedBytes: number | null = null;

// File-descriptor accounting. Soft limit is probed once via `ulimit -Sn`
// from a shell (Node has no built-in getrlimit). Finder-launched macOS
// apps default to 256; Terminal-launched processes inherit a much larger
// value. Both are correct for their context; we just show whatever
// applies at runtime so the user knows their actual ceiling.
let fdLimit = 0;
function probeFdLimit(): void {
  // Windows has handles, not file descriptors, and no RLIMIT_NOFILE to read.
  // Leaving both count and limit at 0 makes the renderer hide the pill.
  if (isWindows) return;
  execFile('/bin/sh', ['-c', 'ulimit -Sn'], { timeout: 1500 }, (err, stdout) => {
    if (err) return;
    const n = parseInt(String(stdout).trim(), 10);
    if (Number.isFinite(n) && n > 0) fdLimit = n;
  });
}

// GPU info — probed once at startup via system_profiler on macOS. Counts
// every block whose "Type: GPU" line matches and sums "Total Number of
// Cores" across them. Non-Apple GPUs may omit the cores line; we still
// count them but cores stays 0 if nothing reports it. Other platforms
// leave both at 0 (renderer hides the pill in that case).
let gpuCount = 0;
let gpuCores = 0;
function probeGpuInfo(): void {
  if (isWindows) return probeGpuInfoWindows();
  if (!isDarwin) return;
  execFile('/usr/sbin/system_profiler', ['SPDisplaysDataType'], { timeout: 4000 }, (err, stdout) => {
    if (err || !stdout) return;
    // Each GPU starts with a chipset header; "Type: GPU" filters out any
    // non-GPU display entries. Cores line is optional.
    const blocks = stdout.split(/\n(?=\s{4}\S)/);
    let count = 0;
    let cores = 0;
    for (const b of blocks) {
      if (!/^\s+Type:\s+GPU\b/m.test(b)) continue;
      count += 1;
      const m = b.match(/Total Number of Cores:\s+(\d+)/);
      if (m) cores += Number(m[1]);
    }
    gpuCount = count;
    gpuCores = cores;
  });
}

// Windows exposes adapters through CIM; there is no per-GPU core count to
// read, so only the adapter count is reported and the renderer renders
// "GPU 1" / "GPU 2×" instead of a core figure.
function probeGpuInfoWindows(): void {
  execFile('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_VideoController | Measure-Object).Count'
  ], { timeout: 6000, windowsHide: true }, (err, stdout) => {
    if (err || !stdout) return;
    const n = parseInt(String(stdout).trim(), 10);
    if (Number.isFinite(n) && n > 0) gpuCount = n;
  });
}

function readFdCount(): number {
  // On Linux/macOS, /dev/fd is a per-process view of open descriptors.
  // readdirSync briefly opens one extra fd (for the readdir itself) but
  // releases it on return — the count is accurate at the moment of
  // sampling. On platforms without /dev/fd, fall back to 0.
  if (isWindows) return 0;
  try { return readdirSync('/dev/fd').length; }
  catch { return 0; }
}

function refreshDarwinUsedBytes(): void {
  execFile('/usr/bin/vm_stat', { timeout: 1500 }, (err, stdout) => {
    if (err || !stdout) return;
    // Page size header: "(page size of 16384 bytes)". macOS-arm64 = 16K,
    // macOS-x86_64 = 4K — never assume.
    const pageMatch = stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
    const read = (label: string): number => {
      const m = stdout.match(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    const wired = read('Pages wired down');
    const active = read('Pages active');
    const compressed = read('Pages occupied by compressor');
    const used = (wired + active + compressed) * pageSize;
    if (Number.isFinite(used) && used > 0) lastDarwinUsedBytes = used;
  });
}

function tick(): void {
  try {
    const memTotal = totalmem();
    // On macOS, fire vm_stat for the next tick (async — uses last result for
    // *this* tick). On Linux/other platforms, freemem() already excludes
    // page cache from "free", so total - free is the right answer.
    let memUsed: number;
    if (isDarwin) {
      refreshDarwinUsedBytes();
      memUsed = lastDarwinUsedBytes ?? Math.max(0, memTotal - freemem());
    } else {
      memUsed = Math.max(0, memTotal - freemem());
    }
    const stats: SystemStats = {
      memUsedBytes: memUsed,
      memTotalBytes: memTotal,
      cpuPct: computeCpuPct(),
      loadAvg: loadavg() as [number, number, number],
      fdCount: readFdCount(),
      fdLimit,
      gpuCount,
      gpuCores
    };
    lastBroadcast = stats;
    safeSend(IPC.SystemStats, stats);
  } catch {
    /* sampling must never crash the main process */
  }
}

export function startSystemStatsBroadcaster(): void {
  if (timer) return;
  // Prime the CPU sampler so the first real tick has a delta to work with.
  prevCpu = snapshotCpu();
  // Prime macOS used-bytes too so the first tick after mount has a real
  // number to report instead of the buggy total-minus-free fallback.
  if (isDarwin) refreshDarwinUsedBytes();
  // Probe the fd soft limit once at startup; it doesn't change at runtime.
  probeFdLimit();
  // GPU config likewise doesn't change at runtime (eGPU hot-plug aside).
  probeGpuInfo();
  // Fire once immediately so a freshly-mounted renderer sees something
  // before the first interval elapses, then settle into the regular cadence.
  setTimeout(tick, 250);
  timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function getLastSystemStats(): SystemStats | null {
  return lastBroadcast;
}
