import { app } from 'electron';
import { mkdirSync, createWriteStream, type WriteStream } from 'fs';
import { join } from 'path';

let stream: WriteStream | null = null;

export function getLogPath(): string {
  return join(app.getPath('logs'), 'main.log');
}

export function initFileLogger() {
  try {
    const dir = app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(join(dir, 'main.log'), { flags: 'a' });
    stream.on('error', () => { stream = null; });

    const wrap = (level: string, orig: (...args: unknown[]) => void) => (...args: unknown[]) => {
      try {
        stream?.write(`[${new Date().toISOString()}] [${level}] ${args.map(stringify).join(' ')}\n`);
      } catch {}
      try { orig(...args); } catch {}
    };
    console.log = wrap('info', console.log.bind(console));
    console.warn = wrap('warn', console.warn.bind(console));
    console.error = wrap('error', console.error.bind(console));
  } catch {}
}

function stringify(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
