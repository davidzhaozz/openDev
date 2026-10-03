// Naming rules for Jira boards, shared by the main process and the panel.
//
// A board is one JSON file of parked tickets in `.opendev`, named `jira.json`
// or `jira-<name>.json`. Both sides need the same rules — main to find and
// create the files, the panel to show what a typed name will become — so they
// live here rather than being spelled twice.

/** The board a workspace gets before anyone names one. */
export const DEFAULT_BOARD = 'jira.json';

/**
 * Which files in `.opendev` are boards.
 *
 * The `jira` prefix is what makes a board discoverable, and it is also what
 * keeps a board from being named `session` or `services` and overwriting one
 * of the other stores in that directory.
 */
export const BOARD_FILE = /^jira(-[a-z0-9][a-z0-9._-]*)?\.json$/i;

/** "jira-accounting-byz89.json" → "accounting-byz89"; the default file → "jira". */
export function boardLabel(file: string): string {
  const stem = file.replace(/\.json$/i, '');
  return stem.toLowerCase() === 'jira' ? 'jira' : stem.slice('jira-'.length);
}

/**
 * A name typed in the panel → the file it lives in. Throws with a sentence the
 * UI can show when nothing usable survives slugging, so the panel and the main
 * process reject the same names for the same stated reason.
 */
export function boardFileFor(name: string): string {
  const slug = name.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  if (!slug) throw new Error('A board needs a name — letters, digits, - or _.');
  const file = slug === 'jira' ? DEFAULT_BOARD : `jira-${slug}.json`;
  if (!BOARD_FILE.test(file)) throw new Error(`Cannot use "${name}" as a board name.`);
  return file;
}
