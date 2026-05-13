import { app } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { AppSettings } from '@shared/types';

let baseDir = '';

const DEFAULT_SETTINGS: AppSettings = {
  recentWorkspaces: [],
  theme: 'dark'
};

export function getStorageDir(): string {
  return baseDir;
}

export function projectKey(root: string): string {
  return createHash('sha1').update(root).digest('hex').slice(0, 16);
}

export async function initStorage() {
  baseDir = join(app.getPath('appData'), 'openDev');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(join(baseDir, 'conversations'), { recursive: true });
  await fs.mkdir(join(baseDir, 'services'), { recursive: true });
  await fs.mkdir(join(baseDir, 'tasks'), { recursive: true });
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, path);
}

const settingsPath = () => join(baseDir, 'settings.json');

export async function loadSettings(): Promise<AppSettings> {
  return readJson<AppSettings>(settingsPath(), DEFAULT_SETTINGS);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeJson(settingsPath(), settings);
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const s = await loadSettings();
  const next = { ...s, ...patch };
  await saveSettings(next);
  return next;
}
