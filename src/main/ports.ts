import { ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IPC } from '@shared/ipc';
import type { ListeningPort } from '@shared/types';
import { killPids } from './platform.js';

const pexec = promisify(exec);

/* ------------------------------------------------------------------ lsof */

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

/* ----------------------------------------------------------------- shared API */

function parsePids(raw: string[]): number[] {
  const pids = raw
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(pids)];
}

export async function listListeningPorts(): Promise<ListeningPort[]> {
  try {
    const ports = await listListeningPortsPosix();
    return Array.from(new Map(ports.map((p) => [`${p.port}-${p.protocol}`, p])).values())
      .sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

/** PIDs currently listening on `port`. */
export async function pidsOnPort(port: number): Promise<number[]> {
  return pidsOnPortPosix(port);
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
