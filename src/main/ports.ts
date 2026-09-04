import { ipcMain } from 'electron';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { IPC } from '@shared/ipc';
import type { ListeningPort } from '@shared/types';
import { IS_WIN, killPids } from './platform.js';

const pexec = promisify(exec);
const pexecFile = promisify(execFile);

/* --------------------------------------------------------------- macOS/Linux */

async function listListeningPortsPosix(): Promise<ListeningPort[]> {
  const { stdout } = await pexec('lsof -nP -iTCP -sTCP:LISTEN -F pcPn', { maxBuffer: 4 * 1024 * 1024 });
  const ports: ListeningPort[] = [];
  let cur: Partial<ListeningPort> & { protocol?: 'tcp' | 'udp' } = {};
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      if (cur.port && cur.pid) ports.push(cur as ListeningPort);
      cur = { pid: Number(val), protocol: 'tcp' };
    } else if (tag === 'c') {
      cur.command = val;
    } else if (tag === 'n') {
      const m = val.match(/:(\d+)(?:\s|$)/) || val.match(/:(\d+)$/);
      if (m) cur.port = Number(m[1]);
    } else if (tag === 'P') {
      cur.protocol = val.toLowerCase() === 'udp' ? 'udp' : 'tcp';
    }
  }
  if (cur.port && cur.pid) ports.push(cur as ListeningPort);
  return ports;
}

async function pidsOnPortPosix(port: number): Promise<number[]> {
  try {
    const { stdout } = await pexec(`lsof -ti:${port}`, { timeout: 2000 });
    return parsePids(stdout.split(/\s+/));
  } catch {
    // lsof exits 1 when nothing matches — that's "port is free", not an error.
    return [];
  }
}

/* -------------------------------------------------------------------- Windows */

// `netstat -ano` is the one listener query that needs no elevation and exists
// on every Windows since XP:
//   Proto  Local Address        Foreign Address   State       PID
//   TCP    0.0.0.0:5173         0.0.0.0:0         LISTENING   18244
//   TCP    [::]:5173            [::]:0            LISTENING   18244
const NETSTAT_ROW = /^\s*(TCP|UDP)\s+(\S+)\s+\S+\s+(?:(\S+)\s+)?(\d+)\s*$/;

function portFromLocalAddress(address: string): number | null {
  // IPv6 rows look like [::]:5173 or [::1]:5173 — take the port after the
  // last colon, which is unambiguous in both families.
  const m = address.match(/:(\d+)$/);
  return m ? Number(m[1]) : null;
}

async function listListeningPortsWindows(): Promise<ListeningPort[]> {
  const { stdout } = await pexecFile('netstat', ['-ano'], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
    windowsHide: true
  });
  const ports: ListeningPort[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(NETSTAT_ROW);
    if (!m) continue;
    const [, proto, local, state, pidText] = m;
    // UDP rows have no state column and are never "listening" in the sense
    // the ports panel means, so only TCP LISTENING is collected.
    if (proto === 'TCP' && state !== 'LISTENING') continue;
    if (proto === 'UDP') continue;
    const port = portFromLocalAddress(local);
    const pid = Number(pidText);
    if (!port || !pid) continue;
    // tasklist fills the name in below; PID is the honest placeholder.
    ports.push({ port, pid, protocol: 'tcp', command: `pid ${pid}` });
  }
  return withProcessNames(ports);
}

/** netstat gives PIDs but no names; tasklist fills them in with one extra call. */
async function withProcessNames(ports: ListeningPort[]): Promise<ListeningPort[]> {
  if (ports.length === 0) return ports;
  try {
    const { stdout } = await pexecFile('tasklist', ['/FO', 'CSV', '/NH'], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 8000,
      windowsHide: true
    });
    const names = new Map<number, string>();
    for (const line of stdout.split('\n')) {
      // "node.exe","18244","Console","1","120,456 K"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ''));
    }
    for (const p of ports) p.command = names.get(p.pid) ?? p.command;
  } catch { /* names are cosmetic — the port list is still useful without them */ }
  return ports;
}

async function pidsOnPortWindows(port: number): Promise<number[]> {
  const all = await listListeningPortsWindows().catch(() => [] as ListeningPort[]);
  return parsePids(all.filter((p) => p.port === port).map((p) => String(p.pid)));
}

/* ----------------------------------------------------------------- shared API */

function parsePids(raw: string[]): number[] {
  const pids = raw
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    // PID 0 / 4 are the Windows System processes; killing them is not an option.
    .filter((n) => n > 4 || !IS_WIN);
  return [...new Set(pids)];
}

export async function listListeningPorts(): Promise<ListeningPort[]> {
  try {
    const ports = IS_WIN ? await listListeningPortsWindows() : await listListeningPortsPosix();
    return Array.from(new Map(ports.map((p) => [`${p.port}-${p.protocol}`, p])).values())
      .sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

/** PIDs currently listening on `port`, whatever the platform. */
export async function pidsOnPort(port: number): Promise<number[]> {
  return IS_WIN ? pidsOnPortWindows(port) : pidsOnPortPosix(port);
}

export async function waitForPort(port: number, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ports = await listListeningPorts();
    if (ports.some(p => p.port === port)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// Kill whatever process is currently listening on `port`. Returns the
// list of PIDs that were killed (empty if the port was already free).
// Always forced — graceful is pointless here, the user wants the port back.
export async function freePort(port: number): Promise<{ killed: number[]; error?: string }> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { killed: [], error: 'invalid port' };
  }
  try {
    const pids = await pidsOnPort(port);
    if (pids.length === 0) return { killed: [] };
    await killPids(pids);
    // Give the OS a beat to release the socket.
    await new Promise(r => setTimeout(r, 200));
    return { killed: pids };
  } catch (e: any) {
    return { killed: [], error: e?.message || String(e) };
  }
}

export function registerPortsIpc() {
  ipcMain.handle(IPC.PortsList, () => listListeningPorts());
  ipcMain.handle(IPC.PortsFree, (_e, port: number) => freePort(port));
}
