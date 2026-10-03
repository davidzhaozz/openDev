// Filtering and ordering for the JIRA panel. Pure, and kept out of the
// component so it can be tested without mounting React.
import type { JiraRunState, JiraTask } from '../../../shared/types';

export type SortKey = 'added' | 'key' | 'title' | 'status' | 'run' | 'recent';

/** "Needs attention" order, so a failed or running ticket sorts to the top. */
export const RUN_ORDER: Record<JiraRunState, number> = {
  running: 0, queued: 1, failed: 2, idle: 3, stopped: 4, done: 5
};

/** Filter ids are "all", "jira:<status name>", or "run:<run state>". */
export function filterTasks(tasks: JiraTask[], filter: string): JiraTask[] {
  const sep = filter.indexOf(':');
  if (sep < 0) return tasks;
  const scope = filter.slice(0, sep);
  // Jira status names can themselves contain a colon, so split once only.
  const value = filter.slice(sep + 1);
  if (scope === 'jira') return tasks.filter((t) => (t.status ?? '') === value);
  if (scope === 'run') return tasks.filter((t) => t.state === value);
  return tasks;
}

const byKey = (a: JiraTask, b: JiraTask) =>
  // Natural compare so BYZ-9 lands before BYZ-10, not after it.
  a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' });

/* -------------------------------------------------------------- pagination */

export const PAGE_SIZE = 20;

/** Always at least 1, so an empty list still has a page 0 to render. */
export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * Keep a page index inside the list. Filtering down from 3 pages to 1 while
 * sitting on page 3 would otherwise render an empty panel with no way back.
 */
export function clampPage(page: number, total: number, size = PAGE_SIZE): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.floor(page)), pageCount(total, size) - 1);
}

export function pageSlice<T>(items: T[], page: number, size = PAGE_SIZE): T[] {
  const p = clampPage(page, items.length, size);
  return items.slice(p * size, p * size + size);
}

/** Inclusive 1-based range for the "21–40 of 47" label; zeroed when empty. */
export function pageRange(page: number, total: number, size = PAGE_SIZE): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const p = clampPage(page, total, size);
  return { from: p * size + 1, to: Math.min(total, (p + 1) * size) };
}

export function sortTasks(tasks: JiraTask[], sort: SortKey): JiraTask[] {
  // Copy first — the caller's array is React state and sort() mutates.
  return [...tasks].sort((a, b) => {
    switch (sort) {
      case 'key': return byKey(a, b);
      case 'title': return a.title.localeCompare(b.title) || byKey(a, b);
      // A ticket with no status sorts last rather than first.
      case 'status': return (a.status || '￿').localeCompare(b.status || '￿') || byKey(a, b);
      case 'run': return RUN_ORDER[a.state] - RUN_ORDER[b.state] || byKey(a, b);
      // Never-run tickets fall to the bottom instead of tying at the top.
      case 'recent': return (b.startedAt ?? 0) - (a.startedAt ?? 0) || byKey(a, b);
      default: return a.addedAt - b.addedAt;
    }
  });
}
