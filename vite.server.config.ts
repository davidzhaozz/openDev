// Node build of the OpenDev main process.
//
// Bundles src/main/** — unchanged — against src/server/electron.ts, so the
// desktop app and the web server run the same filesystem, git, terminal, LSP,
// database, and AI code.
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';

// src/main/browser.ts pulls `getMainWindow` from src/main/index.ts, which is
// the Electron app entry — window creation, menus, the quit handler. The web
// server owns its own lifecycle, so that one import is redirected to a stub.
function stubElectronEntry(): Plugin {
  return {
    name: 'opendev-stub-electron-entry',
    // Ahead of vite's own resolver, which would find the real module first.
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './index.js' && importer && importer.includes(`${resolve('src/main')}/`)) {
        return resolve('src/server/mainWindow.ts');
      }
      return null;
    }
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      electron: resolve('src/server/electron.ts')
    }
  },
  plugins: [stubElectronEntry()],
  build: {
    ssr: resolve('src/server/index.ts'),
    outDir: resolve('out-web/server'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'index.mjs', chunkFileNames: '[name].mjs' }
    }
  }
});
