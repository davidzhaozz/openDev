# openDev

**An AI-first JavaScript & TypeScript IDE for macOS.** Claude lives in the core, an embedded browser with an element picker turns "make this bigger" into a real patch, and a built-in SQL client puts MySQL / Postgres / Elasticsearch alongside your code.

---

## Why use this

Most JS / TS developers reach for VS Code or WebStorm. Both work; both have specific pain points that this project addresses head-on:

- **AI is part of the IDE, not a sidecar.** Other AI plugins shell out to Claude as a subprocess and pipe text back and forth. openDev embeds the Anthropic SDK + Claude CLI directly, and every panel (files, editor, browser, DB, services) is also an MCP endpoint. The model can see and act on IDE state without going through plugin glue.
- **The picker → AI → preview loop is the product.** Open your dev server in the embedded browser, click an element, and the IDE captures its CSS path, computed styles, HTML, and a screenshot — all of which goes straight to Claude with your instruction. The change runs in a git worktree so you can accept or discard cleanly.
- **SQL lives next to your code.** Connection profiles for MySQL, Postgres, and Elasticsearch; schema browser; query editor with autocomplete; editable results grid. No DataGrip, no TablePlus, no context switch.
- **Light on memory, fast to start.** Electron-based but kept lean. No language-server farm for ten languages you don't use, no plugin marketplace indexing in the background, no thousand-option preferences dialog.
- **Opinionated minimalism.** JetBrains-style density and chrome. Working defaults instead of a settings sprawl. JavaScript and TypeScript only.

If you live in JS / TS, use Claude for coding, and want one app for code + AI + databases + dev-server preview — that's the wedge.

---

## Features

**Editor & navigation**
- CodeMirror 6 with TypeScript, JavaScript, HTML, CSS, JSON, Markdown, SQL syntaxes
- TypeScript Language Server: hover, go-to-definition, completions, diagnostics
- Project-wide fuzzy file finder
- Find-in-files powered by `ripgrep`
- Tab tear-off into popout windows

**AI**
- Anthropic SDK (default), Claude CLI, or OpenAI / Codex as the chat backend
- Streaming responses with cancellation
- Conversation history persisted per-workspace
- Per-turn IDE context block (open tabs, active file, selection)
- Attach selected code, files, images, or "picked" browser elements
- Built-in MCP server (HTTP) exposes IDE state — point your external Claude / Codex CLI at it and the model can read files, list services, run shell commands, etc.

**Embedded browser**
- Webview tab pointed at any URL, with back / forward / reload / address bar
- **Element picker** — click anything in your dev server and the IDE captures CSS path, outer HTML, computed styles, and a screenshot, then routes it to Claude
- **Device viewport presets** — Desktop, Laptop, iPad Pro / iPad, iPhone 14 Pro Max / Pro / SE, Pixel 7, Galaxy S8+, with rotate

**Databases**
- MySQL, Postgres, Elasticsearch / OpenSearch
- Schema tree (databases → tables → columns / keys)
- Query editor with table & column autocomplete from live schema
- Results grid with sort, copy as CSV / JSON / Markdown, and inline cell editing that builds safe parameterized `UPDATE` statements
- Read-only connection mode for production
- Passwords stored in macOS Keychain via `keytar`, never on disk

**Services & ports**
- Auto-detect runnable services from `apps/*/package.json` and `packages/*/package.json`
- Start / stop / restart with live stdout / stderr capture
- Port panel that lists every listening TCP port + the process bound to it; one-click free
- Auto-recovery on `EADDRINUSE`

**Git**
- Status in the file tree gutter (modified, added, untracked)
- Inline diff in the editor
- Stage, unstage, commit, push, pull, branch switch
- File history, blame, log
- Worktree management

**Terminal**
- `xterm.js` + `node-pty`, full color, real shell
- One terminal pane per workspace; opens at project root
- Coalesced output batching so `cat huge.log` doesn't freeze the renderer

**Quality of life**
- Welcome screen with recent workspaces
- Per-workspace session restore (tabs, cursor, panels)
- Multiple themes (dark by default)
- Memory watchdog — warns before the app gets close to OOM territory
- Hard caps on file read size, DB row count, subprocess output, and AI streams so a runaway producer can't crash the IDE

---

## Quickstart

### Requirements

- macOS 13+ (Apple Silicon recommended; Intel works)
- Node.js 20+ and npm
- (Optional) `claude` CLI from Anthropic if you want the CLI streaming path
- (Optional) `codex` CLI if you want OpenAI / Codex streaming

### Install & run

```bash
git clone https://github.com/<your-fork>/openDev.git
cd openDev
npm install
npm run dev
```

`npm run dev` boots Electron with hot-reload — edit the source and the renderer reloads instantly.

### Build a packaged app

```bash
npm run dist           # produces dist/mac-arm64/openDev.app + .dmg
npm run dist:dir       # unpacked .app only (faster, for testing)
```

The build is unsigned by default. To ship it to other machines you'll want to set up an Apple Developer ID; see `electron-builder.yml` for the entitlements and notarization knobs.

### Smoke test

```bash
SMOKE_WORKSPACE=/path/to/some/project npm run smoke
```

Runs the load-bearing IDE mechanics (file walk, service detect, ripgrep, git worktree round-trip, port detection) against a real workspace without launching the UI. Good for verifying a build works against your codebase.

---

## Configuration

Open **Settings** (⌘ , or *File → Settings…*). Most things have working defaults; the ones that need a value from you:

- **Anthropic API key** — required for the default AI chat path. Get one at [console.anthropic.com](https://console.anthropic.com).
- **Claude CLI path** — optional, defaults to `claude` on PATH. Set this if you'd rather use the CLI than the SDK.
- **OpenAI API key** + **Codex CLI path** — optional, only if you want the OpenAI / Codex chat backend.
- **Themes & font sizes** — pick your theme, set UI / editor font sizes, panel transparency.

API keys are persisted to `~/Library/Application Support/openDev/settings.json`. They never leave your machine.

### MCP server for external Claude / Codex CLIs

The IDE runs an HTTP MCP server on `127.0.0.1:53825`. To let your external `claude` or `codex` CLI see IDE state (open files, services, workspace tree), add this to your CLI's MCP config:

```json
{
  "mcpServers": {
    "opendev-ide": { "type": "http", "url": "http://127.0.0.1:53825/" }
  }
}
```

Settings shows the exact snippet with the current URL.

### Database connections

Right side panel → **DB** → ➕. Each profile holds host, port, user, database, and (optionally) `read-only` mode. Passwords are stored in macOS Keychain — never written to a config file.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘ O | Open project |
| ⌘ ⇧ W | Close project |
| ⌘ , | Settings |
| ⌘ P | Fuzzy file finder |
| ⌘ ⇧ F | Find in files |
| ⌘ S | Save current file |
| ⌘ W | Close current tab |
| Esc | Close modal / cancel picker |

---

## Architecture (one paragraph)

Electron app: **main** process owns workspace state, subprocess management (TypeScript LSP, ripgrep, Claude CLI, `node-pty`), DB pools, and the MCP HTTP server. **Renderer** is React + Zustand, talks to main exclusively through Electron's `contextBridge`. **Webviews** isolate user content (dev servers, embedded HTTP UIs) with `nodeIntegration: false`. Long-running data sources (PTY, AI streams, service logs, DB results) are all capped and back-pressured at the main-process boundary so the renderer can't be drowned. IPC channels are namespaced (`fs:read`, `ai:send`, `db:query`, etc.) and typed end-to-end via `src/shared/`.

---

## Roadmap

The current focus is hardening the things that already exist — packaging, memory limits, polish. Likely directions from here:

- Windows / Linux support
- Light theme
- More device viewport presets + UA spoofing
- Per-workspace MCP tool allowlists
- Auto-updater channel for signed builds

PRs and issues welcome. Especially welcome: bug reports with a workspace shape that breaks something.

---

## License

[MIT](LICENSE) © David Zhao
