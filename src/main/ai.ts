import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc';
import type { ChatAttachment, ChatMessage, Conversation } from '@shared/types';
import { loadSettings } from './storage.js';
import { workspace } from './workspace.js';
import { safeSend } from './safeSend.js';
import { LIMITS, tail } from './limits.js';
import { resolveBinPath, spawnBin } from './platform.js';
import { isAbsolutePath } from '@shared/paths';

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

// Per-workspace conversations: each project has its own AI chat history
// under .opendev/conversations/. Returns null when no workspace is open
// (callers degrade to empty results / errors).
function convDir(): string | null {
  const root = workspace.getRoot();
  if (!root) return null;
  return join(root, '.opendev', 'conversations');
}
function convPath(id: string): string | null {
  const dir = convDir();
  return dir ? join(dir, `${id}.json`) : null;
}

// Resolve a CLI name (e.g. "claude") to an absolute path. The walk itself is
// platform-specific — Windows has to try PATHEXT, since `claude`, `npm` and
// `tsx` are all `.cmd` shims there — so it lives in platform.ts. Re-exported
// here because this is where the rest of main/ has always imported it from.
export { resolveBinPath };

async function listConversations(): Promise<Conversation[]> {
  const dir = convDir();
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir);
    const out: Conversation[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await fs.readFile(join(dir, e), 'utf8')) as Conversation;
        out.push(c);
      } catch {}
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch { return []; }
}

async function loadConversation(id: string): Promise<Conversation | null> {
  const p = convPath(id);
  if (!p) return null;
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch { return null; }
}

async function saveConversation(c: Conversation): Promise<void> {
  const p = convPath(c.id);
  if (!p) return;
  c.updatedAt = Date.now();
  await fs.mkdir(join(p, '..'), { recursive: true });
  await fs.writeFile(p, JSON.stringify(c, null, 2), 'utf8');
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
You are running inside OpenDev IDE. A few IDE-specific conventions:

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

4. AUTHORING AI AGENTS
   An "AI Agent" is a self-contained Node.js application that runs against
   the workspace codebase (e.g. a test runner, a code-graph analyzer). When
   the user asks you to "create an agent" / "make a <kind> agent", just WRITE
   THE FILES — there is no registration step; the IDE watches the agents
   folder and the new agent appears in the bottom-right "AI Agents" panel
   automatically.

   Layout — create a folder at \`.opendev/agents/<slug>/\` (slug = kebab-case)
   containing:
   a) \`agent.json\` — the manifest:
      {
        "slug": "<slug>",
        "name": "<human label>",
        "description": "<one line>",
        "entry": "index.js",        // path relative to this folder
        "runtime": "node",          // "node" for .js/.mjs, "tsx" for .ts
        "createdBy": "ai",
        "createdAt": <Date.now()>
      }
   b) the entry file (and any other source / bundled npm deps).

   Runtime contract for the entry file:
   - It runs with cwd = the workspace root (the codebase under analysis).
   - \`process.env.OPENDEV_WORKSPACE_ROOT\` = absolute path to the codebase.
   - \`process.env.OPENDEV_AGENT_DIR\` = absolute path to the agent's own folder
     (use it to locate bundled files / node_modules).
   - Write results to stdout. If the FIRST thing printed is a complete HTML
     document (starts with \`<!doctype html>\` or \`<html>\`), the IDE renders it
     in a sandboxed iframe in a center tab — good for a graph/visualization.
     Otherwise stdout streams as a plain text log. stderr is also streamed.
   - Prefer \`runtime: "node"\` with plain \`.js\`/\`.mjs\`; only use \`runtime: "tsx"\`
     if the user explicitly wants TypeScript (it requires \`tsx\` installed).
   - Bundle npm dependencies inside the agent folder; do not assume a later
     \`npm install\` step.
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
  const sysPrompt = `You are the assistant inside OpenDev IDE. Project root: ${workspace.getRoot() ?? '(none)'}. Be concise.`;

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
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now(), provider: 'claude' });
  trimConversation(conv);
  await saveConversation(conv);
}

async function streamViaClaudeCli(streamId: string, text: string, conv: Conversation): Promise<void> {
  const settings = await loadSettings();
  const configuredBin = settings.claudeCliPath || 'claude';
  // Resolve to an absolute path so a Finder-launched .app (minimal PATH) can
  // still find claude in ~/.local/bin etc., and so failures get blamed on
  // the right thing instead of bubbling up as a generic ENOENT.
  const claudeBin = resolveBinPath(configuredBin);
  if (!claudeBin) {
    const pathDisp = (process.env.PATH || '').split(':').filter(Boolean).join('\n  ');
    const msg = `\n[claude cli not found]\n` +
      `Looked for '${configuredBin}' on PATH:\n  ${pathDisp}\n\n` +
      `Set Settings → AI CLI paths → Claude CLI path to an absolute path, e.g. ${process.env.HOME || '~'}/.local/bin/claude.\n`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    conv.messages.push({ id: randomUUID(), role: 'assistant', text: msg, createdAt: Date.now(), provider: 'claude' });
    trimConversation(conv);
    await saveConversation(conv);
    return;
  }
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
  // Filter Electron-specific env vars before handing to claude. Without this,
  // a Finder-launched .app passes things like ELECTRON_RUN_AS_NODE and other
  // packaging vars that can confuse child tools or leak Electron behavior
  // into hook subshells. We keep everything else (PATH, HOME, locale,
  // user-set API keys, etc.) so user customizations still apply.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (k.startsWith('ELECTRON_')) continue;
    if (k === 'NODE_OPTIONS') continue;
    childEnv[k] = v;
  }
  const proc = spawnBin(claudeBin, args, {
    cwd,
    env: childEnv,
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
  // Set when WE kill the subprocess, so the close handler can report an
  // accurate cause instead of generically blaming `claude login`.
  let killReason: 'response-cap' | 'idle-watchdog' | null = null;

  const noteFirstChunk = () => { if (firstChunkAt == null) firstChunkAt = Date.now(); };

  const emit = (chunk: string) => {
    noteFirstChunk();
    if (accTruncated) return;
    if (acc.length + chunk.length > LIMITS.aiResponseBytes) {
      const marker = `\n\n[response truncated — exceeded ${LIMITS.aiResponseBytes} bytes; killing CLI]\n`;
      acc = acc.slice(0, LIMITS.aiResponseBytes) + marker;
      accTruncated = true;
      safeSend(IPC.AiStream, { streamId, chunk: marker, done: false });
      killReason = 'response-cap';
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
      `Binary: ${claudeBin}\n` +
      `Make sure the file exists and is executable, and that you've run \`claude login\` at least once.\n`;
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
      killReason = 'idle-watchdog';
      try { proc.kill('SIGTERM'); } catch {}
      // close handler will fire and resolve the outer promise
    }
  }, 15_000);
  // Stamp lastChunkAt on any stream activity so the watchdog only fires
  // during true silence. (Both stdout and stderr count as activity.)
  proc.stdout?.on('data', () => { lastChunkAt = Date.now(); });
  proc.stderr?.on('data', () => { lastChunkAt = Date.now(); });

  await new Promise<void>((resolve) => {
    proc.on('close', (code, signal) => {
      clearInterval(heartbeat);
      clearInterval(idleWatchdog);
      // Drain any trailing partial line as plain text
      if (stdoutBuf.trim()) {
        try { handleEvent(JSON.parse(stdoutBuf)); }
        catch { emit(stdoutBuf); }
        stdoutBuf = '';
      }
      console.log(`[claude cli] exit code=${code} signal=${signal} kill=${killReason ?? 'none'} acc=${acc.length} stderr=${stderr.length} streamJson=${usedStreamJson}`);
      // Bun-compiled binaries (like claude) translate SIGTERM into exit code
      // 143, so signal is null but code reveals the kill.
      const wasKilled = signal != null || code === 143;
      if (acc.length === 0 && (code !== 0 || signal)) {
        let cause: string;
        if (killReason === 'idle-watchdog') {
          cause = `claude produced no output for 60s; the IDE killed it. The CLI may be hanging on auth or a slow tool call.\n` +
            `Try \`${claudeBin} -p "hello"\` in Terminal to confirm the CLI is working.`;
        } else if (killReason === 'response-cap') {
          cause = `Response exceeded the ${LIMITS.aiResponseBytes}-byte cap and was truncated.`;
        } else if (wasKilled) {
          cause = `claude was killed externally (Stop button, IDE quitting, or OS). The IDE didn't initiate this kill — if you didn't press Stop, check Console.app for the parent app being terminated.`;
        } else {
          cause = `claude exited on its own with code=${code}. Try \`${claudeBin} -p "hello"\` in Terminal — if that errors, the CLI isn't configured (run \`claude login\`).`;
        }
        const msg = `\n[claude cli error: exit code=${code} signal=${signal ?? 'none'}${killReason ? ` kill=${killReason}` : ''}]\n` +
          `Binary: ${claudeBin}\n` +
          (stderr ? `stderr:\n${stderr}\n` : '') +
          cause + '\n';
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc = msg;
      }
      resolve();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc, createdAt: Date.now(), provider: 'claude' });
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
  const sysPrompt = `You are the assistant inside OpenDev IDE. Project root: ${workspace.getRoot() ?? '(none)'}. Be concise.`;

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
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now(), provider: 'codex' });
  trimConversation(conv);
  await saveConversation(conv);
}

async function streamViaCodexCli(streamId: string, text: string, conv: Conversation): Promise<void> {
  const settings = await loadSettings();
  const codexBin = settings.codexCliPath || 'codex';
  const cwd = workspace.getRoot() || process.env.HOME || '/';
  console.log(`[codex cli] spawn ${codexBin} exec --skip-git-repo-check  in ${cwd} (prompt: ${text.length} chars)`);
  // stdin = ignore: the prompt is passed as a positional arg. Without an
  // immediate EOF on stdin, codex's "Reading additional input from stdin…"
  // step waits forever.
  // As of codex-cli 0.130, stdout is the clean final answer and stderr
  // carries the banner / prompt-echo / "tokens used" noise — so we stream
  // stdout straight to the chat and keep stderr only for diagnostics.
  const proc = spawnBin(codexBin, ['exec', '--skip-git-repo-check', text], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeStreams.set(streamId, proc);
  const acc = makeResponseAcc();
  let stderrBuf = '';

  const emit = (chunk: string) => {
    acc.append(chunk);
    if (acc.truncated()) {
      try { proc.kill('SIGTERM'); } catch {}
      return;
    }
    safeSend(IPC.AiStream, { streamId, chunk, done: false });
  };

  proc.on('error', (err) => {
    const msg = `\n[codex cli failed to spawn] ${err.message}\n` +
      `Binary: ${codexBin}\n` +
      `Make sure the file exists and is executable, and that you've signed in to codex.\n`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
    console.error('[codex cli] spawn error', err.message);
  });

  proc.stdout?.on('data', (b: Buffer) => emit(b.toString('utf8')));

  proc.stderr?.on('data', (b: Buffer) => {
    const t = b.toString('utf8');
    stderrBuf = tail(stderrBuf + t, LIMITS.aiStderrTailBytes);
    console.error('[codex cli stderr]', t.trimEnd());
  });

  await new Promise<void>((resolve) => {
    proc.on('close', (code) => {
      console.log(`[codex cli] exit code=${code} acc=${acc.value().length} stderr=${stderrBuf.length}`);
      if (acc.value().length === 0 && code !== 0) {
        const msg = `\n[codex cli exited ${code} with no output]\n` +
          (stderrBuf ? `stderr:\n${stderrBuf}\n` : '') +
          `Try in Terminal: \`${codexBin} exec --skip-git-repo-check "hello"\`. ` +
          `If that errors, the CLI isn't configured — run codex's login flow first.\n`;
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc.append(msg);
      }
      resolve();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now(), provider: 'codex' });
  trimConversation(conv);
  await saveConversation(conv);
}

// OpenCode CLI — local-first coding agent that talks to any OpenAI-compatible
// backend (default Ollama). It's a one-shot RAG-style command, not a streaming
// chat: we invoke `opencode ask <question>` with the user's configured base
// URL + model, capture stdout, and emit the whole thing in a single chunk.
async function streamViaOpenCodeCli(streamId: string, text: string, conv: Conversation): Promise<void> {
  const settings = await loadSettings();
  if (!settings.aiLocalEnabled) {
    const msg = '\n[opencode] Local AI is not enabled — turn it on in Settings → Local AI.\n';
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    return;
  }
  const configured = (settings.aiLocalBinPath || 'opencode').trim() || 'opencode';
  const bin = resolveBinPath(configured) || configured;
  const cwd = workspace.getRoot() || process.env.HOME || '/';

  // Pre-check the binary path. spawn()'s failure mode for a non-existent
  // binary is an 'error' event AND a 'close' event with libuv's negative
  // ENOENT code (-2), which produces two confusing log lines. Catching it
  // here lets us emit one clean error and skip the broken spawn entirely.
  if (isAbsolutePath(configured) && !existsSync(configured)) {
    const msg = `\n[opencode] No file at "${configured}".\n` +
      `Update Settings → Local AI → OpenCode binary. Either click Browse… to pick the actual binary, or paste the full path (e.g. ~/Desktop/repo/OpenCode/target/release/opencode).\n`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    return;
  }
  if (!isAbsolutePath(configured) && !resolveBinPath(configured)) {
    const msg = `\n[opencode] Binary "${configured}" not found on PATH.\n` +
      `PATH searched: ${process.env.PATH}\n` +
      `Either put opencode on your PATH or set an absolute path in Settings → Local AI → OpenCode binary (Browse…).\n`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: true, full: msg });
    return;
  }

  const args = ['ask', '--repo', cwd];
  if (settings.aiLocalBaseUrl?.trim()) {
    // OpenCode speaks the OpenAI chat protocol — it appends /chat/completions
    // to whatever base-url we pass. Ollama serves the OpenAI surface at
    // /v1/* (not at root), so a bare http://host:port returns 404 page not
    // found. Append /v1 if the user left it off. This matches the same
    // tolerance our discovery probe applies.
    let url = settings.aiLocalBaseUrl.trim().replace(/\/+$/, '');
    if (!/\/v\d+$/.test(url)) url += '/v1';
    args.push('--base-url', url);
  }
  if (settings.aiLocalModel?.trim()) { args.push('--model', settings.aiLocalModel.trim()); }
  if (settings.aiLocalApiKey?.trim()) { args.push('--api-key', settings.aiLocalApiKey.trim()); }
  // Positional question. OpenCode reads only argv — stdin is not consulted.
  args.push(text);

  // Echo the invocation into the chat as a status line so the user can SEE
  // the IDE is actually doing something. Previous builds went totally silent
  // during the multi-second indexing pass, which read as "broken".
  const displayArgs = args.slice(0, -1).join(' ');
  const startBanner = `\n_Running: ${bin} ${displayArgs} "<your question>"_\n_cwd: ${cwd}_\n`;
  safeSend(IPC.AiStream, { streamId, chunk: startBanner, done: false });

  console.log(`[opencode] spawn ${bin} ${displayArgs} <question> in ${cwd} (q=${text.length} chars)`);
  const proc = spawnBin(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  activeStreams.set(streamId, proc);
  const startedAt = Date.now();
  const acc = makeResponseAcc();
  let stderrBuf = '';
  let spawnErrored = false;
  let gotStdout = false;

  // Heartbeat so a stalled invocation doesn't look like a hang. Fires every
  // 15s as long as we haven't seen any stdout yet — gives the user a clock
  // they can use to decide whether to cancel.
  const heartbeat = setInterval(() => {
    if (gotStdout) return;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    safeSend(IPC.AiStream, { streamId, chunk: `\n_…still waiting on first stdout from opencode (${secs}s elapsed)_\n`, done: false });
  }, 15_000);

  proc.on('error', (err) => {
    spawnErrored = true;
    const code = (err as NodeJS.ErrnoException).code || '';
    const hint = code === 'ENOENT'
      ? `Binary not found at "${bin}". Update the path in Settings → Local AI → OpenCode binary.`
      : code === 'EACCES'
        ? `Permission denied executing "${bin}". Run \`chmod +x "${bin}"\` and try again.`
        : `Update Settings → Local AI → OpenCode binary if the path is wrong.`;
    const msg = `\n[opencode failed to spawn] ${err.message}\n${hint}\n`;
    safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
    acc.append(msg);
    console.error('[opencode] spawn error', err.message);
  });

  proc.stdout?.on('data', (b: Buffer) => {
    const t = b.toString('utf8');
    if (!gotStdout) {
      gotStdout = true;
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      safeSend(IPC.AiStream, { streamId, chunk: `\n_first stdout chunk after ${secs}s_\n\n`, done: false });
    }
    acc.append(t);
    if (acc.truncated()) { try { proc.kill('SIGTERM'); } catch {} return; }
    safeSend(IPC.AiStream, { streamId, chunk: t, done: false });
  });

  // OpenCode emits progress to stderr — "indexing /path...", "indexed N
  // chunks; retrieving top K", and the retrieval context block. Forward
  // every line so the user can see exactly what's happening during the
  // multi-second indexing pass. They're rendered in italics and not
  // persisted into the saved assistant message (we use `acc` for that).
  let stderrLineBuf = '';
  proc.stderr?.on('data', (b: Buffer) => {
    const t = b.toString('utf8');
    stderrBuf = tail(stderrBuf + t, LIMITS.aiStderrTailBytes);
    console.error('[opencode stderr]', t.trimEnd());
    stderrLineBuf += t;
    let nl: number;
    while ((nl = stderrLineBuf.indexOf('\n')) >= 0) {
      const line = stderrLineBuf.slice(0, nl).trim();
      stderrLineBuf = stderrLineBuf.slice(nl + 1);
      if (!line) continue;
      safeSend(IPC.AiStream, { streamId, chunk: `\n_${line}_\n`, done: false });
    }
  });

  await new Promise<void>((resolve) => {
    proc.on('close', (code, signal) => {
      clearInterval(heartbeat);
      console.log(`[opencode] exit code=${code} signal=${signal} acc=${acc.value().length} stderr=${stderrBuf.length}`);
      // If the 'error' event already explained what went wrong, don't pile
      // a second, less-informative message on top.
      if (spawnErrored) { resolve(); return; }
      if (acc.value().length === 0 && (code !== 0 || signal)) {
        // libuv reports spawn-time failures as negative `code` values
        // (e.g. -2 ENOENT, -13 EACCES). Those should have been caught by
        // the 'error' handler above; if we still land here with a negative
        // code, surface the libuv interpretation explicitly.
        let exitWord: string;
        if (signal) {
          exitWord = `terminated by ${signal}`;
        } else if (typeof code === 'number' && code < 0) {
          const libuv: Record<number, string> = { [-2]: 'ENOENT — binary not found', [-13]: 'EACCES — permission denied', [-8]: 'ENOEXEC — not a valid executable' };
          exitWord = `failed to spawn (${libuv[code] || `libuv code ${code}`})`;
        } else {
          exitWord = `exited ${code}`;
        }
        const msg = `\n[opencode ${exitWord} with no output]\n` +
          (stderrBuf ? `stderr:\n${stderrBuf}\n` : '') +
          `Common causes:\n` +
          `  • Backend not reachable at ${settings.aiLocalBaseUrl || 'http://localhost:11434/v1'} from this machine\n` +
          `  • Model "${settings.aiLocalModel || '(unset)'}" not pulled on the host (run \`ollama pull ${settings.aiLocalModel || '<model>'}\` there)\n` +
          `  • Wrong binary path in Settings → Local AI\n` +
          `Try in Terminal: \`${bin} ask --base-url ${settings.aiLocalBaseUrl || 'http://localhost:11434/v1'} --model ${settings.aiLocalModel || '<model>'} "hello"\` to see the real error.\n`;
        safeSend(IPC.AiStream, { streamId, chunk: msg, done: false });
        acc.append(msg);
      }
      resolve();
    });
  });
  safeSend(IPC.AiStream, { streamId, done: true, full: acc.value() });
  activeStreams.delete(streamId);
  conv.messages.push({ id: randomUUID(), role: 'assistant', text: acc.value(), createdAt: Date.now(), provider: 'opencode' });
  trimConversation(conv);
  await saveConversation(conv);
}

export function registerAiIpc() {
  ipcMain.handle(IPC.AiConversations, () => listConversations());
  ipcMain.handle(IPC.AiConversationGet, (_e, id: string) => loadConversation(id));
  ipcMain.handle(IPC.AiConversationDelete, async (_e, id: string) => {
    const p = convPath(id);
    if (p) { try { await fs.unlink(p); } catch {} }
    return true;
  });

  ipcMain.handle(IPC.AiSend, async (_e, args: {
    conversationId?: string;
    text: string;
    attachments?: ChatAttachment[];
    transport?: 'claude-sdk' | 'claude-cli' | 'openai-sdk' | 'codex-cli' | 'opencode-cli' | 'sdk' | 'cli';
    context?: IdeContext;
  }) => {
    let conv: Conversation | null = null;
    if (args.conversationId) {
      // Best effort. If the file is gone (deleted from another window,
      // workspace switch race, on-disk cleanup, …) fall through to a fresh
      // conversation rather than failing the send — the renderer picks up
      // the new id from the return value.
      conv = await loadConversation(args.conversationId);
      if (!conv) console.warn(`[ai:send] stale conversationId ${args.conversationId} — starting new conversation`);
    }
    if (!conv) {
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
    const transport: 'claude-sdk' | 'claude-cli' | 'openai-sdk' | 'codex-cli' | 'opencode-cli' =
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
      if (transport === 'opencode-cli') return () => streamViaOpenCodeCli(streamId, args.text, conv);
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
