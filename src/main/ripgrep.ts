import { existsSync } from 'fs';
import { rgPath as resolvedRgPath } from '@vscode/ripgrep';

/**
 * Absolute path to the ripgrep binary, safe to hand to `spawn`.
 *
 * `@vscode/ripgrep` locates its binary with `require.resolve`, which in a
 * packaged build answers with a path *inside* `app.asar`. Electron's fs shim
 * reads through the archive transparently, so `existsSync` on that path is
 * even true — but `spawn` goes straight to the OS, which knows nothing about
 * asar, and find-in-files died with ENOENT. The binary is unpacked (see
 * `asarUnpack` in electron-builder.yml); only the resolved path needs
 * redirecting at the one segment that names the archive.
 *
 * In dev there is no `app.asar` segment, so the path is returned untouched.
 */
const unpackedSibling = (p: string): string =>
  p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

const unpacked = unpackedSibling(resolvedRgPath);

export const rgPath = unpacked !== resolvedRgPath && existsSync(unpacked) ? unpacked : resolvedRgPath;
