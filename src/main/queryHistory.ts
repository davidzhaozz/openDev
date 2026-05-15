import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IPC } from '@shared/ipc';
import type { QueryHistoryEntry, QueryHistoryKind } from '@shared/types';
import { workspace } from './workspace.js';

// Per-workspace persistent history for the SQL + ES workspaces. Stored as
// .opendev/<key>-history.json under the workspace root. Capped to the most
// recent MAX_ENTRIES so the file stays small.

const MAX_ENTRIES = 200;

function historyPath(kind: QueryHistoryKind): string {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return join(root, '.opendev', `${kind}-history.json`);
}

async function readHistory(kind: QueryHistoryKind): Promise<QueryHistoryEntry[]> {
  if (!workspace.getRoot()) return [];
  try {
    const raw = await fs.readFile(historyPath(kind), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: QueryHistoryEntry[] };
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}

async function writeHistory(kind: QueryHistoryKind, entries: QueryHistoryEntry[]): Promise<void> {
  const root = workspace.getRoot();
  if (!root) return;
  await fs.mkdir(join(root, '.opendev'), { recursive: true });
  await fs.writeFile(historyPath(kind), JSON.stringify({ entries }, null, 2), 'utf8');
}

async function append(kind: QueryHistoryKind, entry: QueryHistoryEntry): Promise<QueryHistoryEntry[]> {
  if (!workspace.getRoot()) return [];
  const entries = await readHistory(kind);
  // Newest first; drop any older identical entry (same text + connId) to
  // avoid the dropdown filling with the same query.
  const filtered = entries.filter((e) => !(e.text === entry.text && e.connId === entry.connId));
  filtered.unshift(entry);
  const capped = filtered.slice(0, MAX_ENTRIES);
  await writeHistory(kind, capped);
  return capped;
}

async function clear(kind: QueryHistoryKind): Promise<void> {
  if (!workspace.getRoot()) return;
  await writeHistory(kind, []);
}

export function registerHistoryIpc(): void {
  ipcMain.handle(IPC.HistoryRead, (_e, kind: QueryHistoryKind) => readHistory(kind));
  ipcMain.handle(IPC.HistoryAppend, (_e, kind: QueryHistoryKind, entry: QueryHistoryEntry) => append(kind, entry));
  ipcMain.handle(IPC.HistoryClear, (_e, kind: QueryHistoryKind) => clear(kind));
}
