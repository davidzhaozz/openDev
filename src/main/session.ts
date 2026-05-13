import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import { workspace } from './workspace.js';

export type SessionTab =
  | { kind: 'file'; path: string }
  | { kind: 'terminal'; name: string; cwd: string }
  | { kind: 'browser'; name: string; url: string }
  | { kind: 'sql'; name: string }
  | { kind: 'es'; name: string };

export type SessionState = {
  tabs: SessionTab[];
  activeIndex?: number;
  rightTab?: 'ai' | 'db' | 'es';
  sqlConnId?: string;
  sqlText?: string;
  esText?: string;
};

function sessionPath(): string {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return join(root, '.opendev', 'session.json');
}

export function registerSessionIpc() {
  ipcMain.handle(IPC.SessionSave, async (_e, state: SessionState) => {
    const root = workspace.getRoot();
    if (!root) return false;
    try {
      await fs.mkdir(join(root, '.opendev'), { recursive: true });
      await fs.writeFile(sessionPath(), JSON.stringify(state, null, 2), 'utf8');
      return true;
    } catch (err: any) {
      console.error('[session] save failed', err?.message || err);
      return false;
    }
  });

  ipcMain.handle(IPC.SessionLoad, async (): Promise<SessionState | null> => {
    const root = workspace.getRoot();
    if (!root) return null;
    try {
      const raw = await fs.readFile(sessionPath(), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
}
