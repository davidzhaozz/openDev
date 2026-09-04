import { useEffect, useState } from 'react';

// Minimize / maximize / close for the frameless chrome used everywhere except
// macOS (which keeps its native traffic lights inset over the titlebar). The
// glyphs are inline SVG rather than a Segoe icon font so they render the same
// on Windows 10, Windows 11, and Linux.
//
// Sizing follows the Windows convention — 46×full-height hit targets, close
// turning red on hover — so the buttons feel native even though they aren't.

const STROKE = { stroke: 'currentColor', strokeWidth: 1, fill: 'none' } as const;

function Minimize() {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M0 5.5h10" {...STROKE} /></svg>;
}

function Maximize() {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><rect x="0.5" y="0.5" width="9" height="9" {...STROKE} /></svg>;
}

function Restore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M2.5 2.5V0.5h7v7h-2" {...STROKE} />
      <rect x="0.5" y="2.5" width="7" height="7" {...STROKE} />
    </svg>
  );
}

function Close() {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" {...STROKE} /></svg>;
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => window.opendev.window.onMaximizedChanged(setMaximized), []);

  return (
    <div className="window-controls">
      <button className="window-control" onClick={() => window.opendev.window.minimize()} title="Minimize" aria-label="Minimize">
        <Minimize />
      </button>
      <button
        className="window-control"
        onClick={() => window.opendev.window.toggleMaximize().then(setMaximized)}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Restore /> : <Maximize />}
      </button>
      <button className="window-control close" onClick={() => window.opendev.window.close()} title="Close" aria-label="Close">
        <Close />
      </button>
    </div>
  );
}

/** True when this platform needs the buttons above — i.e. anything but macOS. */
export function usesFramelessChrome(): boolean {
  return window.opendev.app.platform() !== 'darwin';
}
