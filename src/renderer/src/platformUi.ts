// How the primary modifier key is written and matched in the UI.
//
// Everything in the app already accepts `metaKey || ctrlKey` at the handler
// level; this is about the two places where the platform still shows through:
// the hint text on buttons, and the stored click-chord in Settings, whose
// "meta" means Command on macOS and Control everywhere else (the Windows key
// is not a chord anyone uses for go-to-definition).

const isMac = (): boolean => {
  try { return window.opendev.app.platform() === 'darwin'; } catch { return true; }
};

/** Label for the primary modifier: `⌘` on macOS, `Ctrl+` elsewhere. */
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl+';
}

/** Is the primary modifier held for this event? */
export function hasModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** Exposed so callers can branch on chord semantics, not just labels. */
export function isMacPlatform(): boolean {
  return isMac();
}
