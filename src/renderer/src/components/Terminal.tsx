import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import type { ITerminalOptions } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

type Props = {
  cwd?: string;
  /**
   * Whether this terminal's tab is the visible one. Undefined means "assume
   * visible" so a lone terminal still takes focus.
   */
  active?: boolean;
  onReady?: (termId: string) => void;
};

/**
 * Fonts the terminal can actually rely on. xterm measures one glyph and lays
 * every cell out on that advance width, so a stack that falls through to a
 * proportional face (or to Courier New's odd metrics) is what produces
 * columns that drift out of alignment as output scrolls.
 */
function monoStack(platform: string): string {
  if (platform === 'win32') return "'Cascadia Mono', Consolas, 'Lucida Console', monospace";
  if (platform === 'darwin') return "'SF Mono', Menlo, Monaco, monospace";
  return "'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', monospace";
}

/**
 * xterm applies ConPTY/winpty compatibility workarounds based on what the
 * backend is. Getting this wrong in either direction shows up as doubled
 * blank lines or lines that refuse to reflow, so only claim ConPTY when we
 * can actually read the Windows build number.
 */
function windowsPtyOption(platform: string): ITerminalOptions['windowsPty'] {
  if (platform !== 'win32') return undefined;
  try {
    const version = window.opendev.app.osVersion?.() || '';
    const build = Number(version.split('.')[2]);
    if (!Number.isFinite(build)) return undefined;
    return { backend: 'conpty', buildNumber: build };
  } catch {
    return undefined;
  }
}

export function TerminalView({ cwd, active, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const xRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const offRef = useRef<(() => void)[]>([]);
  const sizeRef = useRef({ cols: 0, rows: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cssEditor = getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim();
    const fontPx = cssEditor ? parseFloat(cssEditor) : 12.5;
    let platform = 'darwin';
    try { platform = window.opendev.app.platform(); } catch { /* default */ }

    const term = new XTerm({
      fontFamily: monoStack(platform),
      fontSize: fontPx || 12.5,
      allowTransparency: true,
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#d4d4d4',
        cursor: '#1177bb',
        black: '#000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5'
      },
      // NO convertEol here. A PTY already sends CRLF, and rewriting bare LF
      // into CRLF corrupts the cursor moves that PSReadLine / readline use to
      // redraw the prompt — that shows up as duplicated or staircased lines.
      cursorBlink: true,
      scrollback: 5000,
      windowsPty: windowsPtyOption(platform)
    });
    // Ctrl+C is overloaded in a terminal: with text selected it has to
    // copy, with nothing selected it has to reach the shell as an interrupt.
    // xterm sends the interrupt byte for both, so the copy case is caught
    // here. macOS is exempt — Cmd+C copies there, Ctrl+C stays the interrupt.
    const controlCCopies = platform !== 'darwin';
    term.attachCustomKeyEventHandler((e) => {
      if (!controlCCopies || e.type !== 'keydown') return true;
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return true;
      if (e.key.toLowerCase() !== 'c') return true;
      const selection = term.getSelection();
      if (!selection) return true;
      void navigator.clipboard.writeText(selection).catch(() => {});
      // Drop the selection, or the next Ctrl+C copies the same text again
      // instead of interrupting whatever the user has just started.
      term.clearSelection();
      e.preventDefault();
      return false;
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    xRef.current = term;
    fitRef.current = fit;

    // Fit, then push the resulting size to the PTY. Both halves have to agree
    // on cols/rows or the shell wraps at a different column than we render at,
    // which is what makes long command lines come out scrambled.
    const applyFit = (): boolean => {
      const el = hostRef.current;
      // A background tab is display:none; measuring it yields garbage sizes.
      if (!el || el.offsetParent === null || el.clientWidth < 2 || el.clientHeight < 2) return false;
      try { fit.fit(); } catch { return false; }
      if (!Number.isFinite(term.cols) || !Number.isFinite(term.rows) || term.cols < 2 || term.rows < 1) return false;
      const id = idRef.current;
      if (!id) return true;
      if (term.cols === sizeRef.current.cols && term.rows === sizeRef.current.rows) return true;
      sizeRef.current = { cols: term.cols, rows: term.rows };
      window.opendev.term.resize(id, term.cols, term.rows);
      return true;
    };

    // Keystrokes can arrive before the PTY exists — Cmd+` and typing
    // immediately is a normal thing to do. Registering the handler now and
    // buffering until we have an id means those characters reach the shell
    // instead of being dropped.
    const pending: string[] = [];
    term.onData((s) => {
      const id = idRef.current;
      if (id) window.opendev.term.write(id, s);
      else pending.push(s);
    });

    let disposed = false;
    (async () => {
      // One frame so the pane has its real width before we measure it. The
      // old code created the PTY at xterm's 80x24 default and never corrected
      // it, so the shell believed the window was 80 columns wide forever.
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      if (disposed) return;
      applyFit();
      const cols = term.cols, rows = term.rows;
      sizeRef.current = { cols, rows };

      const r = await window.opendev.term.create({ cwd, cols, rows });
      if (disposed) { window.opendev.term.kill(r.id); return; }
      idRef.current = r.id;
      for (const s of pending.splice(0)) window.opendev.term.write(r.id, s);
      onReady?.(r.id);
      offRef.current.push(window.opendev.term.onData(({ id, data }) => {
        if (id === r.id) term.write(data);
      }));
      offRef.current.push(window.opendev.term.onExit(({ id }) => {
        if (id === r.id) term.write('\r\n[process exited]\r\n');
      }));
      // The pane may have been resized while we were awaiting the spawn.
      applyFit();
    })();

    // Coalesce resize storms (dragging the splitter, switching tabs) into one
    // fit per frame; every fit is a full reflow of the scrollback.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; applyFit(); });
    });
    ro.observe(host);

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      for (const off of offRef.current) off();
      offRef.current = [];
      const id = idRef.current;
      if (id) window.opendev.term.kill(id);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecting a terminal tab has to put the caret in the terminal, or the
  // first thing the user types goes nowhere (the tab strip isn't focusable,
  // so focus just stays on whatever they left). Focus on the next frame: the
  // pane is still display:none when `active` flips, and a hidden textarea
  // can't take focus.
  useEffect(() => {
    if (active === false) return;
    let raf = requestAnimationFrame(() => { raf = 0; xRef.current?.focus(); });
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [active]);

  return <div className="terminal-pane"><div ref={hostRef} className="terminal-host" style={{ height: '100%' }} /></div>;
}
