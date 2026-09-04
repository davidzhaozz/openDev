// WebSocket transport standing in for Electron's IPC channel.
//
// One socket carries three things: request/response for `invoke`, a push
// stream for everything main broadcasts through safeSend, and a hello frame
// with the values the preload would otherwise read synchronously.

export type Hello = { version: string; platform: string };

type Listener = (event: unknown, ...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

let socket: WebSocket | null = null;
let nextId = 1;
let hello: Hello = { version: '0.0.0', platform: 'darwin' };
let closedForGood = false;
let backoff = 500;

export function getHello(): Hello { return hello; }

function url(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/rpc`;
}

/** Opens the socket and resolves once the server's hello frame lands. */
export function connect(): Promise<Hello> {
  return new Promise((resolveHello, rejectHello) => {
    let settled = false;
    const ws = new WebSocket(url());
    socket = ws;

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === 'hello') {
        hello = { version: msg.version, platform: msg.platform };
        backoff = 500;
        if (!settled) { settled = true; resolveHello(hello); }
        return;
      }
      if (msg.t === 'res') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.v);
        else p.reject(new Error(msg.e || 'IPC call failed'));
        return;
      }
      if (msg.t === 'ev') {
        const set = listeners.get(msg.ch);
        if (!set) return;
        for (const fn of [...set]) {
          try { fn(null, ...(msg.args || [])); } catch (err) { console.error('[opendev-web] listener', msg.ch, err); }
        }
      }
    };

    ws.onerror = () => { if (!settled) { settled = true; rejectHello(new Error('Could not reach the OpenDev server')); } };

    ws.onclose = () => {
      socket = null;
      for (const [, p] of pending) p.reject(new Error('Connection to the OpenDev server was lost'));
      pending.clear();
      if (closedForGood) return;
      setConnected(false);
      // Reconnect with backoff. State lives on the server, so a dropped
      // socket costs the in-flight calls, not the session.
      setTimeout(() => {
        connect().then(() => setConnected(true)).catch(() => {});
      }, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    ws.onopen = () => setConnected(true);
  });
}

export function invoke(channel: string, args: unknown[]): Promise<unknown> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Not connected to the OpenDev server (${channel})`));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket!.send(JSON.stringify({ t: 'call', id, ch: channel, args }));
  });
}

export function addListener(channel: string, fn: Listener): void {
  let set = listeners.get(channel);
  if (!set) { set = new Set(); listeners.set(channel, set); }
  set.add(fn);
}

export function removeListener(channel: string, fn: Listener): void {
  listeners.get(channel)?.delete(fn);
}

export function shutdown(): void {
  closedForGood = true;
  socket?.close();
}

/* ------------------------------------------------- connection status banner */

let banner: HTMLDivElement | null = null;

function setConnected(ok: boolean): void {
  if (ok) { banner?.remove(); banner = null; return; }
  if (banner) return;
  banner = document.createElement('div');
  banner.className = 'od-web-offline';
  banner.textContent = 'Reconnecting to the OpenDev server…';
  document.body.appendChild(banner);
}

/** Deliver a frame to local listeners as if the server had pushed it. */
export function emitLocal(channel: string, args: unknown[]): void {
  const set = listeners.get(channel);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(null, ...args); } catch (err) { console.error('[opendev-web] listener', channel, err); }
  }
}
