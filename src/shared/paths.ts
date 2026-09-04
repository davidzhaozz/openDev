// Path-string helpers that work for both POSIX and Windows paths, in both
// processes.
//
// The renderer has no `node:path`, so it grew a lot of `p.split('/')`. That is
// correct on macOS and wrong on Windows, where the main process hands back
// `C:\Users\me\project\src\App.tsx`. Everything that needs to pick a path
// apart for display or comparison goes through here instead, and both
// separators are accepted everywhere.

const SEP = /[\\/]/;

/** Path segments, empty ones dropped. `C:\a\b` and `/a/b` both give ['a','b'] (plus 'C:'). */
export function splitPath(p: string): string[] {
  return p.split(SEP).filter(Boolean);
}

/** Last segment: `C:\a\b.ts` → `b.ts`. Returns the input if it has no separator. */
export function baseName(p: string): string {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Everything before the last separator, keeping the original separator style. */
export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return '';
  // Keep the root itself intact: '/a' → '/', 'C:\a' → 'C:\'.
  if (i === 0) return p.slice(0, 1);
  if (/^[a-zA-Z]:$/.test(p.slice(0, i))) return p.slice(0, i + 1);
  return p.slice(0, i);
}

/** `/a/b`, `C:\a`, `C:/a`, and UNC `\\host\share` all count as absolute. */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/][\\/]|\/)/.test(p);
}

/** Forward-slash form, for display and for anything compared as a string. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when `child` is `parent` or sits underneath it. Case-insensitive for Windows paths. */
export function isWithin(child: string, parent: string): boolean {
  const fold = (s: string) => {
    const posix = toPosix(s).replace(/\/+$/, '');
    return /^[a-zA-Z]:/.test(posix) ? posix.toLowerCase() : posix;
  };
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** `/Users/me/x` and `C:\Users\me\x` → `~/x`, for titles and breadcrumbs. */
export function shortenHome(p: string): string {
  return toPosix(p).replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^[a-zA-Z]:\/Users\/[^/]+/, '~');
}

/**
 * Absolute path → `file:` URI, the form language servers and the debug
 * adapter speak.
 *
 * POSIX is nearly a no-op (`/a/b` → `file:///a/b`). Windows needs the extra
 * root slash and forward slashes: `C:\a\b` → `file:///C:/a/b`. Characters
 * that are legal in a path but not in a URI (spaces, `#`, `?`) are escaped;
 * `/` and the drive colon are deliberately left alone so the result stays
 * readable in logs.
 */
export function pathToFileUri(p: string): string {
  const posix = toPosix(p);
  const rooted = posix.startsWith('/') ? posix : `/${posix}`;
  return 'file://' + rooted.split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
}

/**
 * `file:` URI → path, accepting every spelling a language server might send
 * back: `file:///a/b`, `file:///C:/a/b`, and vscode-uri's percent-encoded
 * `file:///c%3A/a/b`.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let rest = uri.slice('file://'.length);
  // A UNC URI is file://host/share — keep the host by restoring both slashes.
  if (rest && !rest.startsWith('/')) return '\\\\' + decodeURIComponent(rest).replace(/\//g, '\\');
  rest = decodeURIComponent(rest);
  // `/C:/a/b` is a Windows path wearing a URI's leading slash.
  return /^\/[a-zA-Z]:/.test(rest) ? rest.slice(1) : rest;
}
