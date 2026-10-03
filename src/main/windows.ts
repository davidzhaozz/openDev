import { BrowserWindow, app, screen, shell } from 'electron';
import { join } from 'path';
import { baseName } from '@shared/paths';
import { windowChromeOptions, wireMaximizeEvents, savedBounds, rememberBounds, showWhenReady } from './windowChrome.js';

// Pop-outs never host an embedded browser, so they skip `webviewTag` — each
// window that enables it pays for the guest-view machinery up front.
function popoutWebPreferences(): Electron.WebPreferences {
  // Use app.getAppPath() (the path to the asar bundle in packaged builds,
  // the project root in dev) so path resolution doesn't depend on where
  // this file ends up after bundling (e.g. it gets split into a chunks/
  // subdirectory, which broke __dirname-based resolution).
  return {
    preload: join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false
  };
}

function load(win: BrowserWindow, params: URLSearchParams): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const q = params.toString();
  if (devUrl) win.loadURL(`${devUrl}?${q}`);
  else win.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'), { search: q });
}

export type PopoutPlacement = { atCursor?: boolean };

/**
 * Bounds for a new pop-out: the remembered size, and either the remembered
 * position or — for a tab torn off by dragging — wherever the drop happened,
 * with the cursor over the window's title bar the way a browser tab tears
 * off. Clamped to the display under the cursor.
 */
function popoutBounds(key: string, width: number, height: number, placement: PopoutPlacement) {
  const saved = savedBounds(key, width, height);
  if (!placement.atCursor) return saved;
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).workArea;
  const w = Math.min(saved.width, area.width);
  const h = Math.min(saved.height, area.height);
  const x = Math.min(Math.max(p.x - Math.round(w / 3), area.x), area.x + area.width - w);
  const y = Math.min(Math.max(p.y - 12, area.y), area.y + area.height - h);
  return { x, y, width: w, height: h };
}

function createPopout(key: string, size: { width: number; height: number; minWidth: number; minHeight: number }, title: string, params: URLSearchParams, placement: PopoutPlacement = {}): BrowserWindow {
  const win = new BrowserWindow({
    ...popoutBounds(key, size.width, size.height, placement),
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    show: false,
    ...windowChromeOptions('popout'),
    title,
    webPreferences: popoutWebPreferences()
  });
  // The native frame would otherwise carry the app menu bar (File/Edit/…)
  // on Windows; a pop-out has no use for it.
  win.removeMenu();
  // Links in pop-out content (e.g. an AI chat answer) go to the system
  // browser, same as the main window, instead of spawning a bare window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  showWhenReady(win);
  wireMaximizeEvents(win);
  rememberBounds(win, key);
  load(win, params);
  return win;
}

export function createPopoutWindow(path: string, placement: PopoutPlacement = {}) {
  createPopout(
    'popout-file',
    { width: 1000, height: 720, minWidth: 360, minHeight: 240 },
    baseName(path) || 'OpenDev IDE',
    new URLSearchParams({ popout: '1', path }),
    placement
  );
}

export function createPopoutAiWindow(opts: { conversationId?: string; name?: string; initialPrompt?: string } & PopoutPlacement = {}) {
  const params = new URLSearchParams();
  params.set('popout', 'ai');
  if (opts.conversationId) params.set('convId', opts.conversationId);
  if (opts.name) params.set('name', opts.name);
  if (opts.initialPrompt) params.set('prompt', opts.initialPrompt);
  // Small minimum on purpose: a chat docked beside the editor as a narrow
  // strip is a normal way to use it.
  createPopout('popout-ai', { width: 880, height: 760, minWidth: 320, minHeight: 240 }, opts.name || 'AI Chat', params, { atCursor: opts.atCursor });
}
