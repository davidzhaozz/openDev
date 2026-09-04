// Renderer-side stand-in for `electron`, so src/preload/index.ts can be loaded
// straight into the browser.
//
// This is the reason the web client needs no hand-written copy of the ~250
// methods on window.opendev: the preload file is the single definition of the
// API surface, and it only ever touches contextBridge + ipcRenderer.
import { addListener, getHello, invoke, removeListener } from './rpc';

export const contextBridge = {
  // A real contextBridge freezes the exposed object across the isolated-world
  // boundary. There's no boundary here, and the web client patches a few
  // methods (native pickers, pop-out windows) right after exposure, so this
  // stays a plain assignment.
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  }
};

type Listener = (event: unknown, ...args: unknown[]) => void;

export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => invoke(channel, args),
  on(channel: string, listener: Listener) { addListener(channel, listener); return ipcRenderer; },
  once(channel: string, listener: Listener) {
    const wrapped: Listener = (e, ...args) => { removeListener(channel, wrapped); listener(e, ...args); };
    addListener(channel, wrapped);
    return ipcRenderer;
  },
  removeListener(channel: string, listener: Listener) { removeListener(channel, listener); return ipcRenderer; },
  removeAllListeners() { return ipcRenderer; },
  send(channel: string, ...args: unknown[]) { invoke(channel, args).catch(() => { /* fire and forget */ }); },
  // Nothing can block the main thread in a browser. The only sendSync caller
  // is the preload's version probe, which reads process.env first — and the
  // web entry fills that in from the hello frame before the preload loads.
  sendSync(_channel: string): unknown { return getHello().version; }
};

export default { contextBridge, ipcRenderer };
