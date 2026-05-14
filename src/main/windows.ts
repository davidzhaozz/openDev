import { BrowserWindow, app } from 'electron';
import { join } from 'path';

export function createPopoutWindow(path: string) {
  // Use app.getAppPath() (the path to the asar bundle in packaged builds,
  // the project root in dev) so path resolution doesn't depend on where
  // this file ends up after bundling (e.g. it gets split into a chunks/
  // subdirectory, which broke __dirname-based resolution).
  const appRoot = app.getAppPath();
  const preloadPath = join(appRoot, 'out', 'preload', 'index.mjs');
  const rendererHtml = join(appRoot, 'out', 'renderer', 'index.html');

  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    title: path.split('/').pop() || 'OpenDev IDE',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  win.on('ready-to-show', () => win.show());
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const q = `popout=1&path=${encodeURIComponent(path)}`;
  if (devUrl) {
    win.loadURL(`${devUrl}?${q}`);
  } else {
    win.loadFile(rendererHtml, { search: q });
  }
}
