import { app, ipcMain, nativeImage, webContents, type WebContents } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import { getMainWindow } from './index.js';
import { safeSend } from './safeSend.js';
import { workspace } from './workspace.js';

export function registerBrowserIpc() {
  ipcMain.handle(IPC.BrowserScreenshotRect, async (_e, rect: { x: number; y: number; width: number; height: number }) => {
    const win = getMainWindow();
    if (!win) return null;
    const image = await win.capturePage(rect);
    return image.toDataURL();
  });
  ipcMain.handle(IPC.BrowserCaptureReady, (_e, reqId: string, res: CaptureTarget) => {
    const p = pendingCaptures.get(reqId);
    if (!p) return false;
    pendingCaptures.delete(reqId);
    clearTimeout(p.timer);
    p.resolve(res);
    return true;
  });
}

/* ------------------------------------------------- AI browser screenshots */

// The AI's view of the browser panel (ide_browser_screenshot). Which tab to
// shoot is renderer state, so the renderer picks it — the active browser tab,
// else the last one, else a new tab for `url` — brings it to the front so it
// paints, waits for the load, and answers with its webContents id. The shot
// itself is taken here.

type CaptureTarget = { webContentsId?: number; loadError?: string; error?: string };
const pendingCaptures = new Map<string, { resolve: (r: CaptureTarget) => void; timer: NodeJS.Timeout }>();

/** Where shots are written. The Slack bridge attaches files from here. */
export function screenshotDir(): string {
  return join(app.getPath('temp'), 'opendev-screenshots');
}

export type BrowserShot = { file: string; png: Buffer; width: number; height: number; url: string; title: string; loadError?: string };

export async function captureBrowser(opts: { url?: string; fullPage?: boolean; waitMs?: number } = {}): Promise<BrowserShot> {
  if (!getMainWindow()) throw new Error('The IDE window is not open, so there is no browser panel to capture.');
  // Without a project the IDE shows its welcome screen, which has no tabs.
  if (!workspace.getRoot()) throw new Error('No project is open in the IDE, so there is no browser panel. Open a project first.');
  const reqId = randomUUID();
  const target = await new Promise<CaptureTarget>((resolve) => {
    const timer = setTimeout(() => {
      pendingCaptures.delete(reqId);
      resolve({ error: 'The browser tab did not become ready within 30s.' });
    }, 30_000);
    pendingCaptures.set(reqId, { resolve, timer });
    safeSend('mcp:command', { kind: 'browser-capture', reqId, url: opts.url });
  });
  if (target.error) throw new Error(target.error);
  const wc = target.webContentsId ? webContents.fromId(target.webContentsId) : undefined;
  if (!wc || wc.isDestroyed()) throw new Error('The browser tab closed before it could be captured.');
  const extra = Math.min(Math.max(Number(opts.waitMs) || 0, 0), 15_000);
  if (extra) await new Promise((r) => setTimeout(r, extra));

  let png: Buffer | undefined;
  if (!opts.fullPage) {
    // stayHidden: the IDE may be minimized or behind other windows (the
    // usual case when the request came from Slack); capture anyway.
    const img = await wc.capturePage(undefined, { stayHidden: true });
    if (!img.isEmpty()) png = img.toPNG();
  }
  // Full page, or a viewport capture that came back empty (a window
  // Chromium considers occluded): DevTools renders the page itself.
  if (!png) png = await captureViaCdp(wc, !!opts.fullPage);

  const size = nativeImage.createFromBuffer(png).getSize();
  const dir = screenshotDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `browser-${stamp}.png`);
  await fs.writeFile(file, png);
  return { file, png, width: size.width, height: size.height, url: wc.getURL(), title: wc.getTitle(), loadError: target.loadError };
}

// Chromium caps a capture at 16384px; a taller page is cut there.
const MAX_FULL_PAGE_PX = 16_000;

async function captureViaCdp(wc: WebContents, fullPage: boolean): Promise<Buffer> {
  const dbg = wc.debugger;
  // The network log usually holds the debugger already; borrow it rather
  // than attach (only one client per page), and leave it as found.
  const mine = !dbg.isAttached();
  if (mine) dbg.attach('1.3');
  try {
    const params: Record<string, unknown> = { format: 'png' };
    if (fullPage) {
      const m: any = await dbg.sendCommand('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), MAX_FULL_PAGE_PX), scale: 1 };
    }
    const r: any = await dbg.sendCommand('Page.captureScreenshot', params);
    return Buffer.from(r.data, 'base64');
  } finally {
    if (mine) { try { dbg.detach(); } catch { /* page gone */ } }
  }
}

/** A copy small enough to hand the model: longest side ≤ 1600px, JPEG. */
export function modelImage(png: Buffer): { data: string; mimeType: string } {
  let img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  if (longest > 1600) {
    img = width >= height ? img.resize({ width: 1600, quality: 'good' }) : img.resize({ height: 1600, quality: 'good' });
  }
  return { data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' };
}
