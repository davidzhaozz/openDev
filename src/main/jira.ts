// Jira panel: real Atlassian tickets, each with an AI run attached.
//
// Three responsibilities, kept separate below:
//   1. A thin Jira Cloud REST client (fetch issues, comment, transition).
//   2. A per-workspace store of the tickets parked in the panel, one JSON
//      file per board, with one board active at a time.
//   3. A run manager that spawns the Claude CLI against one ticket, tracks
//      its state, and on success posts a summary back to the issue.
import { ipcMain } from 'electron';
import { existsSync, promises as fs, watch, type FSWatcher } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import { IPC } from '@shared/ipc';
import { netFetch } from './netlog.js';

// Labels this module's traffic as "jira" in the NETWORK panel.
const jiraApiFetch = netFetch('jira');
import type { JiraBoard, JiraIssueRef, JiraReport, JiraTask } from '@shared/types';
import { BOARD_FILE, DEFAULT_BOARD, boardFileFor, boardLabel } from '@shared/jiraBoards';
import { loadSettings, patchSettings } from './storage.js';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { resolveBinPath, spawnBin, killTree, cliChildEnv } from './platform.js';
import { onShutdown } from './lifecycle.js';
import { LIMITS, tail } from './limits.js';

/* ------------------------------------------------------------------ client */

type JiraAuth = { base: string; email: string; token: string };

/** Normalize "byz.atlassian.net", with or without scheme/trailing slash. */
function normalizeSite(site: string): string {
  const s = site.trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/**
 * `null` when Jira is usable, otherwise one sentence naming what's missing.
 *
 * Batch operations check this ONCE up front. Letting each issue discover it
 * independently produced one identical "not configured" line per ticket — 46
 * of them on a real backlog, which buries the one thing you need to do.
 */
export async function configProblem(): Promise<string | null> {
  const s = await loadSettings();
  const missing: string[] = [];
  if (!normalizeSite(s.jiraSite || '')) missing.push('site');
  if (!(s.jiraEmail || '').trim()) missing.push('email');
  if (!(s.jiraApiToken || '').trim()) missing.push('API token');
  if (!missing.length) return null;
  return `Jira is not configured — missing ${missing.join(', ')}. Add it in Settings → Jira.`;
}

async function auth(): Promise<JiraAuth> {
  const problem = await configProblem();
  if (problem) throw new Error(problem);
  const s = await loadSettings();
  return {
    base: normalizeSite(s.jiraSite || ''),
    email: (s.jiraEmail || '').trim(),
    token: (s.jiraApiToken || '').trim()
  };
}

async function jiraFetch(path: string, init: RequestInit = {}): Promise<any> {
  const { base, email, token } = await auth();
  const res = await jiraApiFetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined)
    }
  });
  const text = await res.text();
  if (!res.ok) {
    // Jira puts the useful part in errorMessages[]; surface that, not a bare 400.
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      const msgs = [...(j.errorMessages || []), ...Object.values(j.errors || {})];
      if (msgs.length) detail = msgs.join('; ');
    } catch { /* keep raw text */ }
    throw new Error(`Jira ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Flatten Atlassian Document Format to plain text.
 *
 * The v3 API returns descriptions as a nested ADF tree, not a string. We only
 * need something readable to put in front of the model, so this walks the tree
 * and keeps text nodes, with block-level nodes forcing a newline.
 */
function adfToText(node: any, depth = 0): string {
  if (!node || depth > 30) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => adfToText(n, depth + 1)).join('');
  if (node.type === 'text') return String(node.text ?? '');
  if (node.type === 'hardBreak') return '\n';
  const inner = adfToText(node.content, depth + 1);
  const block = ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'rule'];
  if (!block.includes(node.type)) return inner;
  // A listItem wraps a paragraph, and both are block nodes — appending
  // unconditionally would put a blank line after every bullet.
  return inner.endsWith('\n') ? inner : `${inner}\n`;
}

/** Plain text → a minimal ADF document, for posting comments. */
function textToAdf(text: string): any {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return {
    type: 'doc',
    version: 1,
    content: (paragraphs.length ? paragraphs : ['(no content)']).map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p.replace(/\n/g, ' ').slice(0, 30000) }]
    }))
  };
}

function mapIssue(raw: any, base: string): JiraIssueRef {
  const f = raw.fields || {};
  return {
    key: raw.key,
    title: f.summary || '(no summary)',
    status: f.status?.name,
    issueType: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName,
    url: `${base}/browse/${raw.key}`,
    description: adfToText(f.description).trim().slice(0, 20000) || undefined,
    fetchedAt: Date.now()
  };
}

const ISSUE_FIELDS = 'summary,status,issuetype,priority,assignee,description';

export async function fetchIssue(key: string): Promise<JiraIssueRef> {
  const { base } = await auth();
  const raw = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key.trim())}?fields=${ISSUE_FIELDS}`);
  return mapIssue(raw, base);
}

export async function searchIssues(jql: string, limit = 50): Promise<JiraIssueRef[]> {
  const { base } = await auth();
  const q = `jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${ISSUE_FIELDS}`;
  // /search/jql is the current endpoint; /search is deprecated but still the
  // only one on older Server/DC instances, so fall back rather than fail.
  let raw: any;
  try {
    raw = await jiraFetch(`/rest/api/3/search/jql?${q}`);
  } catch {
    raw = await jiraFetch(`/rest/api/3/search?${q}`);
  }
  return (raw.issues || []).map((i: any) => mapIssue(i, base));
}

export async function addComment(key: string, body: string): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: textToAdf(body) })
  });
}

/**
 * Move an issue to the named status. Jira has no "set status" call — you POST
 * a transition id, and the legal ids differ per issue and workflow, so the
 * name has to be resolved against this issue's available transitions first.
 */
export async function transitionTo(key: string, statusName: string): Promise<void> {
  const want = statusName.trim().toLowerCase();
  const raw = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  const list: any[] = raw.transitions || [];
  const hit = list.find((t) => String(t.to?.name ?? '').toLowerCase() === want)
    ?? list.find((t) => String(t.name ?? '').toLowerCase() === want);
  if (!hit) {
    const available = list.map((t) => t.to?.name ?? t.name).filter(Boolean).join(', ') || 'none';
    throw new Error(`No transition to "${statusName}" from the current status (available: ${available})`);
  }
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: hit.id } })
  });
}

/* ------------------------------------------------------------------ boards */

/**
 * A workspace holds one board per JSON file, so the tickets under one parent
 * can be parked apart from the tickets under another:
 *
 *   .opendev/jira.json                    → "jira"
 *   .opendev/jira-accounting-byz89.json   → "accounting-byz89"
 *
 * Exactly one board is active per workspace and every read and write below
 * goes through it, so the panel, the MCP tools and the runs all agree on which
 * file they are working in. The choice lives in settings keyed by workspace
 * root, which keeps the board files themselves plain ticket lists.
 */

const boardDir = (root: string): string => join(root, '.opendev');

/** The board files present in a workspace, in dropdown order. */
async function boardFiles(root: string): Promise<string[]> {
  try { return (await fs.readdir(boardDir(root))).filter((n) => BOARD_FILE.test(n)).sort(); }
  catch { return []; /* no .opendev yet */ }
}

/**
 * Active board per workspace root. The store is read on paths that can't wait
 * for a settings round-trip, so the resolved answer is cached here.
 */
const activeBoards = new Map<string, string>();

async function activeBoard(root: string): Promise<string> {
  const known = activeBoards.get(root);
  if (known) return known;
  const saved = (await loadSettings()).jiraBoards?.[root];
  const files = await boardFiles(root);
  // A board since renamed or deleted falls back to the default board, or to
  // whatever board the workspace does have, rather than leaving the panel
  // pointed at a file that isn't there.
  const file = saved && BOARD_FILE.test(saved) && files.includes(saved) ? saved
    : !files.length || files.includes(DEFAULT_BOARD) ? DEFAULT_BOARD
    : files[0];
  activeBoards.set(root, file);
  return file;
}

/**
 * Every board file in `.opendev`, with the ticket count each one holds.
 *
 * Counts are read fresh on each call; the panel re-asks on every JiraChanged,
 * so a board edited outside the app shows a stale count only until the next
 * event touches the directory.
 */
export async function listBoards(): Promise<{ boards: JiraBoard[]; active: string }> {
  const root = workspace.getRoot();
  if (!root) return { boards: [], active: DEFAULT_BOARD };
  const active = await activeBoard(root);
  const names = await boardFiles(root);
  // With nothing on disk yet the default board is still offered, so a fresh
  // workspace has somewhere to put its first ticket. Once boards exist the
  // list is exactly what's there — a jira.json renamed away shouldn't linger.
  if (!names.length) names.push(DEFAULT_BOARD);
  const boards = await Promise.all(names.map(async (file): Promise<JiraBoard> => ({
    file,
    label: boardLabel(file),
    count: (await readBoard(join(boardDir(root), file))).length,
    active: file === active
  })));
  // Default first, then alphabetical — the order the panel's dropdown shows.
  boards.sort((a, b) => (
    a.file === DEFAULT_BOARD ? -1 : b.file === DEFAULT_BOARD ? 1 : a.label.localeCompare(b.label)
  ));
  return { boards, active };
}

/** Point the panel — and everything else reading the store — at another board. */
export async function selectBoard(file: string): Promise<JiraTask[]> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  if (!BOARD_FILE.test(file)) throw new Error(`Not a board file: ${file}`);
  if (file !== DEFAULT_BOARD && !existsSync(join(boardDir(root), file))) {
    throw new Error(`No such board: ${file}`);
  }
  activeBoards.set(root, file);
  const s = await loadSettings();
  await patchSettings({ jiraBoards: { ...s.jiraBoards, [root]: file } });
  // The watcher's baseline belongs to the board we just left.
  lastSeenJson = undefined;
  safeSend(IPC.JiraChanged, undefined);
  return read();
}

/** Create an empty board and make it the active one. */
export async function createBoard(name: string): Promise<{ file: string; tasks: JiraTask[] }> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  const file = boardFileFor(name);
  const path = join(boardDir(root), file);
  if (existsSync(path)) throw new Error(`A board called "${boardLabel(file)}" already exists.`);
  await fs.mkdir(boardDir(root), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ tasks: [] }, null, 2), 'utf8');
  return { file, tasks: await selectBoard(file) };
}

/**
 * Rename a board file, keeping its tickets, and leave the panel on it.
 *
 * The tickets are the file, so this is a plain `rename` — nothing inside the
 * board refers to its own name. Two things do, though: the active-board
 * pointer, and any run already writing to the old path.
 */
export async function renameBoard(file: string, name: string): Promise<{ file: string; tasks: JiraTask[] }> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  if (!BOARD_FILE.test(file)) throw new Error(`Not a board file: ${file}`);
  const target = boardFileFor(name);
  const from = join(boardDir(root), file);
  const to = join(boardDir(root), target);
  if (target === file) return { file, tasks: await selectBoard(file) };
  if (!existsSync(from)) throw new Error(`No such board: ${file}`);
  // A case-only rename ("byz89" → "BYZ89") lands on the same file on Windows,
  // where the destination reads as taken; let that one through.
  if (existsSync(to) && target.toLowerCase() !== file.toLowerCase()) {
    throw new Error(`A board called "${boardLabel(target)}" already exists.`);
  }
  await fs.rename(from, to);
  // A live run holds the path it started writing to. Move it with the file, or
  // its next progress write recreates the board under the old name.
  for (const [id, path] of runBoards) if (path === from) runBoards.set(id, to);
  return { file: target, tasks: await selectBoard(target) };
}

/* ------------------------------------------------------------------- store */

async function storePath(): Promise<string> {
  const root = workspace.getRoot();
  if (!root) throw new Error('No workspace open');
  return join(boardDir(root), await activeBoard(root));
}

async function readBoard(path: string): Promise<JiraTask[]> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const tasks = (JSON.parse(raw) as { tasks: JiraTask[] }).tasks ?? [];
    return tasks.map(reconcile);
  } catch { return []; }
}

/**
 * `running`/`queued` is process-lifetime state, but it lives in a file that
 * outlives the process. A run in flight when the IDE quit (or crashed) leaves
 * its ticket marked running forever, and the panel shows a spinner for a
 * process that no longer exists. Anything claiming to be live that we have no
 * child for is a leftover — report it as stopped. Corrected in memory only;
 * the next write to the board persists it.
 */
function reconcile(t: JiraTask): JiraTask {
  if (t.state !== 'running' && t.state !== 'queued') return t;
  // `starting` counts as live: spawnRun marks the ticket running before it
  // has a pid to put in `running`, and a board read landing in that window
  // would otherwise "correct" a run that is starting normally.
  if (running.has(t.id) || starting.has(t.id) || queue.includes(t.id)) return t;
  return { ...t, state: 'stopped', endedAt: t.endedAt ?? Date.now(), lastLine: 'interrupted — openDev exited during this run' };
}

async function read(): Promise<JiraTask[]> {
  try { return await readBoard(await storePath()); } catch { return []; }
}

async function write(tasks: JiraTask[]): Promise<void> {
  await writeBoard(await storePath(), tasks);
}

async function writeBoard(path: string, tasks: JiraTask[]): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const json = JSON.stringify({ tasks }, null, 2);
  await fs.writeFile(path, json, 'utf8');
  // Remember our own bytes so the disk watcher below recognises the event this
  // write is about to produce and doesn't send a second JiraChanged for it.
  // Only the active board is what that comparison is against.
  let activePath: string | undefined;
  try { activePath = await storePath(); } catch { /* workspace closed mid-write */ }
  if (path === activePath) lastSeenJson = json;
  safeSend(IPC.JiraChanged, undefined);
}

async function patch(id: string, fields: Partial<JiraTask>): Promise<JiraTask | null> {
  return patchIn(await storePath(), id, fields);
}

/**
 * Patch a ticket in a named board rather than the active one. A run holds the
 * board it started in (see `runBoards`), so its progress keeps landing in the
 * right file even when the panel has since been switched to another board.
 */
async function patchIn(path: string, id: string, fields: Partial<JiraTask>): Promise<JiraTask | null> {
  const tasks = await readBoard(path);
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  tasks[i] = { ...tasks[i], ...fields };
  await writeBoard(path, tasks);
  return tasks[i];
}

/** Add by key, hydrating from Jira. Re-adding an existing key refreshes it. */
export async function addByKey(key: string): Promise<JiraTask> {
  const issue = await fetchIssue(key);
  const tasks = await read();
  const existing = tasks.find((t) => t.key.toLowerCase() === issue.key.toLowerCase());
  if (existing) {
    Object.assign(existing, issue);
    await write(tasks);
    return existing;
  }
  const task: JiraTask = { ...issue, id: randomUUID(), addedAt: Date.now(), state: 'idle' };
  tasks.push(task);
  await write(tasks);
  return task;
}

/* ----------------------------------------------------------- store watcher */

/**
 * Writing the store directly is the only way a tool outside the app can update
 * the panel — an agent flipping a ticket's `state` to `done`, say — and it was
 * the one path that never reached it: IPC.JiraChanged came from write() alone,
 * so an external edit stayed invisible until the user pressed the panel's ↻.
 * Watching the file on disk closes that gap without changing the renderer.
 */

// fs.watch reports one logical write more than once on Windows (a change plus,
// often, a rename), and a save can leave the file briefly truncated. Let it
// settle before reading, so a burst of events costs one read and one event.
const SETTLE_MS = 100;

/** The store bytes the renderer has already been told about — our own writes included. */
let lastSeenJson: string | undefined;
/** The board files the renderer has already been told about. */
let lastSeenBoards: string | undefined;
let storeWatcher: FSWatcher | undefined;
/** Armed only while `.opendev` is absent: waits for the directory to appear. */
let storeRootWatcher: FSWatcher | undefined;
let settleTimer: NodeJS.Timeout | undefined;

const tryWatch = (dir: string, onFile: (name: string) => void): FSWatcher | undefined => {
  try {
    const w = watch(dir, { persistent: true, recursive: false }, (_event, filename) => {
      if (filename) onFile(filename.toString());
    });
    // A deleted or replaced directory kills the watcher; the next workspace
    // change re-arms it, which is the only moment the path can legitimately move.
    w.on('error', () => { try { w.close(); } catch { /* already gone */ } });
    return w;
  } catch (err) {
    console.warn(`[jira] cannot watch ${dir}:`, (err as Error).message);
    return undefined;
  }
};

const emitIfStoreChanged = async (): Promise<void> => {
  let raw = '';
  let path: string;
  try { path = await storePath(); } catch { return; /* no workspace open */ }
  try { raw = await fs.readFile(path, 'utf8'); } catch { /* absent: an empty store */ }
  // Unparseable means we caught the file mid-write. The settled write fires its
  // own event, so waiting beats handing the renderer a torn store.
  if (raw.trim()) { try { JSON.parse(raw); } catch { return; } }
  // A board file added or removed changes the panel's board list even when the
  // active board's own bytes are untouched, so both are checked here.
  const boards = (await listBoards()).boards.map((b) => b.file).sort().join('|');
  if (raw === lastSeenJson && boards === lastSeenBoards) return;
  lastSeenJson = raw;
  lastSeenBoards = boards;
  safeSend(IPC.JiraChanged, undefined);
};

const onStoreTouched = (): void => {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settleTimer = undefined; void emitIfStoreChanged(); }, SETTLE_MS);
};

const closeStoreWatchers = (): void => {
  for (const w of [storeWatcher, storeRootWatcher]) { try { w?.close(); } catch { /* already gone */ } }
  storeWatcher = undefined;
  storeRootWatcher = undefined;
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = undefined; }
};

/**
 * Point the watcher at the current workspace's store. Called whenever the root
 * changes, so it also stands in for teardown when the workspace closes.
 *
 * `.opendev` need not exist — a project has none until the first write — so
 * while it is missing we watch the root instead and re-arm when it appears,
 * rather than watching a path that isn't there.
 */
export const syncStoreWatcher = (): void => {
  closeStoreWatchers();
  lastSeenJson = undefined;
  lastSeenBoards = undefined;
  const root = workspace.getRoot();
  if (!root) return;
  if (existsSync(boardDir(root))) {
    // Every board file, not just the active one: creating or deleting one has
    // to reach the panel's board picker too.
    storeWatcher = tryWatch(boardDir(root), (name) => {
      if (BOARD_FILE.test(name)) onStoreTouched();
    });
  }
  if (!storeWatcher) {
    storeRootWatcher = tryWatch(root, (name) => { if (name === '.opendev') syncStoreWatcher(); });
    return;
  }
  // Read once on arming: the store this workspace already holds is news to the
  // renderer, and a store written while we weren't watching would be missed.
  onStoreTouched();
};

/* -------------------------------------------------------------------- runs */

const running = new Map<string, ChildProcess>();
/** Board file each live run started in, so its writes don't follow the panel. */
const runBoards = new Map<string, string>();
const logs = new Map<string, string>();

/**
 * Task ids admitted but waiting for a slot, oldest first.
 *
 * Runs are capped because each one is a whole Claude CLI process, and
 * `ide_jira_start` returns the moment the process is spawned — so the chat
 * model calling it once per ticket across a board started dozens of CLIs in
 * a few seconds and ate the machine's memory. The cap makes the Nth start
 * cheap (a queue entry) instead of another 350 MB.
 */
const queue: string[] = [];

/**
 * Ids admitted and spawning, but not yet in `running`.
 *
 * launchRun awaits settings and the board before it has a pid, and
 * `ide_jira_start` can be called again inside that window — both calls would
 * see a free slot and the cap would leak. Reserving synchronously on entry
 * makes the check honest. Counted toward the cap alongside `running`.
 */
const starting = new Set<string>();

/** Slots in use: live runs plus the ones mid-spawn. */
function occupancy(): number {
  return running.size + starting.size;
}

/**
 * The model is asked to close with this block so we have something structured
 * to post to Jira. Free-form prose would mean a second round-trip to summarize.
 */
const REPORT_OPEN = '<jira-report>';
const REPORT_CLOSE = '</jira-report>';

function buildPrompt(task: JiraTask): string {
  return [
    `You are working ticket ${task.key} in this repository.`,
    '',
    `Title: ${task.title}`,
    task.issueType ? `Type: ${task.issueType}` : '',
    task.priority ? `Priority: ${task.priority}` : '',
    '',
    'Description:',
    task.description || '(no description on the ticket)',
    '',
    'Implement this ticket fully. Make the code changes, and verify them the way',
    'this repo normally would (typecheck / build / tests) before you finish.',
    '',
    `When you are completely done, end your final message with this exact block:`,
    REPORT_OPEN,
    'SUMMARY: <2-4 sentences on what you changed and why>',
    'TESTING: <concrete steps a reviewer should follow to verify it>',
    REPORT_CLOSE,
    '',
    'The block is posted verbatim to the Jira ticket as a comment, so write it',
    'for a human reviewer, not for me.'
  ].filter((l) => l !== '').join('\n');
}

/** Pull the report block out of the run output; null when the model omitted it. */
export function parseReport(output: string): JiraReport | null {
  const i = output.lastIndexOf(REPORT_OPEN);
  if (i < 0) return null;
  const j = output.indexOf(REPORT_CLOSE, i);
  const body = output.slice(i + REPORT_OPEN.length, j < 0 ? undefined : j);
  const sum = body.match(/SUMMARY:\s*([\s\S]*?)(?=\n\s*TESTING:|$)/i);
  const test = body.match(/TESTING:\s*([\s\S]*)$/i);
  const summary = (sum?.[1] ?? '').trim();
  const testing = (test?.[1] ?? '').trim();
  if (!summary && !testing) return null;
  return { summary: summary || '(not provided)', testing: testing || '(not provided)' };
}

function appendLog(id: string, chunk: string): void {
  logs.set(id, tail((logs.get(id) ?? '') + chunk, LIMITS.subprocessBytes));
  safeSend(IPC.JiraLogChunk, { id, chunk });
}

/** Post the completion comment and move the ticket. Failures are recorded, not thrown. */
async function report(task: JiraTask, output: string): Promise<Partial<JiraTask>> {
  const settings = await loadSettings();
  const target = settings.jiraDoneStatus || 'In Progress';
  const parsed = parseReport(output);
  const body = parsed
    ? [
        `openDev AI run finished for ${task.key}.`,
        '',
        `Summary: ${parsed.summary}`,
        '',
        `How to test: ${parsed.testing}`
      ].join('\n')
    : [
        `openDev AI run finished for ${task.key}, but it did not emit a structured report.`,
        '',
        `Tail of the run output:`,
        '',
        output.slice(-1500).trim() || '(no output)'
      ].join('\n');
  try {
    await addComment(task.key, body);
  } catch (err: any) {
    return { reportError: `comment failed: ${err?.message ?? err}` };
  }
  try {
    // Already in the target status is success, not an error worth surfacing.
    if ((task.status ?? '').toLowerCase() !== target.toLowerCase()) {
      await transitionTo(task.key, target);
    }
    return { reportedAt: Date.now(), status: target, reportError: undefined };
  } catch (err: any) {
    return { reportedAt: Date.now(), reportError: `comment posted, transition failed: ${err?.message ?? err}` };
  }
}

export async function startRun(id: string): Promise<JiraTask | null> {
  if (running.has(id) || queue.includes(id)) return null;
  const boardPath = await storePath();
  const task = (await readBoard(boardPath)).find((t) => t.id === id);
  if (!task) return null;

  // Over the cap: park it. runBoards is set here too so a rename while the
  // entry is still queued remaps it the same way a live run is remapped.
  if (occupancy() >= LIMITS.jiraConcurrentRuns) {
    queue.push(id);
    runBoards.set(id, boardPath);
    await patchIn(boardPath, id, {
      state: 'queued',
      startedAt: undefined,
      endedAt: undefined,
      exitCode: undefined,
      reportError: undefined,
      lastLine: `queued — ${queue.length} ahead of it`
    });
    return (await readBoard(boardPath)).find((t) => t.id === id) ?? null;
  }
  return launchRun(id, boardPath);
}

/**
 * Fill free slots from the queue. Called whenever a run ends or is stopped.
 * Entries whose ticket vanished (board edited, task removed while queued)
 * are dropped rather than failing the pump.
 */
function pumpQueue(): void {
  while (occupancy() < LIMITS.jiraConcurrentRuns && queue.length > 0) {
    const id = queue.shift()!;
    const board = runBoards.get(id);
    if (!board) continue;
    // launchRun re-reads the ticket: it may have been edited while queued.
    void launchRun(id, board).catch((err) => {
      void patchIn(board, id, {
        state: 'failed',
        endedAt: Date.now(),
        lastLine: `could not start: ${err?.message ?? err}`
      });
    });
  }
  void refreshQueuePositions();
}

/** Keep the "N ahead of it" line honest as the queue drains. */
async function refreshQueuePositions(): Promise<void> {
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const board = runBoards.get(id);
    if (!board) continue;
    await patchIn(board, id, { lastLine: `queued — ${i + 1} ahead of it` });
  }
}

async function launchRun(id: string, boardPath: string): Promise<JiraTask | null> {
  // Taken before the first await, so a concurrent start sees the slot gone.
  starting.add(id);
  try {
    return await spawnRun(id, boardPath);
  } finally {
    starting.delete(id);
  }
}

async function spawnRun(id: string, boardPath: string): Promise<JiraTask | null> {
  const task = (await readBoard(boardPath)).find((t) => t.id === id);
  if (!task) return null;

  const settings = await loadSettings();
  const claudeBin = resolveBinPath(settings.claudeCliPath || 'claude');
  if (!claudeBin) throw new Error("Claude CLI not found — set its path in Settings → AI CLI paths.");
  const cwd = workspace.getRoot();
  if (!cwd) throw new Error('No workspace open');

  logs.set(id, '');
  runBoards.set(id, boardPath);
  // Read the path back on every write rather than closing over it: a rename
  // mid-run remaps the entry, and the run should follow its file.
  const at = (): string => runBoards.get(id) ?? boardPath;
  await patchIn(at(), id, { state: 'running', startedAt: Date.now(), endedAt: undefined, exitCode: undefined, lastLine: 'starting…', reportError: undefined });

  const proc = spawnBin(claudeBin, [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'AskUserQuestion',
    // IDE tools for the ticket run too — see cliMcpConfigArgs.
    ...(await (await import('./mcp.js')).cliMcpConfigArgs())
  ], {
    cwd,
    // Same scrubbed env as the chat path. Inheriting process.env wholesale
    // handed the CLI our Electron vars and any CLAUDE_CONFIG_DIR the IDE
    // happened to be launched with.
    env: cliChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  running.set(id, proc);

  let text = '';
  let buf = '';
  const note = (line: string) => { void patchIn(at(), id, { lastLine: line.slice(0, 200) }); };

  proc.stdout?.on('data', (b: Buffer) => {
    buf += b.toString('utf8');
    if (buf.length > LIMITS.aiLineBufferBytes) buf = '';
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { appendLog(id, line + '\n'); continue; }
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          note(`${e.content_block.name}…`);
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          text += e.delta.text;
          appendLog(id, e.delta.text);
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content || []) {
          if (c?.type !== 'tool_result') continue;
          const raw = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join(' ') : '';
          const flat = raw.trim().replace(/\s+/g, ' ');
          if (flat) note(flat);
        }
      }
    }
  });
  proc.stderr?.on('data', (b: Buffer) => appendLog(id, `[stderr] ${b.toString('utf8')}`));

  proc.stdin?.write(buildPrompt(task));
  proc.stdin?.end();

  // Same 'close' hazard as the chat path: a surviving grandchild (npm, tsc)
  // holds the inherited pipes open, so 'exit' has to be able to finalize too.
  let settled = false;
  const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    running.delete(id);
    // Hand the freed slot to the next ticket before doing the (network-bound)
    // Jira reporting below, so the queue doesn't stall on a slow comment post.
    pumpQueue();
    // Resolve the board before dropping the entry — the finalizing writes below
    // still belong to whichever file the run ended up in.
    const board = at();
    runBoards.delete(id);
    const stopped = signal != null || code === 143;
    const ok = code === 0 && !stopped;
    const base: Partial<JiraTask> = {
      state: stopped ? 'stopped' : ok ? 'done' : 'failed',
      endedAt: Date.now(),
      exitCode: code,
      lastLine: stopped ? 'stopped' : ok ? 'finished' : `exited with code ${code}`
    };
    if (!ok) { await patchIn(board, id, base); emitRunEnd({ ...task, ...base } as JiraTask); return; }
    await patchIn(board, id, { ...base, lastLine: 'posting to Jira…' });
    const current = (await readBoard(board)).find((t) => t.id === id) ?? task;
    const outcome = await report(current, text);
    await patchIn(board, id, { ...outcome, lastLine: outcome.reportError ? outcome.reportError : 'reported to Jira' });
    emitRunEnd({ ...current, ...base, ...outcome } as JiraTask);
  };
  proc.on('close', (code, signal) => void finish(code, signal));
  proc.on('exit', (code, signal) => { setTimeout(() => void finish(code, signal), 3000); });
  proc.on('error', (err) => {
    appendLog(id, `\n[spawn error] ${err.message}\n`);
    void finish(1, null);
  });

  return (await readBoard(at())).find((t) => t.id === id) ?? null;
}

export async function stopRun(id: string): Promise<boolean> {
  // Queued but not yet spawned: drop the entry, no process to kill.
  const queuedAt = queue.indexOf(id);
  if (queuedAt !== -1) {
    queue.splice(queuedAt, 1);
    const board = runBoards.get(id) ?? await storePath();
    runBoards.delete(id);
    await patchIn(board, id, { state: 'stopped', endedAt: Date.now(), lastLine: 'stopped before it started' });
    void refreshQueuePositions();
    return true;
  }
  const proc = running.get(id);
  if (!proc) return false;
  // Tree kill: the CLI's own Bash calls are grandchildren and would otherwise
  // keep running (and keep the pipes open) after the parent dies.
  await killTree(proc.pid ?? 0, true);
  running.delete(id);
  // Don't wait for 'close' to release the slot — a kill on an already-dead
  // proc may never produce one, and the queue would stall a slot short.
  pumpQueue();
  // The entry stays for finish() to resolve and drop — the kill above still
  // produces a 'close', and that write belongs in the same file as this one.
  const boardPath = runBoards.get(id) ?? await storePath();
  await patchIn(boardPath, id, { state: 'stopped', endedAt: Date.now(), lastLine: 'stopped' });
  return true;
}

export async function removeTask(id: string): Promise<boolean> {
  if (running.has(id) || queue.includes(id)) await stopRun(id);
  await write((await read()).filter((t) => t.id !== id));
  return true;
}

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

export async function searchDefault(jql?: string): Promise<JiraIssueRef[]> {
  const s = await loadSettings();
  return searchIssues((jql || s.jiraJql || DEFAULT_JQL).trim());
}

/**
 * The surface the MCP layer drives, so an external CLI can park tickets and
 * kick off runs exactly the way the panel does.
 */
export const jiraStore = {
  list: read,
  boards: listBoards,
  selectBoard,
  createBoard,
  renameBoard,
  addByKey,
  remove: removeTask,
  search: searchDefault,
  start: startRun,
  stop: stopRun
};

/**
 * Collapse repeated failures. A whole backlog rejected for one reason (bad
 * token, wrong site, no network) should read as one line plus a count, not as
 * N copies of the same sentence.
 */
function dedupe(errors: string[], cap = 8): string[] {
  const counts = new Map<string, number>();
  for (const e of errors) {
    // "BYZ-89: Jira 401: …" → group on the reason, keep one example key.
    const reason = e.replace(/^[A-Z][A-Z0-9]*-\d+:\s*/, '');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const out = [...counts.entries()].map(([reason, n]) => (n > 1 ? `${reason} (${n} tickets)` : reason));
  return out.length > cap ? [...out.slice(0, cap), `…and ${out.length - cap} more`] : out;
}

/* --------------------------------------------------------------------- ipc */

// Run-end listeners for other main-process modules (the Slack bridge
// notifies when a ticket's run finishes). Called once per run, after any
// Jira report has been posted.
const runEndListeners = new Set<(t: JiraTask) => void>();
export function onJiraRunEnd(cb: (t: JiraTask) => void): () => void {
  runEndListeners.add(cb);
  return () => runEndListeners.delete(cb);
}
function emitRunEnd(t: JiraTask): void {
  for (const cb of runEndListeners) {
    try { cb(t); } catch (e) { console.error('[jira] run-end listener threw', e); }
  }
}

export function registerJiraIpc(): void {
  ipcMain.handle(IPC.JiraList, () => read());
  ipcMain.handle(IPC.JiraConfigured, () => configProblem());
  ipcMain.handle(IPC.JiraBoards, () => listBoards());
  ipcMain.handle(IPC.JiraSelectBoard, (_e, file: string) => selectBoard(String(file)));
  ipcMain.handle(IPC.JiraCreateBoard, (_e, name: string) => createBoard(String(name)));
  ipcMain.handle(IPC.JiraRenameBoard, (_e, file: string, name: string) =>
    renameBoard(String(file), String(name)));
  ipcMain.handle(IPC.JiraLog, (_e, id: string) => logs.get(id) ?? '');

  ipcMain.handle(IPC.JiraAdd, async (_e, keys: string | string[]) => {
    const list = (Array.isArray(keys) ? keys : [keys])
      .flatMap((k) => String(k).split(/[\s,]+/))
      .map((k) => k.trim())
      .filter(Boolean);
    const problem = await configProblem();
    if (problem) return { added: [], errors: [problem] };
    const added: JiraTask[] = [];
    const errors: string[] = [];
    for (const key of list) {
      try { added.push(await addByKey(key)); }
      catch (err: any) { errors.push(`${key}: ${err?.message ?? err}`); }
    }
    return { added, errors: dedupe(errors) };
  });

  ipcMain.handle(IPC.JiraRemove, (_e, id: string) => removeTask(id));

  // Re-pull every parked ticket so status/summary changes made in Jira show up.
  ipcMain.handle(IPC.JiraRefresh, async () => {
    const tasks = await read();
    const problem = await configProblem();
    if (problem) return { tasks, errors: [problem] };
    const errors: string[] = [];
    for (const t of tasks) {
      try { Object.assign(t, await fetchIssue(t.key)); }
      catch (err: any) { errors.push(`${t.key}: ${err?.message ?? err}`); }
    }
    await write(tasks);
    return { tasks, errors: dedupe(errors) };
  });

  ipcMain.handle(IPC.JiraSearch, (_e, jql?: string) => searchDefault(jql));

  ipcMain.handle(IPC.JiraStart, (_e, id: string) => startRun(id));
  ipcMain.handle(IPC.JiraStop, (_e, id: string) => stopRun(id));

  ipcMain.handle(IPC.JiraTestConnection, async () => {
    try {
      const me = await jiraFetch('/rest/api/3/myself');
      return { ok: true as const, user: me.displayName || me.emailAddress || 'unknown' };
    } catch (err: any) {
      return { ok: false as const, error: err?.message ?? String(err) };
    }
  });
}

// Ticket runs are plain spawned CLIs — nothing reaps them when the main
// process exits, so an in-flight run outlived the IDE and sat in Task Manager
// holding its ~350 MB (plus whatever its Bash grandchildren were doing). The
// chat path has done this since it hit the same bug; this is the same fix for
// the Jira panel. Killed in parallel: before-quit caps shutdown at 6s and each
// taskkill can take a second or more.
onShutdown(async () => {
  const procs = [...running.values()];
  running.clear();
  starting.clear();
  queue.length = 0;
  await Promise.all(procs.map((p) => killTree(p.pid ?? 0, true)));
});
