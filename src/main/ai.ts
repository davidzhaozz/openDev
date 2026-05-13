import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { ChatAttachment, ChatMessage, Conversation } from '@shared/types';
import { getStorageDir, loadSettings } from './storage.js';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { LIMITS, tail } from './limits.js';

// AI-response accumulator that caps the final assistant text. Once we
// exceed the cap we stop concatenating and just remember that we did —
// the caller substitutes a truncation marker before persisting.
function makeResponseAcc(): {
  append: (s: string) => void;
  value: () => string;
  truncated: () => boolean;
} {
  let buf = '';
  let cut = false;
  const cap = LIMITS.aiResponseBytes;
  return {
    append: (s) => {
      if (cut) return;
      if (buf.length + s.length > cap) {
        buf = buf.slice(0, cap) + `\n\n[response truncated — exceeded ${cap} bytes]`;
        cut = true;
      } else {
        buf += s;
      }
    },
    value: () => buf,
    truncated: () => cut
  };
}

// Trim conversation history before save so a long-running chat doesn't
// turn into a multi-megabyte JSON blob we re-parse on every load.
function trimConversation(c: Conversation): void {
  const cap = LIMITS.rendererConversationMessages;
  if (c.messages.length > cap) {
    c.messages = c.messages.slice(c.messages.length - cap);
  }
}

const activeStreams = new Map<string, AbortController | ChildProcess>();

function convDir(): string { return join(getStorageDir(), 'conversations'); }
function convPath(id: string): string { return join(convDir(), `${id}.json`); }

async function listConversations(): Promise<Conversation[]> {
  try {
    const entries = await fs.readdir(convDir());
    const out: Conversation[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await fs.readFile(join(convDir(), e), 'utf8')) as Conversation;
        out.push(c);
      } catch {}
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch { return []; }
}

async function loadConversation(id: string): Promise<Conversation | null> {
  try {
    return JSON.parse(await fs.readFile(convPath(id), 'utf8'));
  } catch { return null; }
}

async function saveConversation(c: Conversation): Promise<void> {
  c.updatedAt = Date.now();
  await fs.writeFile(convPath(c.id), JSON.stringify(c, null, 2), 'utf8');
}

type IdeContext = {
  workspaceRoot?: string;
  activeTab?: { kind: string; name: string; path?: string; contentPreview?: string } | null;
  openTabs?: Array<{ kind: string; name: string; path?: string; active?: boolean }>;
};

function buildIdeContextBlock(ctx: IdeContext | undefined): string {
  if (!ctx) return '';
  const lines: string[] = ['<ide-context>'];
  if (ctx.workspaceRoot) lines.push(`workspace: ${ctx.workspaceRoot}`);
  if (ctx.openTabs && ctx.openTabs.length) {
    lines.push('open tabs:');
    for (const t of ctx.openTabs) {
      const marker = t.active ? '*' : ' ';
      const ref = t.path ? t.path : `[${t.kind}] ${t.name}`;
      lines.push(`  ${marker} ${ref}`);
    }
  }
  if (ctx.activeTab) {
    if (ctx.activeTab.path) lines.push(`active file: ${ctx.activeTab.path}`);
    else lines.push(`active tab: [${ctx.activeTab.kind}] ${ctx.activeTab.name}`);
    if (ctx.activeTab.contentPreview) {
      lines.push('active file contents:');
      lines.push('```');
      lines.push(ctx.activeTab.contentPreview);
      lines.push('```');
    }
  }
  lines.push('</ide-context>');
  return lines.join('\n');
}

// Instructions we prepend to the FIRST turn of a conversation so Claude knows
// about the IDE-specific affordances (design proposals tab, follow-up Q&A).
// On `--resume` turns we skip this; the model already has them in context.
const IDE_SYSTEM_INSTRUCTIONS = `<ide-instructions>
You are running inside openDev. A few IDE-specific conventions:

1. ASKING THE USER QUESTIONS
   ⚠️ DO NOT use the AskUserQuestion tool — it is disallowed in this
   environment and will fail. Instead, when you need information from the
   user before continuing, just WRITE THE QUESTION AS PLAIN TEXT in your
   reply and stop. The IDE will wait for the user's reply and resume the
   same Claude session on the next turn — full conversation context (file
   reads, tool results, this question) is preserved across turns, so the
   user can answer naturally and you'll know exactly what was asked.

   Example: instead of calling AskUserQuestion, just write:
       "Before I proceed I need to know: should the realtime/sdp proxy
       stream the response, or is one-shot fine? Please reply with 'stream'
       or 'one-shot'."
   Then stop. The user types their reply, you receive it as the next user
   turn (with all your prior tool calls and reasoning still in context).

2. ADDING APPLICATION-WIDE LOGGING
   If the user asks for app-wide / cross-cutting logging (phrases like
   "log what's happening across the app", "add logging everywhere",
   "trace what's going on", "instrument all services"), DO NOT just add
   logging to one file or one app. Instead:

   a) First, list the top-level apps under \`apps/*\` (or wherever the
      monorepo's services live) so you have a full picture.
   b) Add logging to EVERY relevant app — backend services, frontends,
      gateways, workers, ETL jobs, etc. Each should log its own key
      events with a clear prefix identifying which service produced
      the message (e.g. \`[my-service-backend] auth.login user=…\`).
   c) Cover the critical lifecycle points in each: incoming requests,
      outbound API calls, DB queries, queue events, errors,
      configuration loaded, listeners bound to ports. Skip noisy debug
      lines unless the user asked for them.
   d) Use the project's existing logger if one exists (NestJS Logger,
      pino, winston, console.log — match the convention already in
      that file). Do NOT introduce a new logger dependency.

   The user sees all this output unified in the IDE's "LOG" tab on the
   right — every line each service writes to stdout/stderr becomes a
   bubble there. So be specific, prefix lines by service name, and
   make events distinguishable.

3. PROPOSING MULTIPLE DESIGNS
   When the user asks you to "show", "propose", "mock up", "redesign", or
   otherwise compare multiple design options (UI / layout / styling), DO NOT
   write the files yet. Instead, emit 2–3 self-contained HTML previews, each
   in its own fenced block tagged with the language id
   \`html-proposal:NAME\` (replace NAME with a short label like "Minimal",
   "Bold", "Cards"). The IDE will pop these open side-by-side in the center
   tab area so the user can pick one. Wait for the user to choose before
   writing any files.

   Each preview must be a complete standalone HTML document with inline
   styles (no external scripts/stylesheets — they will be rendered in a
   sandboxed iframe with no network access). Use the SAME content the user
   referenced so the only difference between proposals is the design.

   Example:
   \`\`\`html-proposal:Minimal
   <!doctype html><html><body style="font:14px system-ui;padding:24px">
   ... minimal version ...
   </body></html>
   \`\`\`

   \`\`\`html-proposal:Bold
   <!doctype html><html><body style="font:14px system-ui;padding:24px;background:#111;color:#fff">
   ... bold version ...
   </body></html>
   \`\`\`

   After the user picks, you will receive a follow-up message like
   "I chose Bold. Please apply it to <path>." — then write the real files.
</ide-instructions>`;

function buildPrompt(messages: ChatMessage[], attachments: ChatAttachment[] | undefined, userText: string, ideCtx?: IdeContext, includeSystemInstructions?: boolean): string {
  const ctx: string[] = [];
  if (includeSystemInstructions) ctx.push(IDE_SYSTEM_INSTRUCTIONS);
  const ctxBlock = buildIdeContextBlock(ideCtx);
  if (ctxBlock) ctx.push(ctxBlock);
  for (const a of attachments || []) {
    if (a.kind === 'selection') {
      ctx.push(`[Selected from ${a.path}]\n${a.text}`);
    } else if (a.kind === 'picked-element') {
      ctx.push(`[Picked element: ${a.cssPath}]\n${a.outerHTML}`);
    } else if (a.kind === 'file' && a.text) {
      ctx.push(`[File: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``);
    } else if (a.kind === 'file' && a.dataUrl) {
      ctx.push(`[Image attached: ${a.name}]`);
    }
  }
  const body = [...ctx, userText].join('\n\n');
  return body;
}

function buildSdkContent(attachments: ChatAttachment[] | undefined, userText: string): string | Array<Record<string, unknown>> {
  const images = (attachments || []).filter(a => a.kind === 'file' && a.dataUrl) as Array<Extract<ChatAttachment, { kind: 'file' }>>;
  if (images.length === 0) return userText;
  const blocks: Array<Record<string, unknown>> = [];
  for (const img of images) {
    if (!img.dataUrl) continue;
    const m = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: m[1], data: m[2] }
    });
  }
  blocks.push({ type: 'text', text: userText });
  return blocks;
}

async function streamViaClaudeSdk(streamId: string, text: string, conv: Conversation, attachments: ChatAttachment[] | undefined): Promise<void> {
  const settings = await loadSettings();
  const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY set (Settings → Anthropic API key)');
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });
  const abort = new AbortController();
  activeStreams.set(streamId, abort);
  const sysPrompt = `You are the assistant inside openDev. Project root: ${workspace.getRoot() ?? '(none)'}. Be concise.`;

  const messages = conv.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.text })) as Array<{ role: 'user' | 'assistant'; content: any }>;
  const lastContent = buildSdkContent(attachments, text);
  messages.push({ role: 'user', content: lastContent });

  const acc = makeResponseAcc();
  try {
    const stream = await client.messages.stream({
      model: settings.anthropicModel || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: sysPrompt,
      messages
    }, { signal: abort.signal });
    for await (const event of stream) {
      if ((event as any).type === 'content_block_delta' && (event as any).delta?.type === 'text_delta') {
        const t = (event as any).delta.text as string;
        acc.append(t);
        // Don't keep streaming chunks to the renderer past the cap either —
        // the renderer-side store has its own cap but no point making it work.
        if (!acc.truncated()) safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
      }
    }
    safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  } finally {
    activeStreams.delete(streamId);
  }
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now() });
  trimConversation(conv);
  await saveConversation(conv);
}

async function streamViaClaudeCli(streamId: string, text: string, conv: Conversation): Promise<void> {
  const settings = await loadSettings();
  const claudeBin = settings.claudeCliPath || 'claude';
  const cwd = workspace.getRoot() || process.env.HOME || '/';
  // `--output-format stream-json --verbose` gives us a line-delimited event
  // stream so we can surface progress + tool calls in real time, instead of
  // waiting for the whole run to finish and then dump.
  //
  // CRITICAL: we ALWAYS pass the prompt via stdin, never as a positional
  // arg. Reason: `--disallowedTools <tools...>` is a variadic option, and
  // commander.js greedily consumes following positional args as tool names
  // — which would eat the prompt on first turn (no `--resume` between
  // them) and Claude would receive no user message. Using stdin sidesteps
  // the whole class of arg-consumption bugs.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    // bypassPermissions = no per-tool approval prompts. The IDE chat is
    // already an opted-in surface, so we trust the model to write/edit
    // and surface the diff after.
    '--permission-mode', 'bypassPermissions',
    // Disallow the interactive question/permission tools — in headless
    // `-p` mode they have nowhere to surface and would hang the run.
    // The system prompt tells the model to ask via plain text instead.
    '--disallowedTools', 'AskUserQuestion'
  ];
  // If we already have a session id from a previous turn in this
  // conversation, resume it so the model keeps full context.
  if (conv.claudeSessionId) {
    args.push('--resume', conv.claudeSessionId);
  }
  console.log(`[claude cli] spawn ${claudeBin} ${args.slice(0, 4).join(' ')}… in ${cwd} (prompt: ${text.length} chars)`);
  const proc = spawn(claudeBin, args, {
    cwd,
    env: process.env,
    // Always pipe stdin so we can stream the prompt in — see the comment
    // on `args` above about why we don't pass it as a positional arg.
    stdio: ['pipe', 'pipe', 'pipe']
  });
  activeStreams.set(streamId, proc);
  let acc = '';
  let accTruncated = false;
  let stderr = '';
  let firstChunkAt: number | null = null;
  let stdoutBuf = '';
  let usedStreamJson = true;

  const noteFirstChunk = () => { if (firstChunkAt == null) firstChunkAt = Date.now(); };

  const emit = (chunk: string) => {
    noteFirstChunk();
    if (accTruncated) return;
    if (acc.length + chunk.length > LIMITS.aiResponseBytes) {
      const marker = `\n\n[response truncated — exceeded ${LIMITS.aiResponseBytes} bytes; killing CLI]\n`;
      acc = acc.slice(0, LIMITS.aiResponseBytes) + marker;
      accTruncated = true;
      safeSend(IPC.AiStream, { streamId, chunk: marker, done: false });
      try { proc.kill('SIGTERM'); } catch {}
      return;
    }
    acc += chunk;
    safeSend(IPC.AiStream, { streamId, chunk, done: false });
  };

  const handleEvent = (ev: any) => {
    // The claude stream-json schema (as of late 2025):
    //   { type: "system", subtype: "init", ... }
    //   { type: "assistant", message: { content: [{type:"text", text:"..."}, ...] } }
    //   { type: "user", message: {...} }          // tool inputs
    //   { type: "result", subtype: "success", result: "...", ... }
    if (!ev || typeof ev !== 'object') return;
    const t = ev.type;
    if (t === 'assistant') {
      const content = ev.message?.content || [];
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          emit(c.text);
        } else if (c?.type === 'tool_use' && c.name) {
          emit(`\n› using tool: ${c.name}\n`);
        }
      }
    } else if (t === 'user') {
      // Tool results coming back to the model — surface a one-line marker
      // so the user can see when a tool produced output.
      const content = ev.message?.content || [];
      for (const c of content) {
        if (c?.type === 'tool_result' && typeof c.content === 'string') {
          const preview = c.content.slice(0, 80).replace(/\n/g, ' ');
          emit(`  ↳ ${preview}${c.content.length > 80 ? '…' : ''}\n`);
        }
      }
    } else if (t === 'result') {
      if (typeof ev.result === 'string' && acc.length === 0) emit(ev.result);
      // The result event also carries the session_id — keep ours up to date.
      if (typeof ev.session_id === 'string') {
        conv.claudeSessionId = ev.session_id;
      }
    } else if (t === 'system') {
      // The first event is `{type:"system", subtype:"init", session_id:"…"}`.
      // Capture it so we can `--resume <id>` on the next turn. Always
      // overwrite — when we resume, the CLI may issue a new id for the
      // continued thread and we want to keep following it.
      if (ev.subtype === 'init' && typeof ev.session_id === 'string') {
        const wasNew = !conv.claudeSessionId;
        conv.claudeSessionId = ev.session_id;
        if (wasNew) console.log(`[claude cli] captured session_id=${ev.session_id} for conv=${conv.id}`);
      }
    }
  };

  proc.on('error', (err) => {
    const msg = `\n[claude cli failed to spawn] ${err.message}\n` +
      `Check Settings → AI CLI paths. Currently using: ${claudeBin}\n` +
      `Make sure ${claudeBin === 'claude' ? "'claude' is on PATH" : `the file ${claudeBin} exists`} and you've run 'claude login' at least once.\n`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
    console.error('[claude cli] spawn error', err.message);
  });

  proc.stdout?.on('data', (b: Buffer) => {
    stdoutBuf += b.toString('utf8');
    // Defense against a stream-json line that never terminates: if the
    // un-newlined buffer balloons past the cap, the CLI is misbehaving.
    // Drop it and tell the user rather than holding it forever.
    if (stdoutBuf.length > LIMITS.aiLineBufferBytes) {
      console.error(`[claude cli] stdout buffer exceeded ${LIMITS.aiLineBufferBytes} bytes without newline — dropping`);
      stdoutBuf = '';
      emit(`\n[stream parse error — dropped ${LIMITS.aiLineBufferBytes} bytes with no newline]\n`);
      return;
    }
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      // Try JSON first; if the line isn't JSON, the CLI version may not
      // support stream-json and is just printing plain text.
      try {
        const ev = JSON.parse(line);
        handleEvent(ev);
      } catch {
        usedStreamJson = false;
        emit(line + '\n');
      }
    }
  });
  proc.stderr?.on('data', (b: Buffer) => {
    const t = b.toString('utf8');
    // Keep just the tail — long stderr output (npm install spam, etc.)
    // can otherwise grow without bound.
    stderr = tail(stderr + t, LIMITS.aiStderrTailBytes);
    console.error('[claude cli stderr]', t.trimEnd());
    safeSend(IPC.AiStream, { streamId, chunk: `[stderr] ${t}`, done: false });
  });

  if (proc.stdin) {
    proc.stdin.write(text);
    proc.stdin.end();
  }

  // Repeating heartbeat so the user knows we haven't dropped the call.
  let waitedSec = 0;
  let lastChunkAt = Date.now();
  const heartbeat = setInterval(() => {
    if (firstChunkAt == null) {
      waitedSec += 10;
      safeSend(IPC.AiStream, {
        streamId,
        chunk: `\n[still waiting on ${claudeBin} (${waitedSec}s)… Press Stop to cancel.]\n`,
        done: false
      });
    }
  }, 10_000);

  // Idle watchdog: if the subprocess produces no output for 60 seconds at
  // ANY point (not just before the first chunk), it's almost certainly
  // hung — kill it so the renderer flips `sending` back to false. Without
  // this, a stuck tool call would trap the composer forever. 60s gives
  // long tool calls room to run while bounding the worst-case wait.
  const IDLE_KILL_MS = 60_000;
  const idleWatchdog = setInterval(() => {
    if (Date.now() - lastChunkAt > IDLE_KILL_MS) {
      console.warn(`[claude cli] idle for ${IDLE_KILL_MS}ms — killing subprocess`);
      safeSend(IPC.AiStream, {
        streamId,
        chunk: `\n[no output for ${Math.round(IDLE_KILL_MS / 1000)}s — killing subprocess so you can try again]\n`,
        done: false
      });
      try { proc.kill('SIGTERM'); } catch {}
      // close handler will fire and resolve the outer promise
    }
  }, 15_000);
  // Stamp lastChunkAt on any stream activity so the watchdog only fires
  // during true silence. (Both stdout and stderr count as activity.)
  proc.stdout?.on('data', () => { lastChunkAt = Date.now(); });
  proc.stderr?.on('data', () => { lastChunkAt = Date.now(); });

  await new Promise<void>((resolve) => {
    proc.on('close', (code) => {
      clearInterval(heartbeat);
      clearInterval(idleWatchdog);
      // Drain any trailing partial line as plain text
      if (stdoutBuf.trim()) {
        try { handleEvent(JSON.parse(stdoutBuf)); }
        catch { emit(stdoutBuf); }
        stdoutBuf = '';
      }
      console.log(`[claude cli] exit code=${code} acc=${acc.length} stderr=${stderr.length} streamJson=${usedStreamJson}`);
      if (acc.length === 0 && code !== 0) {
        const msg = `\n[claude cli exited ${code} with no output]\n` +
          (stderr ? `stderr:\n${stderr}\n` : '') +
          `Try in Terminal: \`${claudeBin} -p "hello"\`. If that hangs or errors, the CLI isn't configured. Run \`claude login\` first.\n`;
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc = msg;
      }
      resolve();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc, createdAt: Date.now() });
  trimConversation(conv);
  await saveConversation(conv);
}

async function streamViaOpenAiSdk(streamId: string, text: string, conv: Conversation, attachments: ChatAttachment[] | undefined): Promise<void> {
  const settings = await loadSettings();
  const apiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('No OPENAI_API_KEY set (Settings → OpenAI API key)');
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey });
  const abort = new AbortController();
  activeStreams.set(streamId, abort);
  const sysPrompt = `You are the assistant inside openDev. Project root: ${workspace.getRoot() ?? '(none)'}. Be concise.`;

  // OpenAI uses a "messages" array with role+content. Multimodal content can
  // be sent as an array of parts; we use text-only for simplicity but include
  // images when attached.
  type OAMsg = { role: 'system' | 'user' | 'assistant'; content: any };
  const messages: OAMsg[] = [{ role: 'system', content: sysPrompt }];
  for (const m of conv.messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.text });
    }
  }
  // Build last user message with possible image attachments
  const imgs = (attachments || []).filter(a => a.kind === 'file' && (a as any).dataUrl);
  if (imgs.length > 0) {
    const parts: any[] = [{ type: 'text', text }];
    for (const img of imgs as any[]) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: text });
  }

  const acc = makeResponseAcc();
  try {
    const stream = await client.chat.completions.create({
      model: settings.openaiModel || 'gpt-4o-mini',
      messages,
      stream: true
    }, { signal: abort.signal });
    for await (const chunk of stream) {
      const t = chunk.choices?.[0]?.delta?.content;
      if (typeof t === 'string' && t.length) {
        acc.append(t);
        if (!acc.truncated()) safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
      }
    }
    safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  } finally {
    activeStreams.delete(streamId);
  }
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now() });
  trimConversation(conv);
  await saveConversation(conv);
}

async function streamViaCodexCli(streamId: string, text: string, conv: Conversation): Promise<void> {
  const settings = await loadSettings();
  const codexBin = settings.codexCliPath || 'codex';
  const proc = spawn(codexBin, ['exec', '--skip-git-repo-check', text], {
    cwd: workspace.getRoot() || process.env.HOME,
    env: process.env
  });
  activeStreams.set(streamId, proc);
  const acc = makeResponseAcc();
  proc.stdout.on('data', (b: Buffer) => {
    const t = b.toString('utf8');
    acc.append(t);
    if (acc.truncated()) {
      // Past the cap: kill the subprocess so we don't keep heating up the
      // pipe with bytes we'll throw away.
      try { proc.kill('SIGTERM'); } catch {}
      return;
    }
    safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
  });
  proc.stderr.on('data', (b: Buffer) => console.error('[codex cli]', b.toString('utf8')));
  await new Promise<void>((resolve) => {
    proc.on('close', () => resolve());
    proc.on('error', (err) => {
      safeSend(IPC.AiStream, { streamId, chunk: `\n[codex cli error] ${err.message}\n`, done: false });
      resolve();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now() });
  trimConversation(conv);
  await saveConversation(conv);
}

export function registerAiIpc() {
  ipcMain.handle(IPC.AiConversations, () => listConversations());
  ipcMain.handle(IPC.AiConversationGet, (_e, id: string) => loadConversation(id));
  ipcMain.handle(IPC.AiConversationDelete, async (_e, id: string) => {
    try { await fs.unlink(convPath(id)); } catch {}
    return true;
  });

  ipcMain.handle(IPC.AiSend, async (_e, args: {
    conversationId?: string;
    text: string;
    attachments?: ChatAttachment[];
    transport?: 'claude-sdk' | 'claude-cli' | 'openai-sdk' | 'codex-cli' | 'sdk' | 'cli';
    context?: IdeContext;
  }) => {
    let conv: Conversation;
    if (args.conversationId) {
      conv = (await loadConversation(args.conversationId))!;
      if (!conv) throw new Error('Conversation not found');
    } else {
      conv = {
        id: randomUUID(),
        title: args.text.slice(0, 60) || 'New conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        workspaceRoot: workspace.getRoot()
      };
    }
    conv.messages.push({
      id: randomUUID(),
      role: 'user',
      text: args.text,
      attachments: args.attachments,
      createdAt: Date.now()
    });
    await saveConversation(conv);
    const streamId = randomUUID();
    // Map legacy values "sdk"/"cli" to the claude defaults.
    const raw = args.transport || 'claude-cli';
    const transport: 'claude-sdk' | 'claude-cli' | 'openai-sdk' | 'codex-cli' =
      raw === 'sdk' ? 'claude-sdk' : raw === 'cli' ? 'claude-cli' : raw;
    // First turn = include the IDE convention instructions (design-proposals
    // format, follow-up Q&A behavior). Resumed turns don't need them
    // re-sent — they're already in the model's context.
    const isFirstTurn = !conv.claudeSessionId;
    const prompt = buildPrompt(conv.messages.slice(0, -1), args.attachments, args.text, args.context, isFirstTurn);
    const run = (() => {
      if (transport === 'claude-cli') return () => streamViaClaudeCli(streamId, prompt, conv);
      if (transport === 'openai-sdk') return () => streamViaOpenAiSdk(streamId, prompt, conv, args.attachments);
      if (transport === 'codex-cli') return () => streamViaCodexCli(streamId, prompt, conv);
      return () => streamViaClaudeSdk(streamId, prompt, conv, args.attachments);
    })();
    run().catch((err) => {
      safeSend(IPC.AiStream, {
        streamId,
        chunk: `\n[error] ${err.message}\n`,
        done: true,
        full: ''
      });
    });
    return { conversationId: conv.id, streamId };
  });

  ipcMain.handle(IPC.AiCancel, (_e, streamId: string) => {
    const s = activeStreams.get(streamId);
    if (!s) return false;
    if ('abort' in s) (s as AbortController).abort();
    else (s as ChildProcess).kill();
    activeStreams.delete(streamId);
    return true;
  });
}
