import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join, basename, relative, isAbsolute } from 'path';
import WebSocket from 'ws';
import { IPC } from '@shared/ipc';
import type { AiActivityMsg, AppSettings, JiraTask, ServiceRuntime, SlackStatus } from '@shared/types';
import { loadSettings, readJson, writeJson, getStorageDir } from './storage.js';
import { safeSend } from './safeSend.js';
import { netFetch } from './netlog.js';
import { onShutdown } from './lifecycle.js';
import { workspace } from './workspace.js';
import { aiTurnEvents, startAiTurn, cancelAiTurn, type AiTurnDone } from './ai.js';
import { serviceManager } from './services.js';
import { onJiraRunEnd } from './jira.js';
import { screenshotDir } from './browser.js';

// Slack bridge: talk to the IDE from a Slack DM, and hear back from it.
//
// Transport is Socket Mode — the IDE dials out to Slack over a WebSocket, so
// there is no public URL, tunnel, or open port. A DM to the bot becomes a
// turn in the IDE chat (the same Claude run, with the same IDE MCP tools, as
// typing in the AI panel); the reply is posted back to the DM. Separately,
// the IDE DMs you when a long AI turn, a service, or a Jira run needs you.
//
// Single-user by design. The chat runs tools without per-call approval, so
// a message from anyone but slackUserId is dropped unread — no reply, no
// turn. Bot messages and edits are ignored too.

const slackFetch = netFetch('slack');
// Overridable so a test can stand in a local fake Slack.
const API = process.env.OPENDEV_SLACK_API || 'https://slack.com/api/';

let status: SlackStatus = { state: 'off' };
function setStatus(s: SlackStatus): void {
  status = s;
  safeSend(IPC.SlackStatusChanged, s);
}

/* ------------------------------------------------------------------ web api */

type SlackResp = { ok: boolean; error?: string; [k: string]: any };

// `form`: sent url-encoded, for the methods that don't read a JSON body
// (files.getUploadURLExternal).
async function slackApi(method: string, token: string, body: Record<string, unknown> = {}, form = false): Promise<SlackResp> {
  for (let attempt = 0; ; attempt++) {
    const res = await slackFetch(API + method, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8'
      },
      body: form
        ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
        : JSON.stringify(body)
    });
    // Rate limited (chat.update during a busy run is the likely one): wait
    // the time Slack asks for, once.
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('retry-after') || '1');
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    try { return (await res.json()) as SlackResp; }
    catch { return { ok: false, error: `HTTP ${res.status}` }; }
  }
}

async function bot(method: string, body: Record<string, unknown>, form = false): Promise<SlackResp> {
  const s = await loadSettings();
  if (!s.slackBotToken) return { ok: false, error: 'no bot token' };
  const r = await slackApi(method, s.slackBotToken, body, form);
  if (!r.ok) console.warn(`[slack] ${method} failed: ${r.error}`);
  return r;
}

type Where = { channel: string; thread?: string };

async function post(where: Where, text: string): Promise<string | undefined> {
  const r = await bot('chat.postMessage', { channel: where.channel, thread_ts: where.thread, text, unfurl_links: false, unfurl_media: false });
  return r.ok ? (r.ts as string) : undefined;
}

async function update(channel: string, ts: string, text: string): Promise<boolean> {
  const r = await bot('chat.update', { channel, ts, text });
  return r.ok;
}

// Post a long reply: the first chunk replaces the "working" placeholder, the
// rest follow as new messages in the same place.
async function postReply(where: Where, placeholderTs: string | undefined, text: string): Promise<void> {
  const chunks = toSlackChunks(text);
  let i = 0;
  if (placeholderTs && await update(where.channel, placeholderTs, chunks[0])) i = 1;
  for (; i < chunks.length; i++) await post(where, chunks[i]);
}

/* ------------------------------------------------------------- attachments */

// The model attaches an image to its reply with a line `[[attach: <path>]]`
// (ide_browser_screenshot returns the path). The lines come out of the text
// and the files go up to the same DM or thread after it.
const ATTACH_LINE = /^[ \t]*\[\[attach:\s*(.+?)\s*\]\][ \t]*$/gm;
export function extractAttachments(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const rest = text.replace(ATTACH_LINE, (_m, p: string) => {
    const path = p.replace(/^[`'"<]+|[`'">]+$/g, '');
    if (path && !files.includes(path)) files.push(path);
    return '';
  });
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), files };
}

// Images only, and only from the screenshot folder or the open project: a
// reply is model output, and the model reads text (web pages, mail, Slack)
// that could ask it to "attach" a key file. Real paths, so a symlink can't
// lead out.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const inside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

async function attachable(path: string): Promise<string> {
  if (!IMAGE_EXT.test(path)) throw new Error('only png, jpg, gif and webp images can be attached');
  const real = await fs.realpath(path).catch(() => { throw new Error('file not found'); });
  const dirs = [screenshotDir(), workspace.getRoot()].filter(Boolean) as string[];
  const allowed = await Promise.all(dirs.map((d) => fs.realpath(d).catch(() => d)));
  if (!allowed.some((d) => inside(d, real))) throw new Error('not in the screenshot folder or the open project');
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_ATTACH_BYTES) throw new Error('larger than 20 MB');
  return real;
}

// Slack's upload flow: reserve an upload URL per file, send the bytes there,
// then share them all to the conversation in one call.
async function uploadFiles(where: Where, paths: string[]): Promise<void> {
  const problems: string[] = [];
  const uploaded: Array<{ id: string; title: string }> = [];
  for (const p of paths.slice(0, MAX_ATTACHMENTS)) {
    const name = basename(p);
    try {
      const real = await attachable(p);
      const bytes = await fs.readFile(real);
      const slot = await bot('files.getUploadURLExternal', { filename: name, length: bytes.length }, true);
      if (!slot.ok) {
        throw new Error(slot.error === 'missing_scope'
          ? 'the Slack app lacks the files:write scope — add it under OAuth & Permissions (or recreate the app from Settings → Slack → Copy manifest) and reinstall it'
          : `Slack refused the upload (${slot.error})`);
      }
      const put = await slackFetch(slot.upload_url as string, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (!put.ok) throw new Error(`upload failed (HTTP ${put.status})`);
      uploaded.push({ id: slot.file_id as string, title: name });
    } catch (err: any) {
      problems.push(`• \`${escapeSlack(name)}\`: ${escapeSlack(err?.message || String(err))}`);
    }
  }
  if (paths.length > MAX_ATTACHMENTS) problems.push(`• ${paths.length - MAX_ATTACHMENTS} more skipped (at most ${MAX_ATTACHMENTS} per reply)`);
  if (uploaded.length) {
    const done = await bot('files.completeUploadExternal', {
      files: JSON.stringify(uploaded),
      channel_id: where.channel,
      ...(where.thread ? { thread_ts: where.thread } : {})
    }, true);
    if (!done.ok) problems.push(`• couldn't share ${uploaded.length === 1 ? 'the file' : `${uploaded.length} files`}: ${done.error}`);
  }
  if (problems.length) await post(where, `⚠️ Couldn't attach:\n${problems.join('\n')}`);
}

let dmChannel: string | undefined;
// Notifications go to the DM between the bot and you.
async function notify(text: string): Promise<void> {
  const s = await loadSettings();
  if (status.state !== 'connected' || !s.slackUserId) return;
  if (!dmChannel) {
    const r = await bot('conversations.open', { users: s.slackUserId });
    if (!r.ok) return;
    dmChannel = r.channel?.id as string;
  }
  await post({ channel: dmChannel }, text);
}

/* --------------------------------------------------------------- formatting */

// Slack's mrkdwn is not Markdown: *bold*, _italic_, <url|label>, and & < >
// escaped (in code too, or `<div>` reads as a link). Converts the common
// constructs a model writes; code is only escaped.
const escapeSlack = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function toMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$))/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // Drop the language tag — Slack would show it as the first code line.
      return escapeSlack(part.replace(/^```[\w+#.-]*\n/, '```\n'));
    }
    return part
      .split(/(`[^`\n]+`)/g)
      .map((seg, j) => {
        if (j % 2 === 1) return escapeSlack(seg);
        return escapeSlack(seg)
          .replace(/^&gt; /gm, '> ')
          .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
          .replace(/\*\*(.+?)\*\*/g, '*$1*')
          .replace(/__(.+?)__/g, '*$1*')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
          .replace(/^(\s*)[-*] /gm, '$1• ');
      })
      .join('');
  }).join('');
}

// Slack collapses long messages behind "Show more" and rejects ~40k+, so a
// reply is split on line boundaries; a split inside a code block closes the
// fence and reopens it in the next chunk.
const CHUNK = 3500;
export function toSlackChunks(md: string): string[] {
  const text = toMrkdwn(md.trim() || '(no text reply)');
  const out: string[] = [];
  let cur = '';
  let inFence = false;
  for (const raw of text.split('\n')) {
    const lines = raw.length > CHUNK ? raw.match(new RegExp(`[\\s\\S]{1,${CHUNK}}`, 'g'))! : [raw];
    for (const line of lines) {
      if (cur.length + line.length + 1 > CHUNK && cur) {
        out.push(inFence ? cur + '\n```' : cur);
        cur = inFence ? '```\n' : '';
      }
      cur += (cur && !cur.endsWith('```\n') ? '\n' : '') + line;
      if (/^```/.test(line.trim())) inFence = !inFence;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// The chat transcript interleaves the IDE's own progress lines with the
// model's text: a leading _model · effort_ tag, '› using tool: X' (with
// progress dots and a size), and '  ↳ result preview'. The live progress
// already went to the placeholder, so the reply keeps only what was said.
export function replyText(full: string): string {
  return full
    .replace(/^_[^_\n]+_\n+/, '')
    .split('\n')
    .filter((l) => !/^› using tool: /.test(l) && !/^  ↳ /.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Incoming text uses Slack's encoding: entities escaped, links wrapped.
function fromSlackText(text: string, botUserId?: string): string {
  let t = text;
  if (botUserId) t = t.split(`<@${botUserId}>`).join('');
  return t
    .replace(/<(?:mailto:)?([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>@#!][^>]*)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/* ----------------------------------------------------------------- sessions */

// One session per place you talk to the IDE: the DM itself, or a thread. Each
// keeps its own IDE conversation, so follow-ups resume the same Claude
// session. Persisted so a restart doesn't cut a conversation off.
type Session = { conversationId?: string; workspaceRoot?: string };
type Running = { key: string; where: Where; placeholderTs?: string; startedAt: number; steps: Map<string, AiActivityMsg>; stopped?: boolean; timer?: NodeJS.Timeout; lastEdit: number };

const sessionsPath = () => join(getStorageDir(), 'slack-sessions.json');
let sessions: Record<string, Session> | null = null;
const running = new Map<string, Running>();    // streamId → run
const queues = new Map<string, Array<{ text: string; where: Where }>>(); // key → waiting messages

async function getSessions(): Promise<Record<string, Session>> {
  if (!sessions) sessions = await readJson<Record<string, Session>>(sessionsPath(), {});
  return sessions;
}
async function saveSessions(): Promise<void> {
  if (sessions) await writeJson(sessionsPath(), sessions);
}

function runFor(key: string): [string, Running] | undefined {
  for (const e of running) if (e[1].key === key) return e;
  return undefined;
}

/* ----------------------------------------------------------------- commands */

const HELP = [
  '*openDev over Slack* — anything you type goes to the IDE\'s Claude, which can use the whole IDE:',
  'files, terminal commands, git, services, databases, REST, Jira, the editor, and the browser panel',
  '(ask for a screenshot of a page and it comes back as an image).',
  '',
  'A few words are commands instead (the whole message, nothing else):',
  '• `status` — open project, AI runs in progress, services',
  '• `stop` — cancel the AI run in this conversation',
  '• `new` — start a fresh conversation here',
  '• `projects` — recent projects; `project 2` or `project <name>` switches',
  '• `help` — this message',
  '',
  'A thread is its own conversation, so you can run several things side by side.'
].join('\n');

async function statusText(): Promise<string> {
  const root = workspace.getRoot();
  const lines = [`*Project:* ${root ? `\`${root}\`` : '_none open_'}`];
  if (running.size) {
    lines.push('*AI runs:*');
    for (const r of running.values()) lines.push(`• running ${elapsed(Date.now() - r.startedAt)}${r.where.thread ? ' (in a thread)' : ''}`);
  } else {
    lines.push('*AI runs:* none');
  }
  if (root) {
    try {
      const defs = await serviceManager.list();
      if (defs.length) {
        lines.push('*Services:*');
        for (const d of defs) {
          const st = serviceManager.status(d.id);
          const dot = st.status === 'running' ? '🟢' : st.status === 'starting' ? '🟡' : st.status === 'error' ? '🔴' : '⚪';
          lines.push(`${dot} ${d.name} — ${st.status}${d.port ? ` :${d.port}` : ''}`);
        }
      }
    } catch { /* no services file */ }
  }
  return lines.join('\n');
}

// Returns true when `text` was a command (and has been answered).
async function runCommand(text: string, key: string, where: Where): Promise<boolean> {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === 'help') { await post(where, HELP); return true; }
  if (lower === 'status') { await post(where, await statusText()); return true; }
  if (lower === 'stop') {
    queues.delete(key);
    const r = runFor(key);
    if (!r) { await post(where, 'Nothing is running here.'); return true; }
    r[1].stopped = true;
    cancelAiTurn(r[0]);
    return true;
  }
  if (lower === 'new') {
    const all = await getSessions();
    delete all[key];
    await saveSessions();
    await post(where, 'Starting fresh — your next message begins a new conversation.');
    return true;
  }
  const s = await loadSettings();
  const recent = s.recentWorkspaces || [];
  if (lower === 'projects') {
    const cur = workspace.getRoot();
    await post(where, recent.length
      ? '*Recent projects:*\n' + recent.map((p, i) => `${i + 1}. ${basename(p)}${p === cur ? ' _(open)_' : ''} — \`${p}\``).join('\n') + '\n\nSwitch with `project <number>` or `project <name>`.'
      : 'No recent projects.');
    return true;
  }
  const m = /^project\s+(.+)$/i.exec(t);
  if (m) {
    const arg = m[1].trim();
    const n = /^\d+$/.test(arg) ? Number(arg) : NaN;
    const path = !isNaN(n) ? recent[n - 1] : recent.find((p) => basename(p).toLowerCase() === arg.toLowerCase());
    // Not a known project: it was a sentence starting with "project", so it
    // goes to the AI like any other message.
    if (!path) return false;
    await workspace.open(path);
    await post(where, `Switched to *${basename(path)}* — \`${path}\``);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ AI turns */

async function handleMessage(text: string, key: string, where: Where): Promise<void> {
  if (await runCommand(text, key, where)) return;
  if (runFor(key)) {
    const q = queues.get(key) ?? [];
    q.push({ text, where });
    queues.set(key, q);
    await post(where, `Queued — I'll start on it when the current run finishes (${q.length} waiting). Send \`stop\` to cancel.`);
    return;
  }
  await startTurn(text, key, where);
}

async function startTurn(text: string, key: string, where: Where): Promise<void> {
  const root = workspace.getRoot();
  if (!root) {
    await post(where, 'No project is open in the IDE. Send `projects` to pick one.');
    return;
  }
  const s = await loadSettings();
  const all = await getSessions();
  const sess = all[key] ?? {};
  // A conversation lives in its project's .opendev folder; after a project
  // switch the old id would not resolve, so start over in the new project.
  const conversationId = sess.workspaceRoot === root ? sess.conversationId : undefined;
  const placeholderTs = await post(where, '⏳ Working on it…');
  try {
    const r = await startAiTurn({
      conversationId,
      text,
      transport: s.lastAiTransport || 'claude-cli',
      model: s.claudeCliModel,
      effort: s.claudeCliEffort,
      context: { remote: 'slack', workspaceRoot: root }
    }, 'slack');
    all[key] = { conversationId: r.conversationId, workspaceRoot: root };
    await saveSessions();
    running.set(r.streamId, { key, where, placeholderTs, startedAt: Date.now(), steps: new Map(), lastEdit: 0 });
  } catch (err: any) {
    await postReply(where, placeholderTs, `⚠️ Couldn't start: ${err?.message || err}`);
  }
}

const STATUS_ICON = { running: '⏳', ok: '✓', error: '✗' } as const;
const EDIT_EVERY_MS = 3000;

// Live progress: the placeholder shows the run's latest tool steps, edited
// at most every few seconds to stay inside Slack's rate limits.
function onActivity(msg: AiActivityMsg): void {
  const r = running.get(msg.streamId);
  if (!r || !r.placeholderTs) return;
  // A step's updates arrive piecemeal (a result carries only its status),
  // so merge onto what is already known.
  const prev = r.steps.get(msg.id);
  r.steps.set(msg.id, { ...msg, tool: msg.tool || prev?.tool || '', target: msg.target || prev?.target });
  if (r.timer) return;
  const wait = Math.max(0, r.lastEdit + EDIT_EVERY_MS - Date.now());
  r.timer = setTimeout(() => {
    r.timer = undefined;
    if (!running.has(msg.streamId)) return;
    r.lastEdit = Date.now();
    const steps = [...r.steps.values()].slice(-8)
      .map((m) => `${STATUS_ICON[m.status]} ${m.tool}${m.target ? ` ${m.target.slice(0, 120)}` : ''}`)
      .join('\n').replace(/```/g, "'''");
    void update(r.where.channel, r.placeholderTs!, `⏳ Working… ${elapsed(Date.now() - r.startedAt)}\n\`\`\`\n${steps}\n\`\`\``);
  }, wait);
}

const NOTIFY_AFTER_MS = 60_000;

async function onTurnDone(d: AiTurnDone): Promise<void> {
  const r = running.get(d.streamId);
  if (r) {
    running.delete(d.streamId);
    if (r.timer) clearTimeout(r.timer);
    const head = r.stopped ? '⏹ Stopped.\n\n' : '';
    const { text, files } = extractAttachments(replyText(d.full));
    await postReply(r.where, r.placeholderTs, head + (text || (r.stopped ? '' : files.length ? '📎' : '(no text reply)')));
    if (files.length) await uploadFiles(r.where, files);
    const next = queues.get(r.key)?.shift();
    if (next) await startTurn(next.text, r.key, next.where);
    return;
  }
  // A turn typed in the IDE: worth a ping only if it ran long enough that
  // you may have walked away.
  const s = await loadSettings();
  if (d.origin !== 'ide' || s.slackNotifyAi === false) return;
  const took = Date.now() - d.startedAt;
  if (took < NOTIFY_AFTER_MS) return;
  const answer = replyText(d.full);
  const preview = answer.replace(/\s+/g, ' ').slice(0, 300);
  await notify(`✅ AI finished in the IDE after ${elapsed(took)} — *${toMrkdwn(d.title)}*${preview ? `\n> ${toMrkdwn(preview)}${answer.length > 300 ? '…' : ''}` : ''}`);
}

async function onServiceStatus(rt: ServiceRuntime): Promise<void> {
  if (rt.status !== 'error') return;
  const s = await loadSettings();
  if (s.slackNotifyServices === false) return;
  let name = rt.id;
  try { name = (await serviceManager.list()).find((d) => d.id === rt.id)?.name || rt.id; } catch {}
  await notify(`🔴 Service *${toMrkdwn(name)}* stopped with an error${rt.lastError ? `: \`${rt.lastError.slice(0, 300)}\`` : ''}`);
}

async function onJiraEnd(t: JiraTask): Promise<void> {
  const s = await loadSettings();
  if (s.slackNotifyJira === false) return;
  const icon = t.state === 'done' ? '✅' : t.state === 'stopped' ? '⏹' : '❌';
  const link = t.url ? `<${t.url}|${t.key}>` : t.key;
  const tail = t.state === 'done'
    ? (t.reportError ? ` — couldn't post to Jira: ${t.reportError}` : ' — summary posted to Jira')
    : ` — ${t.lastLine || t.state}`;
  await notify(`${icon} Jira run ${t.state}: ${link} ${toMrkdwn(t.title)}${tail}`);
}

/* --------------------------------------------------------------- the socket */

let sock: WebSocket | null = null;
let generation = 0;
let retryTimer: NodeJS.Timeout | undefined;
let watchdog: NodeJS.Timeout | undefined;
let backoffMs = 2000;
let botUserId: string | undefined;
let botTeamId: string | undefined;   // the workspace the bot is installed in
let allowedUser: string | undefined;
const seen = new Set<string>();

function configProblem(s: AppSettings): string | undefined {
  if (!s.slackAppToken?.startsWith('xapp-')) return 'App-level token (xapp-…) is missing';
  if (!s.slackBotToken?.startsWith('xoxb-')) return 'Bot token (xoxb-…) is missing';
  if (!/^[UW][A-Z0-9]{5,}$/.test(s.slackUserId?.trim() || '')) return 'Your Slack member ID (U…) is missing';
  return undefined;
}

function teardown(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  if (watchdog) { clearInterval(watchdog); watchdog = undefined; }
  if (sock) {
    const s = sock;
    sock = null;
    s.removeAllListeners();
    s.on('error', () => {});
    try { s.terminate(); } catch {}
  }
}

function scheduleRetry(gen: number, detail: string): void {
  if (gen !== generation) return;
  teardown();
  setStatus({ state: 'error', detail: `${detail} — retrying in ${Math.round(backoffMs / 1000)}s` });
  retryTimer = setTimeout(() => void connect(gen), backoffMs);
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

async function connect(gen: number): Promise<void> {
  if (gen !== generation) return;
  teardown();
  const s = await loadSettings();
  if (!s.slackEnabled) { setStatus({ state: 'off' }); return; }
  const problem = configProblem(s);
  if (problem) { setStatus({ state: 'unconfigured', detail: problem }); return; }
  allowedUser = s.slackUserId!.trim();
  setStatus({ state: 'connecting' });

  let open: SlackResp;
  try { open = await slackApi('apps.connections.open', s.slackAppToken!); }
  catch (err: any) { return scheduleRetry(gen, `Can't reach Slack (${err?.message || err})`); }
  if (gen !== generation) return;
  if (!open.ok) {
    // A bad token won't fix itself; wait for the user to change settings.
    if (['invalid_auth', 'not_authed', 'not_allowed_token_type', 'account_inactive', 'token_revoked'].includes(open.error!)) {
      setStatus({ state: 'error', detail: `App token rejected: ${open.error}` });
      return;
    }
    return scheduleRetry(gen, `Slack refused the connection: ${open.error}`);
  }

  const ws = new WebSocket(open.url as string);
  sock = ws;
  let lastSeen = Date.now();
  // Slack pings every few seconds. Silence means the socket died without a
  // close — typically the laptop slept — so reconnect instead of waiting.
  watchdog = setInterval(() => {
    if (Date.now() - lastSeen > 60_000) scheduleRetry(gen, 'Connection went quiet');
  }, 15_000);
  ws.on('ping', () => { lastSeen = Date.now(); });
  ws.on('message', (data) => {
    lastSeen = Date.now();
    let frame: any;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    // Ack first: Slack redelivers anything not acked within 3 seconds.
    if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    if (frame.type === 'hello') {
      backoffMs = 2000;
      setStatus({ state: 'connected' });
      void identifyBot();
    } else if (frame.type === 'disconnect') {
      // Slack rotates sockets periodically and says so first.
      if (gen === generation) void connect(gen);
    } else if (frame.type === 'events_api') {
      void onEvent(frame.payload?.event, frame.payload?.team_id).catch((err) => console.error('[slack] event failed', err));
    }
  });
  ws.on('close', () => { if (sock === ws) scheduleRetry(gen, 'Disconnected'); });
  ws.on('error', (err) => console.warn('[slack] socket error', err.message));
}

async function identifyBot(): Promise<void> {
  const r = await bot('auth.test', {});
  if (r.ok) { botUserId = r.user_id as string; botTeamId = r.team_id as string; }
}

async function onEvent(ev: any, teamId?: string): Promise<void> {
  if (!ev || (ev.type !== 'message' && ev.type !== 'app_mention')) return;
  // DMs arrive as message.im; in channels only @-mentions reach the bot.
  if (ev.type === 'message' && (ev.channel_type !== 'im' || ev.subtype || ev.bot_id)) return;
  // Two locks: the sender must be you, and the event must come from the
  // bot's own workspace (not a Slack Connect channel shared in from another
  // org). Until auth.test has answered, nothing is trusted.
  if (!botTeamId || teamId !== botTeamId) {
    console.warn(`[slack] ignored an event from workspace ${teamId} (not the bot's workspace)`);
    return;
  }
  if (!allowedUser || ev.user !== allowedUser) {
    console.warn(`[slack] ignored a message from ${ev.user} (not the configured user)`);
    return;
  }
  const id = `${ev.channel}:${ev.ts}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 500) seen.delete(seen.values().next().value!);

  const text = fromSlackText(String(ev.text || ''), botUserId);
  if (!text) return;
  // DM: top level is one running conversation, each thread its own. Channel
  // mention: always answered in a thread under the mention.
  const thread: string | undefined = ev.thread_ts || (ev.type === 'app_mention' ? ev.ts : undefined);
  const key = thread ? `${ev.channel}:${thread}` : String(ev.channel);
  await handleMessage(text, key, { channel: ev.channel, thread });
}

let reconfigureTimer: NodeJS.Timeout | undefined;
// Settings changed: reconnect with the new values. Debounced — the settings
// fields save on every keystroke.
export function reconfigureSlack(): void {
  if (reconfigureTimer) clearTimeout(reconfigureTimer);
  reconfigureTimer = setTimeout(() => {
    reconfigureTimer = undefined;
    dmChannel = undefined;
    backoffMs = 2000;
    void connect(++generation);
  }, 1200);
}

/* --------------------------------------------------------------------- ipc */

// Settings → Slack → "Send test message": checks both tokens and that the
// member ID reaches you, by DMing you.
async function testConnection(): Promise<{ ok: boolean; message: string }> {
  const s = await loadSettings();
  const problem = configProblem({ ...s, slackEnabled: true });
  if (problem) return { ok: false, message: problem };
  const auth = await slackApi('auth.test', s.slackBotToken!);
  if (!auth.ok) return { ok: false, message: `Bot token: ${auth.error}` };
  const open = await slackApi('apps.connections.open', s.slackAppToken!);
  if (!open.ok) return { ok: false, message: `App token: ${open.error}` };
  const dm = await slackApi('conversations.open', s.slackBotToken!, { users: s.slackUserId!.trim() });
  if (!dm.ok) return { ok: false, message: `Couldn't open a DM with ${s.slackUserId}: ${dm.error}` };
  const msg = await slackApi('chat.postMessage', s.slackBotToken!, {
    channel: dm.channel.id,
    text: '👋 openDev is connected. Message me here to work in the IDE — send `help` for commands.'
  });
  if (!msg.ok) return { ok: false, message: `Couldn't post: ${msg.error}` };
  return { ok: true, message: `Sent a DM from @${auth.user} in ${auth.team}` };
}

export function registerSlackIpc(): void {
  ipcMain.handle(IPC.SlackStatus, () => status);
  ipcMain.handle(IPC.SlackTest, () => testConnection());

  aiTurnEvents.on('activity', onActivity);
  aiTurnEvents.on('done', (d: AiTurnDone) => { void onTurnDone(d).catch((err) => console.error('[slack] reply failed', err)); });
  serviceManager.onStatusChange((rt) => { void onServiceStatus(rt).catch(() => {}); });
  onJiraRunEnd((t) => { void onJiraEnd(t).catch(() => {}); });

  void connect(++generation);
  onShutdown(() => { generation++; teardown(); });
}
