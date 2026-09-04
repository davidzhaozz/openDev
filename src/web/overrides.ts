// The handful of things a browser tab has to do differently from a desktop
// window: native file pickers, tearing a tab into its own window, the app menu,
// and "reveal in Finder". Everything else on window.opendev reaches the real
// main-process handler untouched.
import { addListener, emitLocal, getHello } from './rpc';
import { pickRemotePath } from './picker';

type Api = typeof window.opendev;

export function installOverrides(): void {
  const api = window.opendev as Api & Record<string, any>;
  const isMac = getHello().platform === 'darwin';

  /* ------------------------------------------------------------- pickers */

  const originalOpen = api.workspace.open.bind(api.workspace);
  api.workspace.pick = async () => {
    const dir = await pickRemotePath({ title: 'Open project', mode: 'dir', confirmLabel: 'Open' });
    if (!dir) return undefined;
    return await originalOpen(dir);
  };

  api.projects.pickDir = async () =>
    await pickRemotePath({ title: 'Where should the project go?', mode: 'dir', confirmLabel: 'Select' });

  const importFrom = api.agents.importFrom.bind(api.agents);
  api.agents.importPick = async () => {
    const src = await pickRemotePath({ title: 'Import agent', mode: 'file', confirmLabel: 'Import' });
    return src ? await importFrom(src) : null;
  };

  api.aiLocal.pickBinary = async () =>
    await pickRemotePath({ title: 'Select model binary', mode: 'file', confirmLabel: 'Select' });

  /* ------------------------------------------------------ pop-out windows */

  // Tab tear-off becomes a real browser window pointed at the same bundle;
  // the query string is identical to the one the Electron popouts use, so
  // renderer/src/main.tsx routes it to <Popout> / <PopoutAi> unchanged.
  const openPopout = (params: URLSearchParams, w: number, h: number): boolean => {
    const win = window.open(`${location.pathname}?${params}`, '_blank', `popup=yes,width=${w},height=${h}`);
    if (!win) { toast('Your browser blocked the pop-out window.'); return false; }
    return true;
  };

  api.window.popoutFile = async (path: string) => {
    const p = new URLSearchParams({ popout: '1', path });
    return openPopout(p, 1000, 720);
  };

  api.window.popoutAi = async (opts: { conversationId?: string; name?: string; initialPrompt?: string } = {}) => {
    const p = new URLSearchParams({ popout: 'ai' });
    if (opts.conversationId) p.set('convId', opts.conversationId);
    if (opts.name) p.set('name', opts.name);
    if (opts.initialPrompt) p.set('prompt', opts.initialPrompt);
    return openPopout(p, 880, 760);
  };

  /* --------------------------------------------------------------- misc */

  // Settings that ask for a relaunch just want a fresh renderer; the server
  // side of those settings is re-read on demand.
  api.app.relaunch = async () => { location.reload(); };

  // There is no Finder on the far end of a socket.
  api.fs.reveal = async (path: string) => {
    toast(`Reveal in Finder isn't available in the browser — ${path}`);
    return false;
  };

  addListener('web:open-external', (_e, url) => { window.open(String(url), '_blank', 'noopener'); });

  /* ------------------------------------------------------ menu shortcuts */

  // Only macOS servers need this. The renderer binds these four accelerators
  // itself whenever the platform is not macOS (there's no native menu bar on
  // a frameless window), so binding here too would fire each action twice.
  if (!isMac) return;

  const accelerators: Array<{ key: string; shift?: boolean; action: string }> = [
    { key: ',', action: 'settings' },
    { key: 'o', action: 'open-project' },
    { key: 'n', shift: true, action: 'new-project' },
    { key: 'w', shift: true, action: 'close-project' }
  ];

  window.addEventListener('keydown', (e) => {
    if (!e.metaKey) return;
    const hit = accelerators.find(
      (a) => a.key === e.key.toLowerCase() && !!a.shift === e.shiftKey
    );
    if (!hit) return;
    e.preventDefault();
    emitLocal('menu:event', [hit.action]);
  });
}

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;

function toast(message: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'od-web-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), 3200);
}
