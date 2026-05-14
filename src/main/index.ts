import { app, BrowserWindow, shell, dialog, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { registerIpc } from './ipc.js';
import { initStorage } from './storage.js';
import { workspace } from './workspace.js';
import { shutdownAll } from './lifecycle.js';
import { hydrateShellPath } from './shellEnv.js';
import { initFileLogger, getLogPath } from './log.js';
import { LIMITS } from './limits.js';
import { safeSend } from './safeSend.js';
import { IPC } from '@shared/ipc';

// Raise the V8 old-space cap for the renderer/utility processes (where
// large editor buffers, DB result sets, and AI streams actually live).
// `appendSwitch('js-flags', ...)` propagates to child processes; the main
// process itself has its own --max-old-space-size hint in package.json
// scripts. 4 GB gives the per-site caps in limits.ts room to land.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// Force the runtime display name everywhere Electron asks (Cmd-Tab,
// menu bar, default window title, permission prompts) instead of the
// lowercased package.json `name`.
app.setName('OpenDev IDE');

// Suppress Node deprecation / experimental warnings — these emit via process
// warning handler, which then tries to write to stderr; if the pipe is closed
// (common in packaged .app launches) it throws EPIPE and surfaces as an
// uncaught exception dialog. Off-by-default in production.
if (!process.env.OPENDEV_VERBOSE) process.env.NODE_NO_WARNINGS = '1';

// Belt-and-braces: swallow EPIPE on stdio so a closed pipe can never crash us.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
  });
}

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('[uncaught]', err);
  try {
    dialog.showErrorBox('OpenDev IDE error', `${err?.message || err}\n\n${err?.stack || ''}`);
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  const code = (reason as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
  console.error('[unhandledRejection]', reason);
});

// PATH from a Finder-launched .app is /usr/bin:/bin:/usr/sbin:/sbin. Without
// this, every `npm run dev`-style service start fails because npm/node/tsx
// live in /opt/homebrew/bin or /usr/local/bin. Hydrate before any spawn.
hydrateShellPath();

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Transparent backing so the user-controllable `--bg-alpha` CSS variable
    // can make the panels see-through. Defaults to full opacity until the
    // user moves the slider in Settings.
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Drop the reference when the window is gone — otherwise `mainWindow`
  // keeps pointing at a destroyed BrowserWindow, and any later access to
  // `.webContents` (e.g. a menu action) throws "Object has been destroyed".
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.NODE_ENV === 'development' || process.env.OPENDEV_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer crashed]', details);
  });

  mainWindow.webContents.on('preload-error', (_e, path, error) => {
    console.error('[preload error]', path, error);
  });

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level >= 2 ? '[renderer error]' : '[renderer]';
    if (level >= 2 || process.env.OPENDEV_VERBOSE === '1') {
      console.log(`${tag} ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('[did-fail-load]', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'));
  }
}

function sendMenu(action: string) {
  // The macOS app menu stays active even with no window open. If the user
  // closed the window and then hits e.g. ⌘O, recreate the window and
  // deliver the action once its renderer has loaded.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:event', action);
    return;
  }
  createWindow();
  mainWindow!.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.send('menu:event', action);
  });
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-project') },
        { label: 'Close Project', accelerator: 'Shift+CmdOrCtrl+W', click: () => sendMenu('close-project') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  initFileLogger();
  console.log('app start', {
    version: app.getVersion(),
    appPath: app.getAppPath(),
    execPath: process.execPath,
    pid: process.pid,
    logPath: getLogPath()
  });
  await initStorage();
  buildAppMenu();
  // No auto-restore: the renderer shows a project picker / recents list
  // and the user explicitly chooses what to open.
  registerIpc();
  createWindow();
  startMemoryWatchdog();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Sample the main-process RSS every 30s and notify the renderer when it
// crosses warning/critical thresholds. This is the last line of defense
// after the per-site caps in limits.ts — it tells the user something is
// wrong before the OS starts swapping the machine.
let watchdogTimer: NodeJS.Timeout | null = null;
let lastNotifiedLevel: 'ok' | 'warn' | 'critical' = 'ok';
function startMemoryWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    try {
      const { rss, heapUsed, heapTotal } = process.memoryUsage();
      let level: 'ok' | 'warn' | 'critical' = 'ok';
      if (rss > LIMITS.rssCriticalBytes) level = 'critical';
      else if (rss > LIMITS.rssWarnBytes) level = 'warn';
      if (level !== lastNotifiedLevel) {
        lastNotifiedLevel = level;
        const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
        if (level !== 'ok') {
          console.warn(`[memory ${level}] rss=${mb(rss)} heap=${mb(heapUsed)}/${mb(heapTotal)}`);
        }
        safeSend(IPC.MemoryWarning, {
          level,
          rss,
          heapUsed,
          heapTotal,
          message: level === 'critical'
            ? `Memory pressure critical (${mb(rss)} RSS). Close some tabs/services or restart the IDE.`
            : level === 'warn'
              ? `Memory usage high (${mb(rss)} RSS). Consider closing unused tabs.`
              : ''
        });
      }
    } catch (err) {
      console.error('[memory watchdog]', err);
    }
  }, 30_000);
  watchdogTimer.unref?.();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  // Hard cap so a stuck service can't keep the app from exiting.
  const cap = setTimeout(() => app.exit(0), 6000);
  try { await shutdownAll(); } catch (err) { console.error('shutdown error', err); }
  clearTimeout(cap);
  app.exit(0);
});

export function getMainWindow(): BrowserWindow | null {
  // Never hand back a destroyed window — callers (safeSend etc.) treat a
  // null result as "no window", but would throw on a destroyed one.
  if (mainWindow && mainWindow.isDestroyed()) return null;
  return mainWindow;
}
