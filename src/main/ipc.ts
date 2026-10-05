import { ipcMain, dialog, shell, app, BrowserWindow, Menu } from 'electron';
import { IPC } from '@shared/ipc';
import { workspace } from './workspace.js';
import { loadSettings, patchSettings } from './storage.js';
import { registerFsIpc } from './fs.js';
import { registerSearchIpc } from './search.js';
import { registerLspIpc } from './lsp.js';
import { registerAiIpc } from './ai.js';
import { registerServicesIpc } from './services.js';
import { registerTasksIpc } from './tasks.js';
import { registerJiraIpc } from './jira.js';
import { registerPortsIpc } from './ports.js';
import { registerDbIpc } from './db.js';
import { registerGitIpc } from './git.js';
import { registerTerminalIpc } from './term.js';
import { registerBrowserIpc } from './browser.js';
import { registerBrowserClockIpc } from './browserClock.js';
import { registerPasswordsIpc } from './passwords.js';
import { startIdeMcpServer, registerMcpIpc } from './mcp.js';
import { registerSessionIpc } from './session.js';
import { registerToolsIpc } from './tools.js';
import { registerAgentsIpc } from './agents.js';
import { registerPeersIpc } from './peers.js';
import { registerDebugIpc } from './debug.js';
import { registerProjectsIpc } from './projects.js';
import { registerPackagesIpc } from './packages.js';
import { registerHistoryIpc } from './queryHistory.js';
import { registerRestIpc } from './rest.js';
import { registerAiLocalIpc } from './aiLocal.js';
import { registerClaudeAuthIpc } from './claudeAuth.js';
import { registerMlxIpc } from './mlx.js';
import { registerPythonIpc } from './python.js';
import { registerRunConfigsIpc } from './runConfigs.js';
import { registerPipIpc } from './pip.js';
import { registerLocalModelsIpc } from './localModels.js';
import { registerRecorderIpc } from './recorder.js';
import { registerNetworkIpc } from './netlog.js';
import { ipcMain as electronIpc } from 'electron';

export function registerIpc() {
  ipcMain.on('__opendev_version__', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.handle(IPC.WorkspaceCurrent, () => workspace.getRoot());
  ipcMain.handle(IPC.WorkspaceOpen, async (_e, p: string) => {
    await workspace.open(p);
    return workspace.getRoot();
  });
  ipcMain.handle(IPC.WorkspacePick, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || r.filePaths.length === 0) return null;
    await workspace.open(r.filePaths[0]);
    return workspace.getRoot();
  });
  ipcMain.handle(IPC.WorkspaceClose, () => workspace.close());
  ipcMain.handle(IPC.FsReveal, (_e, p: string) => {
    shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle(IPC.SettingsGet, () => loadSettings());
  ipcMain.handle(IPC.SettingsSet, (_e, patch) => patchSettings(patch));

  // Full app relaunch — used by settings that need to re-bind sockets or
  // change main-process startup behavior (e.g. MCP LAN exposure).
  ipcMain.handle(IPC.AppRelaunch, () => {
    app.relaunch();
    app.exit(0);
  });

  // Manual "free unused resources" trigger from the bottom-bar widget.
  // Kills all idle LSP servers (they respawn lazily on next use) and
  // hints V8 to compact. Renderer-side drops its own log buffers
  // independently. Returns the per-stage savings for a useful toast.
  ipcMain.handle(IPC.SystemFreeMemory, async () => {
    const { killAllLspServers } = await import('./lsp.js');
    const before = process.memoryUsage().rss;
    const lspsKilled = killAllLspServers();
    // V8 gc() is only exposed with --expose-gc, which the IDE doesn't
    // launch with — so we don't try to call it. Killing the LSP children
    // is the load-bearing reclaim; their RSS frees back to the OS.
    // Give the OS a beat to reap the children before measuring.
    await new Promise((r) => setTimeout(r, 250));
    const after = process.memoryUsage().rss;
    return { lspsKilled, mainRssBefore: before, mainRssAfter: after };
  });

  registerFsIpc();
  registerSearchIpc();
  registerLspIpc();
  registerAiIpc();
  registerServicesIpc();
  registerTasksIpc();
  registerJiraIpc();
  registerPortsIpc();
  registerDbIpc();
  registerGitIpc();
  registerTerminalIpc();
  registerBrowserIpc();
  registerBrowserClockIpc();
  registerPasswordsIpc();
  registerSessionIpc();
  registerToolsIpc();
  registerAgentsIpc();
  registerPeersIpc();
  registerDebugIpc();
  registerProjectsIpc();
  registerPackagesIpc();
  registerHistoryIpc();
  registerRestIpc();
  registerAiLocalIpc();
  registerClaudeAuthIpc();
  registerMlxIpc();
  registerPythonIpc();
  registerRunConfigsIpc();
  registerPipIpc();
  registerLocalModelsIpc();
  registerRecorderIpc();
  registerNetworkIpc();

  // Gate the MCP HTTP server on the user's opt-in setting. Default true
  // for backward compat; users who toggle it off in Settings get the
  // ~20-30 MB back next launch.
  // Register MCP IPC handlers unconditionally so the Settings UI can read
  // status / trigger a restart even when the server is currently disabled.
  registerMcpIpc();
  loadSettings().then((s) => {
    if (s.mcpEnabled === false) {
      console.log('[mcp] disabled via settings — not starting HTTP server');
      return;
    }
    startIdeMcpServer().catch((err) => console.error('mcp start failed', err));
  }).catch(() => {
    // If settings load fails, fall through to the historical behavior.
    startIdeMcpServer().catch((err) => console.error('mcp start failed', err));
  });

  // Popout window for a single file (tab tear-off). Wiring lives here so the
  // main entry can stay focused on lifecycle.
  electronIpc.handle(IPC.WindowPopoutFile, async (_e, path: string, placement?: { atCursor?: boolean }) => {
    const { createPopoutWindow } = await import('./windows.js');
    createPopoutWindow(path, placement || {});
    return true;
  });

  electronIpc.handle(IPC.WindowPopoutAi, async (_e, opts: { conversationId?: string; name?: string; initialPrompt?: string; atCursor?: boolean } = {}) => {
    const { createPopoutAiWindow } = await import('./windows.js');
    createPopoutAiWindow(opts);
    return true;
  });

  // Window controls for the frameless (non-macOS) chrome. Each acts on the
  // window that sent the request, so pop-outs control themselves.
  const senderWindow = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
  electronIpc.handle(IPC.WindowMinimize, (e) => { senderWindow(e)?.minimize(); return true; });
  electronIpc.handle(IPC.WindowMaximizeToggle, (e) => {
    const win = senderWindow(e);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  electronIpc.handle(IPC.WindowClose, (e) => { senderWindow(e)?.close(); return true; });
  // Windows' native caption buttons are painted by the OS over our titlebar;
  // keep their background and glyphs in step with the active theme.
  electronIpc.handle(IPC.WindowSetOverlayColors, (e, color: string, symbolColor: string) => {
    const win = senderWindow(e);
    if (process.platform !== 'win32' || !win) return false;
    try { win.setTitleBarOverlay({ color, symbolColor }); return true; } catch { return false; }
  });

  // Application-menu bridge for the frameless chrome. The renderer draws the
  // bar; the items it pops are the real Menu objects built in index.ts, so
  // labels, accelerators, enablement and click handlers stay in one place.
  electronIpc.handle(IPC.MenuTopLevel, () => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return [];
    return menu.items
      .map((item, index) => ({ index, label: item.label, enabled: item.enabled }))
      .filter((i) => i.label);
  });
  electronIpc.handle(IPC.MenuPopup, (e, index: number, x: number, y: number) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.items[index];
    const win = senderWindow(e);
    if (!item?.submenu || !win) return false;
    // Round: Electron rejects fractional coordinates from getBoundingClientRect.
    item.submenu.popup({ window: win, x: Math.round(x), y: Math.round(y) });
    return true;
  });
}
