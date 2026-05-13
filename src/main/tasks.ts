import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { TaskItem } from '@shared/types';
import { workspace } from './workspace.js';

function storePath(): string {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return join(root, '.opendev', 'tasks.json');
}

async function read(): Promise<TaskItem[]> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    return (JSON.parse(raw) as { items: TaskItem[] }).items ?? [];
  } catch { return []; }
}

async function write(items: TaskItem[]): Promise<void> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace');
  await fs.mkdir(join(root, '.opendev'), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify({ items }, null, 2), 'utf8');
}

export function registerTasksIpc() {
  ipcMain.handle(IPC.TasksList, () => read());
  ipcMain.handle(IPC.TasksSave, async (_e, item: Partial<TaskItem>) => {
    const items = await read();
    const next: TaskItem = {
      id: item.id || randomUUID(),
      title: item.title || 'Untitled',
      done: !!item.done,
      notes: item.notes,
      createdAt: item.createdAt || Date.now()
    };
    const idx = items.findIndex(t => t.id === next.id);
    if (idx >= 0) items[idx] = next; else items.push(next);
    await write(items);
    return next;
  });
  ipcMain.handle(IPC.TasksDelete, async (_e, id: string) => {
    const items = (await read()).filter(t => t.id !== id);
    await write(items);
    return true;
  });
}
