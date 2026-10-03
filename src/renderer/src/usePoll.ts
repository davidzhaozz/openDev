import { useEffect, useRef } from 'react';

/**
 * setInterval that only ticks while the window is actually on screen.
 *
 * Several panels poll main for state that can't be pushed (listening ports,
 * the conversation list). Those polls are cheap in the renderer and expensive
 * in main — the ports poll alone reads the whole process table and the TCP
 * listener table. Left on a plain setInterval they keep paying that cost for
 * an IDE that has been minimized behind a browser for eight hours.
 *
 * Electron sets document.hidden when a window is minimized or fully occluded,
 * so this pauses exactly when nobody can see the result and resumes with an
 * immediate tick — the panel is never left showing a stale reading once it is
 * back on screen.
 *
 * `fn` is read from a ref, so callers don't need to memoize it.
 */
export function useVisiblePoll(fn: () => void | Promise<void>, intervalMs: number): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    // A poll can outlast the interval on a loaded machine. Without this the
    // ticks stack up behind each other and make it slower still.
    let running = false;

    const tick = async () => {
      if (cancelled || running) return;
      running = true;
      try { await fnRef.current(); }
      catch { /* a failed poll is the caller's business, not the timer's */ }
      finally { running = false; }
    };

    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };

    const start = () => {
      if (timer !== null) return;
      void tick();
      timer = setInterval(tick, intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
