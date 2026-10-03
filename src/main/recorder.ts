import { app, desktopCapturer, ipcMain, screen, systemPreferences } from 'electron';
import { createWriteStream, type WriteStream } from 'fs';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { CaptureSource, RecordingHandle, RecordingResult } from '@shared/types';
import { workspace } from './workspace.js';
import { onShutdown } from './lifecycle.js';

// Screen recording, main-process half.
//
// `desktopCapturer` is main-only since Electron 17, so the renderer asks here
// for the list of capturable surfaces and gets back ids it can hand to
// getUserMedia. The bytes flow the other way: MediaRecorder in the renderer
// emits a chunk every second and ships it straight to the open file handle
// below. Nothing buffers the whole video — a 20-minute 4K capture is ~1 GB,
// which is exactly the kind of thing the memory watchdog exists to complain
// about.

type ActiveRecording = {
  path: string;
  stream: WriteStream;
  bytes: number;
  /** Set while a write is in flight so finish() can wait it out. */
  queue: Promise<void>;
};

const active = new Map<string, ActiveRecording>();

/** Where finished recordings land: ~/Videos/OpenDev (or the OS equivalent). */
function recordingsDir(): string {
  // `videos` is a real Electron path on every desktop platform; the web
  // server's stand-in falls back to its data dir, which is also fine.
  return join(app.getPath('videos'), 'OpenDev');
}

/** `opendev-myproject-20260921-142233.webm` — sorts chronologically. */
function fileName(ext: string): string {
  const root = workspace.getRoot();
  const project = root ? basename(root).replace(/[^\w.-]+/g, '-').slice(0, 40) : 'session';
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `opendev-${project}-${stamp}.${ext}`;
}

/**
 * macOS gates the microphone behind TCC. Without this the first getUserMedia
 * resolves with a silent track instead of failing, which looks like a bug in
 * the recorder rather than a permission the user never granted.
 */
async function ensureMicAccess(): Promise<{ ok: boolean; reason?: string }> {
  if (process.platform !== 'darwin') return { ok: true };
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return { ok: true };
    if (status === 'denied' || status === 'restricted') {
      return { ok: false, reason: 'Microphone access is blocked in System Settings › Privacy & Security › Microphone.' };
    }
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return granted ? { ok: true } : { ok: false, reason: 'Microphone access was declined.' };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

export function registerRecorderIpc() {
  // Quitting mid-recording still leaves a closed (and usually playable) file
  // rather than a handle the OS has to reap.
  onShutdown(() => closeAllRecordings());

  ipcMain.handle(IPC.RecorderSources, async (): Promise<CaptureSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false
    });
    // Displays come back as "Screen 1" / "Entire Screen"; append the pixel
    // size so a multi-monitor setup is pickable at a glance. Match on
    // display_id rather than array position — the source list is filtered.
    const displays = new Map(screen.getAllDisplays().map((d) => [String(d.id), d]));
    return sources.map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const d = isScreen ? displays.get(String(s.display_id)) : undefined;
      const size = d ? ` (${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)})` : '';
      return {
        id: s.id,
        name: `${s.name}${size}`,
        kind: isScreen ? ('screen' as const) : ('window' as const),
        thumbnail: s.thumbnail.toDataURL()
      };
    });
  });

  ipcMain.handle(IPC.RecorderStart, async (_e, opts: { ext?: string; withMic?: boolean }): Promise<RecordingHandle> => {
    if (opts?.withMic) {
      const mic = await ensureMicAccess();
      if (!mic.ok) throw new Error(mic.reason || 'Microphone unavailable');
    }
    const dir = recordingsDir();
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, fileName(opts?.ext || 'webm'));
    const stream = createWriteStream(path);
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
    const id = randomUUID();
    active.set(id, { path, stream, bytes: 0, queue: Promise.resolve() });
    return { id, path };
  });

  ipcMain.handle(IPC.RecorderChunk, async (_e, id: string, chunk: Uint8Array): Promise<number> => {
    const rec = active.get(id);
    // A chunk arriving after finish/cancel is dropped rather than throwing —
    // MediaRecorder can emit one last `dataavailable` as it winds down.
    if (!rec) return 0;
    const buf = Buffer.from(chunk);
    rec.bytes += buf.byteLength;
    // Serialize writes so chunks can't interleave if two invokes overlap.
    rec.queue = rec.queue.then(
      () => new Promise<void>((resolve, reject) => {
        rec.stream.write(buf, (err) => (err ? reject(err) : resolve()));
      })
    );
    await rec.queue;
    return rec.bytes;
  });

  ipcMain.handle(IPC.RecorderFinish, async (_e, id: string, durationMs = 0): Promise<RecordingResult | null> => {
    const rec = active.get(id);
    if (!rec) return null;
    active.delete(id);
    await rec.queue.catch(() => {});
    await new Promise<void>((resolve) => rec.stream.end(() => resolve()));
    return { path: rec.path, bytes: rec.bytes, durationMs };
  });

  ipcMain.handle(IPC.RecorderCancel, async (_e, id: string): Promise<boolean> => {
    const rec = active.get(id);
    if (!rec) return false;
    active.delete(id);
    await rec.queue.catch(() => {});
    await new Promise<void>((resolve) => rec.stream.end(() => resolve()));
    // A cancelled take is never useful — a partial webm with no duration
    // header mostly won't play anyway.
    await fs.rm(rec.path, { force: true }).catch(() => {});
    return true;
  });
}

/** Called on shutdown so a quit mid-recording still leaves a closed file. */
export function closeAllRecordings(): void {
  for (const [id, rec] of active) {
    active.delete(id);
    try { rec.stream.end(); } catch {}
  }
}
