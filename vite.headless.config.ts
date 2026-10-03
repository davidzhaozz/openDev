// Node build of the OpenDev main process, for the CI smoke test only.
//
// Bundles src/main/** — unchanged — against src/headless/electron.ts, so
// scripts/smoke-headless.mjs exercises the same filesystem, git, terminal,
// LSP, database, and AI code the desktop app runs.
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';

// src/main/browser.ts pulls `getMainWindow` from src/main/index.ts, which is
// the Electron app entry — window creation, menus, the quit handler. The
// headless server owns its own lifecycle, so that one import is redirected to a stub.
function stubElectronEntry(): Plugin {
  return {
    name: 'opendev-stub-electron-entry',
    // Ahead of vite's own resolver, which would find the real module first.
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './index.js' && importer && importer.includes(`${resolve('src/main')}/`)) {
        return resolve('src/headless/mainWindow.ts');
      }
      return null;
    }
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      electron: resolve('src/headless/electron.ts')
    }
  },
  plugins: [stubElectronEntry()],
  build: {
    ssr: resolve('src/headless/index.ts'),
    outDir: resolve('out-headless'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'index.mjs', chunkFileNames: '[name].mjs' }
    }
  }
});
