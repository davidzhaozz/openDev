// Drop-in replacement for the `electron` module, used only by the headless
// test server (src/headless/) that CI's smoke test drives.
//
// Every file in src/main/ imports from 'electron', but between them they touch
// a very small slice of it: ipcMain, a handful of app.getPath()/getVersion()
// calls, two dialog helpers, two shell helpers, and BrowserWindow.getAllWindows
// (from safeSend). Aliasing 'electron' to this module in the server bundle lets
// the entire main process run unmodified under plain Node — no forked copies of
// fs.ts / git.ts / db.ts / term.ts to keep in sync with the desktop app.
import { existsSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/* ------------------------------------------------------------------ ipcMain */

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any;
type IpcMainInvokeEvent = { sender: unknown; returnValue?: unknown };

const invokeHandlers = new Map<string, IpcHandler>();
const syncHandlers = new Map<string, IpcHandler>();

export const ipcMain = {
  handle(channel: string, fn: IpcHandler) { invokeHandlers.set(channel, fn); },
  handleOnce(channel: string, fn: IpcHandler) {
    invokeHandlers.set(channel, (...a: Parameters<IpcHandler>) => {
      invokeHandlers.delete(channel);
      return fn(...a);
    });
  },
  removeHandler(channel: string) { invokeHandlers.delete(channel); },
  on(channel: string, fn: IpcHandler) { syncHandlers.set(channel, fn); return ipcMain; },
  removeAllListeners(channel?: string) {
    if (channel) syncHandlers.delete(channel); else syncHandlers.clear();
    return ipcMain;
  }
};

/** Dispatch a renderer `invoke` arriving over the WebSocket. */
export async function dispatchInvoke(channel: string, args: unknown[]): Promise<unknown> {
  const fn = invokeHandlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for "${channel}"`);
  return await fn({ sender: null }, ...args);
}

/** Dispatch a renderer `sendSync` (only `__opendev_version__` uses this). */
export function dispatchSync(channel: string, args: unknown[]): unknown {
  const fn = syncHandlers.get(channel);
  if (!fn) return undefined;
  const event: IpcMainInvokeEvent = { sender: null };
  fn(event, ...args);
  return event.returnValue;
}

export function registeredChannels(): string[] {
  return [...invokeHandlers.keys()];
}

/* -------------------------------------------------------- BrowserWindow-ish */

// safeSend() walks BrowserWindow.getAllWindows() and calls webContents.send on
// each. We hand it one pseudo-window whose `send` fans out to every connected
// test client — which is exactly the semantics safeSend already documents
// (broadcast to main + popouts; listeners filter by streamId themselves).
type Broadcaster = (channel: string, args: unknown[]) => void;
let broadcast: Broadcaster = () => {};
export function setBroadcaster(fn: Broadcaster): void { broadcast = fn; }

const pseudoWebContents = {
  isDestroyed: () => false,
  send: (channel: string, ...args: unknown[]) => broadcast(channel, args)
};

export class BrowserWindow {
  static getAllWindows(): Array<{ isDestroyed(): boolean; webContents: typeof pseudoWebContents }> {
    return [{ isDestroyed: () => false, webContents: pseudoWebContents }];
  }
  static getFocusedWindow() { return null; }
  constructor() {
    // Only reachable via the tab tear-off handlers, which the smoke test
    // never calls.
    throw new Error('BrowserWindow is not available in the headless server');
  }
}

/* -------------------------------------------------------------------- app */

function findAppRoot(): string {
  // Walk up from the bundled server file until we find the package.json that
  // owns node_modules — that directory is what app.getAppPath() means in dev.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

const appRoot = process.env.OPENDEV_APP_ROOT || findAppRoot();

const appVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// Mirrors Electron's per-platform app.getPath(). Default is the same location
// the desktop build uses, so the web server sees the same settings, recent
// projects, and conversations. Set OPENDEV_DATA_DIR to keep them separate.
function appDataRoot(): string {
  if (process.env.OPENDEV_DATA_DIR) return process.env.OPENDEV_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function logsRoot(): string {
  if (process.env.OPENDEV_DATA_DIR) return join(process.env.OPENDEV_DATA_DIR, 'logs');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'OpenDev IDE');
  return join(appDataRoot(), 'OpenDev IDE', 'logs');
}

let appName = 'OpenDev IDE';

export const app = {
  getName: () => appName,
  setName: (n: string) => { appName = n; },
  getVersion: () => appVersion,
  getAppPath: () => appRoot,
  isPackaged: false,
  getPath(name: string): string {
    switch (name) {
      case 'appData': return appDataRoot();
      case 'userData': return join(appDataRoot(), appName);
      case 'logs': return logsRoot();
      case 'home': return homedir();
      case 'temp': return tmpdir();
      case 'downloads': return join(homedir(), 'Downloads');
      case 'videos': return join(homedir(), 'Videos');
      case 'documents': return join(homedir(), 'Documents');
      case 'desktop': return join(homedir(), 'Desktop');
      case 'exe': return process.execPath;
      default: return join(appDataRoot(), appName, name);
    }
  },
  // Lifecycle is owned by src/headless/index.ts; these keep main-process code
  // that reaches for them from crashing.
  whenReady: () => Promise.resolve(),
  on: () => app,
  once: () => app,
  quit: () => { process.emit('SIGTERM' as NodeJS.Signals); },
  exit: (code = 0) => process.exit(code),
  relaunch: () => { /* nothing to relaunch headless */ },
  commandLine: { appendSwitch: () => {}, appendArgument: () => {} }
};

/* ----------------------------------------------------------- dialog / shell */

// Native pickers can't exist headless; every dialog reports "cancelled".
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (title: string, content: string) => console.error(`[dialog] ${title}: ${content}`)
};

export const shell = {
  // Never open windows on a CI runner's desktop.
  openExternal: async (_url: string) => {},
  showItemInFolder: (_p: string) => {},
  openPath: async () => ''
};

export const Menu = {
  buildFromTemplate: (t: unknown) => t,
  setApplicationMenu: () => {},
  getApplicationMenu: () => null
};

export const nativeTheme = { shouldUseDarkColors: true, on: () => {} };
export const clipboard = { readText: () => '', writeText: () => {} };

/* ------------------------------------------------------- screen recording */

// There is no desktop to capture headless. An empty source list is what the
// recorder UI already treats as "nothing to record here", so it degrades to
// a disabled button instead of an error.
export const desktopCapturer = {
  getSources: async () => [] as Array<{
    id: string; name: string; display_id: string; thumbnail: { toDataURL(): string; isEmpty(): boolean };
  }>
};

export const screen = {
  getAllDisplays: () => [] as Array<{ id: number; size: { width: number; height: number }; scaleFactor: number }>,
  getPrimaryDisplay: () => ({ id: 0, size: { width: 0, height: 0 }, scaleFactor: 1 })
};

// The embedded browser's password store (main/passwords.ts) seals with
// safeStorage. Plain Node has no OS keychain of its own, so report encryption
// as unavailable — the store then refuses to save rather than write anything
// weaker.
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (_plain: string): Buffer => { throw new Error('safeStorage is not available in the headless server'); },
  decryptString: (_sealed: Buffer): string => { throw new Error('safeStorage is not available in the headless server'); }
};

export const systemPreferences = {
  getMediaAccessStatus: (_kind: string) => 'granted' as const,
  askForMediaAccess: async (_kind: string) => true
};

// The network log's browser feed attaches a CDP debugger to <webview> tags.
// A browser tab has no webviews to attach to, so the list is always empty and
// only the IDE's own fetch traffic is captured — which is the half the web
// client can actually see anyway.
export const webContents = {
  getAllWebContents: () => [] as Array<{ id: number; getType(): string }>,
  fromId: (_id: number) => undefined
};

// Only the AI's browser screenshots use it, and they stop earlier (no main
// window here).
export const nativeImage = {
  createFromBuffer: () => { throw new Error('nativeImage is not available in the web build'); }
};

// No browser panel in the web build, so no cookie jar to borrow from.
export const session = {
  defaultSession: {
    cookies: { get: async (_filter: { url?: string }) => [] as Array<{ name: string; value: string }> }
  }
};

export default {
  app, ipcMain, dialog, shell, Menu, BrowserWindow, nativeTheme, clipboard,
  desktopCapturer, screen, systemPreferences, webContents, safeStorage
};
