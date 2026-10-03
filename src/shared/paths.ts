// Path-string helpers usable in both processes.
//
// The renderer has no `node:path`, so anything that needs to pick a path
// apart for display or comparison goes through here instead of growing its
// own `p.split('/')`.

/** Path segments, empty ones dropped. `/a/b` → ['a','b']. */
export function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean);
}

/** Last segment: `/a/b.ts` → `b.ts`. Returns the input if it has no separator. */
export function baseName(p: string): string {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Everything before the last separator. `/a` → `/`. */
export function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return p.slice(0, i);
}

/** True for absolute paths (`/a/b`). */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/');
}

/** Kept for callers that normalise before comparing; macOS paths already use `/`. */
export function toPosix(p: string): string {
  return p;
}

/** True when `child` is `parent` or sits underneath it. */
export function isWithin(child: string, parent: string): boolean {
  const c = child.replace(/\/+$/, '');
  const p = parent.replace(/\/+$/, '');
  return c === p || c.startsWith(`${p}/`);
}

/** `/Users/me/x` → `~/x`, for titles and breadcrumbs. */
export function shortenHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

/**
 * Absolute path → `file:` URI, the form language servers and the debug
 * adapter speak. Characters that are legal in a path but not in a URI
 * (spaces, `#`, `?`) are escaped; `/` is left alone so the result stays
 * readable in logs.
 */
export function pathToFileUri(p: string): string {
  const rooted = p.startsWith('/') ? p : `/${p}`;
  return 'file://' + rooted.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** `file:` URI → path. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.slice('file://'.length));
}
