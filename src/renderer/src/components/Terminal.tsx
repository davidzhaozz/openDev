import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

type Props = {
  cwd?: string;
  onReady?: (termId: string) => void;
};

export function TerminalView({ cwd, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const xRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const offRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!hostRef.current) return;
    const cssEditor = getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim();
    const fontPx = cssEditor ? parseFloat(cssEditor) : 12.5;
    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, monospace',
      fontSize: fontPx || 12.5,
      allowTransparency: true,
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#d4d4d4',
        cursor: '#1177bb',
        black: '#000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5'
      },
      convertEol: true,
      cursorBlink: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    xRef.current = term;
    fitRef.current = fit;
    setTimeout(() => { try { fit.fit(); } catch {} }, 0);

    let disposed = false;
    (async () => {
      const dims = { cols: term.cols, rows: term.rows };
      const r = await window.opendev.term.create({ cwd, cols: dims.cols, rows: dims.rows });
      if (disposed) { window.opendev.term.kill(r.id); return; }
      idRef.current = r.id;
      onReady?.(r.id);
      offRef.current.push(window.opendev.term.onData(({ id, data }) => {
        if (id === r.id) term.write(data);
      }));
      offRef.current.push(window.opendev.term.onExit(({ id }) => {
        if (id === r.id) term.write('\r\n[process exited]\r\n');
      }));
      term.onData((s) => { window.opendev.term.write(r.id, s); });
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const id = idRef.current;
        if (id) window.opendev.term.resize(id, term.cols, term.rows);
      } catch {}
    });
    ro.observe(hostRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      for (const off of offRef.current) off();
      const id = idRef.current;
      if (id) window.opendev.term.kill(id);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="terminal-pane"><div ref={hostRef} className="xterm" style={{ height: '100%' }} /></div>;
}
