import { ipcMain, dialog, shell, app } from 'electron';
import { IPC } from '@shared/ipc';
import { workspace } from './workspace.js';
import { loadSettings, patchSettings } from './storage.js';
import { registerFsIpc } from './fs.js';
import { registerSearchIpc } from './search.js';
import { registerLspIpc } from './lsp.js';
import { registerAiIpc } from './ai.js';
import { registerServicesIpc } from './services.js';
import { registerTasksIpc } from './tasks.js';
import { registerPortsIpc } from './ports.js';
import { registerDbIpc } from './db.js';
import { registerGitIpc } from './git.js';
import { registerTerminalIpc } from './term.js';
import { registerBrowserIpc } from './browser.js';
import { startIdeMcpServer } from './mcp.js';
import { registerSessionIpc } from './session.js';
import { registerToolsIpc } from './tools.js';
import { registerAgentsIpc } from './agents.js';
import { registerPeersIpc } from './peers.js';
import { registerDebugIpc } from './debug.js';
import { registerProjectsIpc } from './projects.js';
import { registerPackagesIpc } from './packages.js';
import { registerHistoryIpc } from './queryHistory.js';
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

  registerFsIpc();
  registerSearchIpc();
  registerLspIpc();
  registerAiIpc();
  registerServicesIpc();
  registerTasksIpc();
  registerPortsIpc();
  registerDbIpc();
  registerGitIpc();
  registerTerminalIpc();
  registerBrowserIpc();
  registerSessionIpc();
  registerToolsIpc();
  registerAgentsIpc();
  registerPeersIpc();
  registerDebugIpc();
  registerProjectsIpc();
  registerPackagesIpc();
  registerHistoryIpc();

  startIdeMcpServer().catch((err) => console.error('mcp start failed', err));

  // Popout window for a single file (tab tear-off). Wiring lives here so the
  // main entry can stay focused on lifecycle.
  electronIpc.handle(IPC.WindowPopoutFile, async (_e, path: string) => {
    const { createPopoutWindow } = await import('./windows.js');
    createPopoutWindow(path);
    return true;
  });

  electronIpc.handle(IPC.WindowPopoutAi, async (_e, opts: { conversationId?: string; name?: string; initialPrompt?: string } = {}) => {
    const { createPopoutAiWindow } = await import('./windows.js');
    createPopoutAiWindow(opts);
    return true;
  });
}
