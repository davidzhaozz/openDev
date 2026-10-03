import { BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getStorageDir, writeJson } from './storage.js';
import { IPC } from '@shared/ipc';

// Window transparency is macOS-only. On Windows a `transparent: true` window
// loses its resize border (Electron cannot hit-test the edges of a layered
// window), loses Aero Snap, and makes DWM composite every frame through a
// per-pixel-alpha surface — which is why pop-outs could not be dragged larger
// and why the whole IDE cost noticeably more GPU/CPU than an opaque window.
// Linux compositors vary enough that opaque is the safe default there too.
export const SUPPORTS_TRANSPARENCY = process.platform === 'darwin';

// Opaque windows paint this before the renderer's first frame, so a resize or
// a slow load never flashes white. Matches --bg-0 in global.css.
const OPAQUE_BG = '#1e1e1e';

/** Main-window titlebar height the renderer lays out (global.css .app). */
export const TITLEBAR_HEIGHT = { main: 36 } as const;

/**
 * Chrome for every IDE window. macOS keeps traffic lights inset over our own
 * titlebar. Linux stays frameless with renderer-drawn controls
 * (WindowControls.tsx).
 *
 * Windows, measured with WM_NCHITTEST: both `frame: false` and
 * `titleBarStyle: 'hidden'` leave only a ~5px resize zone *inside* the
 * window edge — Electron takes over the non-client area, so the standard
 * invisible border outside the edge is gone. Only a real native frame keeps
 * it. So:
 *  - pop-outs (`kind: 'popout'`), which get dragged and resized all the
 *    time, use the native frame and resize like any other Windows app;
 *  - the main window, usually maximized, keeps our own titlebar with the
 *    native caption buttons overlaid on it (`titleBarOverlay`), which still
 *    gives Snap Layouts on the maximize button.
 */
export function windowChromeOptions(kind: 'main' | 'popout' = 'main'): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'win32' && kind === 'popout') {
    return { frame: true, autoHideMenuBar: true, transparent: false, backgroundColor: OPAQUE_BG };
  }
  if (process.platform === 'win32') {
    const titlebarHeight = TITLEBAR_HEIGHT.main;
    return {
      titleBarStyle: 'hidden',
      // One px short of the titlebar so its bottom border still shows under
      // the buttons. Colors are re-synced from the theme (setTitleBarOverlay).
      titleBarOverlay: { color: '#252526', symbolColor: '#cccccc', height: titlebarHeight - 1 },
      transparent: false,
      backgroundColor: OPAQUE_BG
    };
  }
  if (SUPPORTS_TRANSPARENCY) {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
      transparent: true,
      backgroundColor: '#00000000'
    };
  }
  return { frame: false, thickFrame: true, transparent: false, backgroundColor: OPAQUE_BG };
}

/**
 * Show a `show: false` window once it has something to paint. With
 * titleBarOverlay on Windows, `ready-to-show` does not reliably fire for the
 * IDE's windows (the page loads, the event never comes, and the window stays
 * hidden forever), so `did-finish-load` backs it up. The opaque
 * backgroundColor means showing a frame early never flashes white.
 */
export function showWhenReady(win: BrowserWindow): void {
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', show);
  win.webContents.once('did-finish-load', show);
}

export function wireMaximizeEvents(win: BrowserWindow): void {
  const send = () => { if (!win.isDestroyed()) win.webContents.send(IPC.WindowMaximizedChanged, win.isMaximized()); };
  win.on('maximize', send);
  win.on('unmaximize', send);
}

/* --------------------------------------------------------- remembered bounds */

type Saved = { x: number; y: number; width: number; height: number; maximized?: boolean };

const statePath = () => join(getStorageDir(), 'window-state.json');
let cache: Record<string, Saved> | null = null;

function load(): Record<string, Saved> {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(statePath(), 'utf8')); } catch { cache = {}; }
  return cache!;
}

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeJson(statePath(), load()).catch(() => {});
  }, 500);
}

/**
 * Size/position a window was last left at, if it still lands on a connected
 * display — otherwise the defaults, so unplugging a monitor can never strand
 * a window off-screen.
 */
export function savedBounds(key: string, width: number, height: number): Partial<Saved> & { width: number; height: number } {
  const s = load()[key];
  if (!s) return { width, height };
  const area = screen.getDisplayMatching(s).workArea;
  const visible = s.x < area.x + area.width - 64 && s.x + s.width > area.x + 64 &&
    s.y >= area.y - 8 && s.y < area.y + area.height - 64;
  return visible ? s : { width: s.width, height: s.height };
}

/** Persist this window's bounds under `key` whenever the user moves or resizes it. */
export function rememberBounds(win: BrowserWindow, key: string): void {
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const maximized = win.isMaximized();
    // While maximized keep the last restored size, so un-maximizing next
    // session returns to it rather than to a screen-sized "normal" window.
    const b = maximized ? load()[key] ?? win.getNormalBounds() : win.getBounds();
    load()[key] = { ...b, maximized };
    scheduleFlush();
  };
  win.on('resized', save);
  win.on('moved', save);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('close', save);
  if (load()[key]?.maximized) win.once('show', () => win.maximize());
}
