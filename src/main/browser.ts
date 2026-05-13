import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { getMainWindow } from './index.js';

export function registerBrowserIpc() {
  ipcMain.handle(IPC.BrowserScreenshotRect, async (_e, rect: { x: number; y: number; width: number; height: number }) => {
    const win = getMainWindow();
    if (!win) return null;
    const image = await win.capturePage(rect);
    return image.toDataURL();
  });
}
