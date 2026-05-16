import { BrowserWindow } from 'electron';

// Sending to webContents after the window is destroyed throws
// `Object has been destroyed`. This happens during app quit when child
// processes flush their final stdout/stderr after the window is already
// gone. Wrap every webContents.send so callers never have to think about it.
//
// Broadcasts to every open BrowserWindow (main + any popouts). Renderer-side
// listeners that care about scoping (e.g. AI streaming, debug events) already
// filter by streamId/etc, so spurious deliveries are harmless. Popouts need
// this — without it an AI chat torn into its own window stops streaming.
export function safeSend(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.send(channel, ...args);
    } catch { /* window or webContents torn down between checks */ }
  }
}
