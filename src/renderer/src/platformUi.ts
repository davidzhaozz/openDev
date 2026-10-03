// How the primary modifier key is written and matched in the UI. This is the
// macOS edition, so the primary modifier is always Command (⌘).

/** Label for the primary modifier. */
export function modKey(): string {
  return '⌘';
}

/** Is the primary modifier held for this event? */
export function hasModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey;
}
