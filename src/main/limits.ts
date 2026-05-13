// Centralized memory caps. Every site that reads from disk, a subprocess,
// a database driver, or a long-running stream should clamp against one of
// these so a runaway producer can't OOM the main process or the renderer.
//
// Numbers are chosen to be comfortably above normal use but well under
// what a 4 GB heap can tolerate alongside everything else the app holds.

export const LIMITS = {
  // Largest file we'll load into the editor or hand to the AI. Files past
  // this throw — Monaco struggles past a few MB anyway, and the renderer
  // would freeze pushing a huge string through IPC.
  fileReadBytes: 10 * 1024 * 1024,

  // DB result rows held in memory and shipped to the renderer. The grid
  // can scroll millions of rows visually but every cell is still a JS
  // value here; 5k is enough to feel "all of it" while staying bounded.
  dbResultRows: 5000,

  // Single subprocess stdout/stderr accumulator (mcp ide_run, brew install,
  // codex/claude CLI capture). Past this the proc is killed and the
  // captured text is marked truncated.
  subprocessBytes: 5 * 1024 * 1024,

  // Stream-json buffer for the Claude CLI before we find a newline. A
  // pathological single line past this means the CLI is misbehaving — we
  // drop the buffer rather than letting it grow without bound.
  aiLineBufferBytes: 16 * 1024 * 1024,

  // Tail of stderr we keep around for diagnostic display.
  aiStderrTailBytes: 256 * 1024,

  // Final concatenated assistant text we ship back to the renderer + save
  // to disk. Anything past this is replaced with a truncation marker.
  aiResponseBytes: 8 * 1024 * 1024,

  // Renderer-side caps (also enforced in the store).
  rendererStreamingTextBytes: 4 * 1024 * 1024,
  rendererConversationMessages: 500,

  // PTY → renderer batching window and per-flush ceiling.
  ptyFlushMs: 16,
  ptyFlushBytes: 256 * 1024,
  // If a terminal is producing data faster than the renderer can absorb
  // we'll keep at most this much in the pending buffer before dropping
  // the oldest chunks (with a marker).
  ptyBacklogBytes: 4 * 1024 * 1024,

  // RSS watchdog thresholds for the main process (bytes).
  rssWarnBytes: 2 * 1024 * 1024 * 1024,     // 2 GB → toast
  rssCriticalBytes: 3 * 1024 * 1024 * 1024  // 3 GB → toast + log
} as const;

// Helper used by buffer-cap sites. Returns the (possibly truncated) string
// along with a flag indicating whether any bytes were dropped.
export function capString(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

// Keep the tail of a growing string within a cap. Used for stderr buffers
// where the most recent output is the diagnostically useful part.
export function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}
