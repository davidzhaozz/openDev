import { ipcMain, safeStorage } from 'electron';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { SavedLogin, SavedLoginSecret, PasswordStoreStatus } from '@shared/types';
import { getStorageDir, readJson, writeJson } from './storage.js';

// Credential store for the embedded browser.
//
// Electron does not bundle Chromium's password manager, so the IDE keeps its
// own: passwords are sealed with safeStorage (DPAPI on Windows, Keychain on
// macOS, the desktop secret service on Linux) and the sealed blobs live in
// logins.json next to the other app state. We never write a plaintext
// password to disk, and if the OS can't give us encryption we refuse to save
// rather than fall back to something weaker.
//
// Unlike keytar (see db.ts) safeStorage is in-process and never raises a
// system prompt, so it can't hang an IPC handler.

type StoredEntry = {
  id: string;
  /** Scheme + host + port, e.g. https://github.com — the autofill key. */
  origin: string;
  username: string;
  /** safeStorage ciphertext, base64. Never plaintext. */
  secret: string;
  createdAt: number;
  updatedAt: number;
};

type StoreFile = {
  version: 1;
  entries: StoredEntry[];
  /** Origins the user answered "Never" for; we stop offering to save. */
  neverSave: string[];
};

const EMPTY: StoreFile = { version: 1, entries: [], neverSave: [] };

function storePath(): string {
  return join(getStorageDir(), 'logins.json');
}

async function read(): Promise<StoreFile> {
  const f = await readJson<StoreFile>(storePath(), EMPTY);
  return {
    version: 1,
    entries: Array.isArray(f.entries) ? f.entries : [],
    neverSave: Array.isArray(f.neverSave) ? f.neverSave : []
  };
}

async function write(f: StoreFile): Promise<void> {
  await writeJson(storePath(), f);
}

function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function seal(plain: string): string {
  return safeStorage.encryptString(plain).toString('base64');
}

function unseal(sealed: string): string | null {
  try { return safeStorage.decryptString(Buffer.from(sealed, 'base64')); } catch { return null; }
}

/**
 * Normalizes a page URL to the origin we key credentials on. Port and scheme
 * are part of it so http://localhost:3000 and http://localhost:5173 stay
 * separate logins — the common case for a dev browser.
 */
export function originOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** What the renderer may see in a list: everything except the password. */
function toPublic(e: StoredEntry): SavedLogin {
  return { id: e.id, origin: e.origin, username: e.username, updatedAt: e.updatedAt };
}

export function registerPasswordsIpc() {
  ipcMain.handle(IPC.PasswordsStatus, async (): Promise<PasswordStoreStatus> => {
    const f = await read();
    return {
      encryptionAvailable: encryptionAvailable(),
      count: f.entries.length,
      neverSave: f.neverSave
    };
  });

  ipcMain.handle(IPC.PasswordsList, async (): Promise<SavedLogin[]> => {
    const f = await read();
    return f.entries
      .map(toPublic)
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  });

  // Plaintext leaves the main process only here, only for one origin, and
  // only so the guest page can be filled in. The renderer never caches it.
  ipcMain.handle(IPC.PasswordsForOrigin, async (_e, rawUrl: string): Promise<SavedLoginSecret[]> => {
    const origin = originOf(rawUrl);
    if (!origin) return [];
    const f = await read();
    const out: SavedLoginSecret[] = [];
    for (const e of f.entries) {
      if (e.origin !== origin) continue;
      const password = unseal(e.secret);
      if (password == null) continue;
      out.push({ id: e.id, origin: e.origin, username: e.username, password });
    }
    return out;
  });

  ipcMain.handle(IPC.PasswordsSave, async (_e, input: { url: string; username: string; password: string }) => {
    const origin = originOf(input?.url ?? '');
    if (!origin) return { ok: false, error: 'Only http and https pages can have a saved login.' };
    if (!input.password) return { ok: false, error: 'No password to save.' };
    if (!encryptionAvailable()) {
      return { ok: false, error: 'This system has no OS credential encryption available, so the password was not saved.' };
    }
    const f = await read();
    const now = Date.now();
    // One entry per (origin, username): re-logging in updates the password
    // rather than stacking duplicates.
    const existing = f.entries.find(e => e.origin === origin && e.username === input.username);
    if (existing) {
      existing.secret = seal(input.password);
      existing.updatedAt = now;
    } else {
      f.entries.push({
        id: randomUUID(),
        origin,
        username: input.username,
        secret: seal(input.password),
        createdAt: now,
        updatedAt: now
      });
    }
    f.neverSave = f.neverSave.filter(o => o !== origin);
    await write(f);
    return { ok: true, origin };
  });

  ipcMain.handle(IPC.PasswordsDelete, async (_e, id: string) => {
    const f = await read();
    const before = f.entries.length;
    f.entries = f.entries.filter(e => e.id !== id);
    await write(f);
    return { ok: f.entries.length < before };
  });

  ipcMain.handle(IPC.PasswordsNeverSave, async (_e, rawUrl: string) => {
    const origin = originOf(rawUrl);
    if (!origin) return { ok: false };
    const f = await read();
    if (!f.neverSave.includes(origin)) f.neverSave.push(origin);
    // "Never" also means forget what is already there for that site.
    f.entries = f.entries.filter(e => e.origin !== origin);
    await write(f);
    return { ok: true, origin };
  });

  ipcMain.handle(IPC.PasswordsAllowSave, async (_e, rawUrl: string) => {
    const origin = originOf(rawUrl);
    if (!origin) return { ok: false };
    const f = await read();
    f.neverSave = f.neverSave.filter(o => o !== origin);
    await write(f);
    return { ok: true, origin };
  });
}
