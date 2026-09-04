// Browser build of the OpenDev renderer.
//
// Same React app as the desktop build. The only substitution is the `electron`
// module — src/preload/index.ts imports contextBridge + ipcRenderer from it,
// and src/web/electron.ts backs those with a WebSocket to the OpenDev server.
import { existsSync, readFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The build input is index.web.html so it can sit next to the Electron
// index.html; the server still wants to serve it as index.html.
function emitAsIndexHtml(): Plugin {
  let outDir = '';
  return {
    name: 'opendev-web-index-html',
    configResolved(config) { outDir = config.build.outDir; },
    // In dev, "/" would otherwise serve the Electron index.html — which loads
    // main.tsx with no bridge in front of it and renders "preload not loaded".
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) {
          req.url = `/index.web.html${req.url.slice(1)}`;
        }
        next();
      });
    },
    closeBundle() {
      const built = join(outDir, 'index.web.html');
      if (existsSync(built)) renameSync(built, join(outDir, 'index.html'));
    }
  };
}

// In dev the renderer is served by Vite and the API lives in the separate
// `npm run web:server` process, so the WebSocket has to be proxied — with the
// access token the server wrote on first run, and an Origin it will accept.
function devToken(): string {
  const appData = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  try {
    return readFileSync(join(process.env.OPENDEV_DATA_DIR || appData, 'openDev', 'web-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const API_PORT = Number(process.env.OPENDEV_WEB_PORT || 5199);

export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
      electron: resolve('src/web/electron.ts')
    }
  },
  plugins: [react(), emitAsIndexHtml()],
  build: {
    outDir: resolve('out-web/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: resolve('src/renderer/index.web.html') }
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/rpc': {
        target: `ws://127.0.0.1:${API_PORT}`,
        ws: true,
        // changeOrigin rewrites Host to the API server, and the Origin header
        // is set to match — the server rejects an upgrade whose Origin and
        // Host disagree (cross-site WebSocket hijacking guard).
        changeOrigin: true,
        rewrite: (path) => `${path}?token=${devToken()}`,
        headers: { origin: `http://127.0.0.1:${API_PORT}` }
      }
    }
  }
});
