import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { onShutdown } from './lifecycle.js';
import { randomUUID } from 'crypto';
import { LIMITS } from './limits.js';
import { terminalShell } from './platform.js';

// Coalesce PTY data into ~16ms frames before sending across IPC. Without
// this, `cat huge.log` or `yes` floods the renderer with thousands of
// micro-messages per second. The backlog cap keeps the pending buffer
// bounded if the renderer falls behind — older bytes are dropped first
// (with a marker) so we never hold more than ptyBacklogBytes.
type Batcher = {
  push: (s: string) => void;
  flush: () => void;
  dispose: () => void;
};
function makeBatcher(id: string): Batcher {
  let pending = '';
  let dropped = 0;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (!pending && !dropped) return;
    let data = pending;
    pending = '';
    if (dropped > 0) {
      data = `\r\n[terminal output throttled — dropped ${dropped} bytes]\r\n` + data;
      dropped = 0;
    }
    safeSend(IPC.TermData, { id, data });
  };
  return {
    push: (s) => {
      pending += s;
      // Trim the front of pending if we've outrun the renderer. We keep
      // the tail since that's what the user is actually looking at.
      if (pending.length > LIMITS.ptyBacklogBytes) {
        const overflow = pending.length - LIMITS.ptyBacklogBytes;
        pending = pending.slice(overflow);
        dropped += overflow;
      }
      // Flush immediately when we've accumulated a screenful, otherwise
      // wait one frame to coalesce.
      if (pending.length >= LIMITS.ptyFlushBytes) {
        if (timer) { clearTimeout(timer); timer = null; }
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, LIMITS.ptyFlushMs);
        timer.unref?.();
      }
    },
    flush,
    dispose: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = '';
      dropped = 0;
    }
  };
}

type PTY = {
  write: (s: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (cb: (s: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
};

const terms = new Map<string, PTY>();
const batchers = new Map<string, Batcher>();
let nodePty: typeof import('node-pty') | null = null;

async function loadNodePty(): Promise<typeof import('node-pty') | null> {
  if (nodePty) return nodePty;
  try {
    nodePty = await import('node-pty');
    return nodePty;
  } catch (err) {
    console.error('node-pty unavailable, falling back to child_process', err);
    return null;
  }
}

async function createPty(cwd: string, cols: number, rows: number): Promise<PTY> {
  const pty = await loadNodePty();
  const { file: shell, args: shellArgs } = terminalShell();
  if (pty) {
    const term = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // node-pty drives ConPTY on Windows, which needs a real console host —
      // useConpty:false would fall back to winpty and lose resize fidelity.
      env: process.env as Record<string, string>
    });
    return {
      write: (s) => term.write(s),
      resize: (c, r) => term.resize(c, r),
      kill: (sig) => term.kill(sig),
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(({ exitCode }) => cb(exitCode))
    };
  }
  const { spawn } = await import('child_process');
  // Fallback when node-pty's native module can't load. No TTY, so no prompt
  // redraw or resize — but the shell still runs.
  const child = spawn(shell, shellArgs.length ? shellArgs : ['-i'], { cwd, env: process.env, windowsHide: true });
  return {
    write: (s) => child.stdin?.write(s),
    resize: () => { /* not supported in fallback */ },
    kill: (sig?: string) => child.kill((sig as NodeJS.Signals | undefined) || 'SIGTERM'),
    onData: (cb) => {
      child.stdout?.on('data', (b: Buffer) => cb(b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => cb(b.toString('utf8')));
    },
    onExit: (cb) => child.on('exit', (code) => cb(code ?? 0))
  };
}

export function registerTerminalIpc() {
  ipcMain.handle(IPC.TermCreate, async (_e, opts: { cwd?: string; cols?: number; rows?: number }) => {
    const id = randomUUID();
    const cwd = opts?.cwd || workspace.getRoot() || process.env.HOME || '/';
    const term = await createPty(cwd, opts?.cols ?? 80, opts?.rows ?? 24);
    terms.set(id, term);
    const batcher = makeBatcher(id);
    batchers.set(id, batcher);
    term.onData((s) => batcher.push(s));
    term.onExit((code) => {
      batcher.flush();
      batcher.dispose();
      batchers.delete(id);
      terms.delete(id);
      safeSend(IPC.TermExit, { id, code });
    });
    return { id, cwd };
  });

  ipcMain.handle(IPC.TermWrite, (_e, id: string, data: string) => {
    terms.get(id)?.write(data);
    return true;
  });
  ipcMain.handle(IPC.TermResize, (_e, id: string, cols: number, rows: number) => {
    terms.get(id)?.resize(cols, rows);
    return true;
  });
  ipcMain.handle(IPC.TermKill, (_e, id: string) => {
    terms.get(id)?.kill();
    batchers.get(id)?.dispose();
    batchers.delete(id);
    return true;
  });
}

onShutdown(() => {
  for (const b of batchers.values()) {
    try { b.dispose(); } catch {}
  }
  batchers.clear();
  for (const t of terms.values()) {
    try { t.kill(); } catch {}
  }
});
