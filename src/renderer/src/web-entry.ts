// Entry point for the browser build.
//
// The desktop app boots as: Electron main → preload (exposes window.opendev) →
// renderer. The web build boots as: WebSocket to the server → the *same*
// preload file, with its `electron` import aliased to a socket-backed
// ipcRenderer → the same renderer. Nothing under src/renderer/ knows the
// difference.
import './styles/global.css';
import '../../web/web.css';
import { connect } from '../../web/rpc';
import { installOverrides } from '../../web/overrides';
import { installWebviewElement } from '../../web/webview';

document.documentElement.classList.add('od-web');

function fatal(message: string, detail?: string): void {
  document.body.innerHTML = `
    <div style="padding:40px;color:#d4d4d4;font:14px -apple-system,BlinkMacSystemFont,sans-serif">
      <h2 style="color:#f48771;margin:0 0 10px">${message}</h2>
      <p style="color:#969696">${detail || ''}</p>
    </div>`;
}

async function boot(): Promise<void> {
  let hello;
  try {
    hello = await connect();
  } catch (err: any) {
    fatal('Cannot reach the OpenDev server', `${err?.message || err} — is <code>npm run web</code> still running?`);
    return;
  }

  // The preload reads the app version off process.env before falling back to a
  // synchronous IPC round-trip, which a browser can't do. Seed it from the
  // server's hello frame so the first branch wins.
  // `platform` matters as much as the version: the renderer branches on it for
  // window chrome, menu accelerators and modifier labels, and the answer that
  // matters is the *server's* platform, since that's whose filesystem and
  // shell the session is driving.
  (globalThis as unknown as { process?: { env: Record<string, string>; platform: string } }).process ??= {
    env: { npm_package_version: hello.version },
    platform: hello.platform
  };

  try {
    // Defines window.opendev — the real preload, running unmodified.
    await import('../../preload/index');

    installWebviewElement();
    installOverrides();

    await import('./main');
  } catch (err: any) {
    console.error('[opendev-web] boot failed', err);
    fatal('OpenDev Web failed to start', err?.message || String(err));
  }
}

void boot();
