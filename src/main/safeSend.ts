import { getMainWindow } from './index.js';

// Sending to webContents after the window is destroyed throws
// `Object has been destroyed`. This happens during app quit when child
// processes flush their final stdout/stderr after the window is already
// gone. Wrap every webContents.send so callers never have to think about it.
//
// NB: BrowserWindow.webContents is a getter that itself throws on a destroyed
// window, so the isDestroyed() check must happen before we ever touch the
// getter, and the whole thing is wrapped just in case anything else does.
export function safeSend(channel: string, ...args: unknown[]): void {
  try {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, ...args);
  } catch { /* window or webContents torn down between checks */ }
}
