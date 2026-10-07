# openDev IDE

**An AI-first IDE for macOS and Windows — JavaScript, TypeScript, and Python.** Claude lives in the core, an embedded browser with an element picker turns "make this bigger" into a real patch, a built-in SQL client puts MySQL / Postgres / Elasticsearch alongside your code, and a Python toolchain (interpreter picker, pip manager, debugpy, plus MLX training on Apple Silicon) sits right next to it.

**One codebase, two native apps:**

| | macOS | Windows |
|---|---|---|
| Download | `OpenDev-IDE-<version>-mac-arm64.dmg` — signed + notarized | `OpenDev IDE-<version>-x64.exe` (installer) or `-portable.exe` |
| Runs on | Apple Silicon (M1 or later), macOS 13+ | Windows 10 / 11, x64 |
| Release | "openDev IDE X.Y.Z for Mac" | "OpenDev IDE X.Y.Z for Windows" |

Both come from the same commit and version on the [Releases](https://github.com/davidzhaozz/openDev/releases) page.

---

## Why use this

Most JS / TS developers reach for VS Code or WebStorm. Both work; both have specific pain points that this project addresses head-on:

- **AI is part of the IDE, not a sidecar.** openDev embeds the Anthropic SDK + Claude CLI directly, and every panel (files, editor, browser, DB, services) is also an MCP endpoint. The model can see and act on IDE state without going through plugin glue.
- **The picker → AI → preview loop is the product.** Open your dev server in the embedded browser, click an element, and the IDE captures its CSS path, computed styles, HTML, and a screenshot — all of which goes straight to Claude with your instruction. The change runs in a git worktree so you can accept or discard cleanly.
- **SQL lives next to your code.** Connection profiles for MySQL, Postgres, and Elasticsearch; schema browser; query editor with autocomplete; editable results grid.
- **Native on each OS.** Mac traffic lights, login-shell PATH and Keychain on macOS; ConPTY, a resident PowerShell host and Credential Manager on Windows.
- **Opinionated minimalism.** JetBrains-style density and chrome. Working defaults instead of a settings sprawl.

---

## Branches and releases

| Branch | Purpose |
|---|---|
| `develop` | day-to-day work for both platforms; merge feature branches here |
| `release` | what ships (default branch). Changes arrive only by pull request from `develop` — enforced by the `branch-guard` check and a repository ruleset |

- Platform differences live in code, not in branches: everything OS-specific is behind a platform check in `src/main/platform.ts`, `src/main/psHost.ts`, `src/main/windowChrome.ts` and `src/shared/paths.ts`.
- CI builds and smoke-tests **both** systems on every push, so a change that breaks one shows up immediately.
- **No cross-platform leakage:** each build drops the other platform's binaries (`mac.files` / `win.files` in `electron-builder.yml`), and `scripts/verify-mac-build.mjs` / `scripts/verify-win-build.mjs` fail the build if a Windows file reaches the Mac app or a Mac binary reaches the Windows installer.
- Tags are `vX.Y.Z`; one tag carries both downloads. (Before 0.8.22 the editions were released separately as `mac-v*` / `windows-v*`.)

---

## Platform notes

### How openDev uses macOS

| Area | What it uses on the Mac |
|---|---|
| **Window** | Native `hiddenInset` title bar with the traffic lights inset into the toolbar; translucent window (Settings → transparency); the standard macOS app menu (About / Settings ⌘, / Hide / Quit) |
| **Shell & PATH** | A Finder- or Dock-launched app gets a bare PATH, so at startup openDev runs your login shell (`$SHELL`, default `/bin/zsh`) with `-ilc` to capture the real one and adds `/opt/homebrew/bin` — `npm`, `node`, `python3`, `claude` and `git` resolve exactly as in Terminal. Terminal tabs open that same login shell |
| **Passwords** | Database passwords in the **macOS Keychain** (service `opendev-ide-db`, via `keytar`); browser-panel saved logins sealed with Electron `safeStorage` (Keychain-backed) |
| **Ports & processes** | `lsof` for listening sockets and their owners; services run in their own process group so stop kills the whole tree |
| **Python** | Homebrew (`/opt/homebrew`), Apple's system Python, python.org framework builds, pyenv, conda, and `.venv/bin/python` |
| **Apple Silicon** | arm64-only build. The ML panel and local-model server drive Apple's **MLX** (`mlx_lm.lora`, `mlx_lm.server`) |
| **Finder** | "Reveal in Finder" on files, checkpoints and adapters |
| **Storage** | Settings, conversations, services in `~/Library/Application Support/openDev/`; Electron data and logs in `~/Library/Application Support/OpenDev IDE/` and `~/Library/Logs/OpenDev IDE/`; recordings in `~/Movies/OpenDev/` |
| **Permissions** | macOS 15+ blocks LAN traffic unless an app declares it, so Info.plist carries `NSLocalNetworkUsageDescription` + Bonjour keys (databases on 192.168.x.x / 10.x.x.x work after one prompt); `NSMicrophoneUsageDescription` for narrated screen recordings |
| **Signing** | arm64 `.dmg` signed with a Developer ID under the **hardened runtime** and **notarized** by Apple; `build/entitlements.mac.plist` re-opens only what Electron/V8 need |

### Where openDev keeps things on Windows

Nothing is written to the registry or to `Program Files`; the installer is
per-user and no part of the app needs administrator rights.

| What | Where | How it's protected |
|---|---|---|
| App install | `%LOCALAPPDATA%\Programs\OpenDev IDE\` | per-user NSIS install; the portable `.exe` runs from anywhere |
| Settings (theme, recent workspaces, API keys, Jira site/token) | `%APPDATA%\openDev\settings.json` | plain JSON in your user profile — readable by anything running as you |
| AI conversations, service configs, tasks | `%APPDATA%\openDev\conversations\`, `services\`, `tasks\` | plain JSON, per workspace |
| Built-in agents, peer repos | `%APPDATA%\openDev\builtin-agents\`, `peer-repos\` | — |
| Window size / position | `%APPDATA%\openDev\window-state.json` | — |
| **Database passwords** | **Windows Credential Manager**, service `opendev-ide-db` (via `keytar`) | never written to a file; visible in *Control Panel → Credential Manager → Windows Credentials* |
| **Embedded-browser saved logins** | `%APPDATA%\openDev\logins.json` | each password sealed with **DPAPI** (Electron `safeStorage`), bound to your Windows account; if encryption is unavailable openDev refuses to save rather than store plaintext |
| Bearer tokens captured from the browser panel | memory only | never persisted |
| Chromium caches, local storage, MCP config | `%APPDATA%\OpenDev IDE\` (Electron `userData`), incl. `opendev-mcp.json` | — |
| Logs | `%APPDATA%\OpenDev IDE\logs\main.log` | — |
| Screen recordings | `%USERPROFILE%\Videos\OpenDev\` | — |
| Claude CLI login used by the built-in AI | `%USERPROFILE%\.claude\` | the Claude CLI's own credential store — see below |
| Code-signing key (developers only) | `%LOCALAPPDATA%\opendev-signing\` | deliberately outside the repo |

#### Which Claude account the built-in AI uses (Windows)

The built-in AI always uses the Claude CLI store in **`%USERPROFILE%\.claude`**,
resolved from your real Windows account rather than from `HOME` /
`CLAUDE_CONFIG_DIR`, so Git Bash, WSL or a PowerShell profile can't silently
swap the account. Sign in from **Settings → AI → Claude account**; that runs
`claude auth login` against the same store the chat uses.

Terminal tabs are the exception on purpose: a tab is *your* shell and keeps
whatever `CLAUDE_CONFIG_DIR` your profile sets. If your PowerShell profile
points Claude at a second account, guard it so it doesn't leak into the AI's
own shells:

```powershell
if (-not $env:OPENDEV_CLAUDE_CONFIG_PINNED) {
  $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-agent"
}
```

---

### How it does things on Windows

| Job | Windows mechanism |
|---|---|
| Finding `npm`, `npx`, `claude`, `codex`, … | `PATHEXT`-aware lookup across PATH, the npm prefix (`%APPDATA%\npm`), Scoop, Chocolatey and `Program Files\nodejs`; `.cmd` shims run through `%SystemRoot%\System32\cmd.exe /d` (never `%COMSPEC%`) |
| Terminal | `node-pty` over **ConPTY**; shell is PowerShell 7 (`pwsh`) if installed, else Windows PowerShell, else cmd. PSReadLine 2.1+ gives inline history suggestions |
| Process table | one resident `powershell.exe -File resources\procmap.ps1` answering over stdin, using `CreateToolhelp32Snapshot` (WMI fallback) — ~17 ms per read instead of a 2–3 s PowerShell spawn |
| Listening ports | `netstat -ano` + `tasklist` — no elevation needed |
| Stopping services | `taskkill /PID <pid> /T /F` walks the whole process tree |
| Find in files | bundled `rg.exe` (`@vscode/ripgrep`) |
| Installing tools (Node, Maven, JDK, .NET) | `winget install --id …` |
| Python interpreters | `py -0p`, `%LOCALAPPDATA%\Programs\Python\*`, conda, and `.venv\Scripts\python.exe`; Microsoft Store alias stubs are skipped |
| Paths | `src/shared/paths.ts` handles `\` and `/`, drive letters, and `file:///C:/…` URIs for the language servers |
| Window | frameless, opaque window with openDev's own menu bar and minimize / maximize / close buttons; Aero Snap and resize borders work |
| System stats | memory as `total - free`, GPU count via CIM |

Full rationale for each of these, and for the antivirus/EDR-friendly choices
(no `-EncodedCommand`, signed `procmap.ps1`), is in **[WINDOWS.md](WINDOWS.md)**.

---

## Features

**Editor & navigation**
- CodeMirror 6 with TypeScript, JavaScript, **Python**, HTML, CSS, JSON / JSONL, Markdown, SQL, **YAML** syntaxes
- TypeScript Language Server and **Pyright** (auto-routed by file extension): hover, go-to-definition, completions, diagnostics
- Project-wide fuzzy file finder; find-in-files powered by `ripgrep`
- Detects on-disk changes and offers to reload the editor
- Tab tear-off into popout windows

**AI**
- Anthropic SDK (default), Claude CLI, or OpenAI / Codex as the chat backend
- Streaming responses with cancellation; conversation history per workspace
- Per-turn IDE context block (open tabs, active file, selection)
- Attach selected code, files, images, or "picked" browser elements
- Built-in MCP server (HTTP) exposes IDE state to external Claude / Codex CLIs

**Embedded browser**
- Webview tab with back / forward / reload / address bar
- **Element picker** — captures CSS path, outer HTML, computed styles, and a screenshot, then routes it to Claude
- Device viewport presets with rotate
- Saved logins, sealed by the OS (Keychain on macOS, DPAPI on Windows)
- **Network panel** — one log of the browser panel's traffic (via DevTools Protocol, with bodies) and the IDE's own HTTP (REST, Jira, Elasticsearch, AI SDKs)
- Bearer tokens seen in the browser can be reused by REST requests

**Databases & REST**
- MySQL, Postgres, Elasticsearch / OpenSearch; schema tree; autocomplete from live schema
- Results grid with sort, copy as CSV / JSON / Markdown, safe parameterized inline edits
- Read-only connection mode for production
- Passwords in the macOS Keychain / Windows Credential Manager, never on disk
- REST workspace with saved requests

**Jira, diagrams, recording**
- Jira panel for your boards (site, email and API token in Settings)
- Mermaid workspace with live rendering
- Screen recorder saving `.webm` to `~/Movies/OpenDev` (macOS) or `Videos\OpenDev` (Windows)

**Python (opt-in per workspace)**
- Interpreter picker, **Create .venv**, Run / Debug configurations, `debugpy` debugger, pip package manager with `requirements.txt` support
- **MLX-LM training panel** and local-model server on Apple Silicon Macs (auto-detected from `lora_config.yaml`)

**Services & ports**
- Auto-detect runnable services from `apps/*/package.json` and `packages/*/package.json`
- Start / stop / restart with live output; stops kill the full process tree
- Port panel listing every listening TCP port and its owning process; one-click free

**Git**
- Status in the file tree, inline diff, stage / commit / push / pull / branch switch
- File history, blame, log, worktree management

**Terminal**
- `xterm.js` + `node-pty`, opens at project root — your login shell (zsh) on macOS, PowerShell over ConPTY on Windows
- Coalesced output batching so `cat huge.log` doesn't freeze the renderer

**Quality of life**
- Welcome screen with recent workspaces, per-workspace session restore
- Multiple themes (dark by default)
- Memory watchdog and hard caps on file reads, DB rows, subprocess output and AI streams

---

## Quickstart

### Requirements

**macOS:** Apple Silicon Mac, macOS 13+, Node.js 20+ (`brew install node`), Xcode Command Line Tools (`xcode-select --install`).

**Windows:** Windows 10/11 x64, Node.js 20+ (`winget install OpenJS.NodeJS.LTS`), Git for Windows. Recommended: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, so an updated PSReadLine doesn't hang terminal tabs on an "untrusted publisher" prompt.

**Both (optional):** `claude` CLI (CLI streaming path and **Settings → AI → Claude account**), `codex` CLI, Python 3.10+.

### Install & run from source

```bash
git clone git@github.com:davidzhaozz/openDev.git
cd openDev
npm install
npm run dev
```

`npm run dev` boots Electron with hot-reload.

### Build

Each app must be built **on its own OS** — `keytar`, `node-pty` and `@vscode/ripgrep` are per-platform natives.

#### macOS app

```bash
npm run dist        # bumps the version, builds dist/OpenDev IDE-<version>-arm64.dmg, then verifies it
```

Signed with the Developer ID in `electron-builder.yml`. `postdist` runs `scripts/verify-mac-build.mjs`: it fails on any Windows file in the app, any native module that isn't arm64 Mach-O, or if Keychain / terminal modules can't load (it does a real Keychain round-trip). Notarize the DMG before publishing:

```bash
codesign --sign "Developer ID Application: …" --timestamp dist/*.dmg
xcrun notarytool submit dist/*.dmg --keychain-profile <profile> --wait
xcrun stapler staple dist/*.dmg
```

#### Windows installer

Must be run **on Windows** — `keytar`, `node-pty` and `@vscode/ripgrep` are per-platform natives.

```powershell
. .\scripts\win-sign-env.ps1   # optional: sign with the dev cert. The leading dot is required.
npm run dist:win
```

Produces, in `dist\`:

- `OpenDev IDE-<version>-x64.exe` — per-user NSIS installer
- `OpenDev IDE-<version>-x64-portable.exe` — no install needed

`predist:win` bumps the version and validates `electron-builder.yml`;
`postdist:win` fails the build if signing was requested but an artifact came out
unsigned. First-time signing setup (`scripts\new-signing-cert.ps1`, no admin
needed) is described in [WINDOWS.md](WINDOWS.md#code-signing).

#### About the signature on published Windows builds

The `.exe` files published on GitHub Releases are signed with a **self-signed
development certificate only** (`CN=OpenDev IDE (Development)`), not a
certificate from a public authority. On your machine Windows does not trust
that certificate, so you will see **"Unknown publisher"** and a SmartScreen
*"Windows protected your PC"* warning — click **More info → Run anyway** to
install. The signature still guarantees the file hasn't been altered since it
was built.

**To get rid of the warning when running locally, create your own certificate,
self-sign, and rebuild locally:**

```powershell
# 1. Create your own code-signing cert (once; no admin needed).
#    Installs it into your CurrentUser Trusted Root + Trusted Publishers stores
#    and saves the .pfx + password in %LOCALAPPDATA%\opendev-signing\.
powershell -NoProfile -File scripts\new-signing-cert.ps1

# 2. Load it for this shell (the leading dot is required) and rebuild.
. .\scripts\win-sign-env.ps1
npm run dist:win

# 3. Install the freshly built, self-signed installer.
.\dist\"OpenDev IDE-<version>-x64.exe"
```

Because the certificate is now trusted on *your* machine, Windows shows your
certificate as the publisher and the signature validates. SmartScreen is
reputation-based and may still warn about a brand-new file; only a purchased
OV/EV certificate removes that for everyone.

CI (`.github/workflows/build.yml`) builds the same installer (unsigned) on a
`windows-latest` runner:

```powershell
gh workflow run build.yml
gh run watch
gh run download --name OpenDev-IDE-windows
```

### Smoke tests

```bash
npm run smoke:headless                              # real main process on plain Node: ports, PTY, git, ripgrep, Python
SMOKE_WORKSPACE=/path/to/project npm run smoke
```

#### Antivirus / EDR on Windows

An IDE enumerates processes, lists ports, kills process trees and spawns shells —
behaviour an EDR agent watches closely. On a managed machine, ask IT for a
**path exclusion covering child processes** for `%LOCALAPPDATA%\Programs\OpenDev IDE\`
(and your build tree), or one written against the signing certificate. Details
in [WINDOWS.md](WINDOWS.md#antivirus-and-edr).

---

## Configuration

Open **Settings** (⌘ , on macOS, `Ctrl+,` on Windows):

- **Anthropic API key** — for the default SDK chat path ([console.anthropic.com](https://console.anthropic.com)).
- **Claude account** — sign the built-in Claude CLI in or out (`~/.claude`).
- **Claude CLI path** — optional; defaults to `claude` on PATH.
- **OpenAI API key** + **Codex CLI path** — optional.
- **Jira** — site, email and API token for the Jira panel.
- **Slack** — talk to the IDE from a Slack DM (see below).
- **Themes & font sizes.**

These are saved to `settings.json` in openDev's folder (`~/Library/Application Support/openDev/` or `%APPDATA%\openDev\`) in plain text, so treat that file like any other credential file in your profile.

### MCP server for external Claude / Codex CLIs

The IDE runs an HTTP MCP server on `127.0.0.1:53825`. Add it to your CLI's MCP config:

```json
{
  "mcpServers": {
    "opendev-ide": { "type": "http", "url": "http://127.0.0.1:53825/" }
  }
}
```

Settings shows the exact snippet; it is also written to `opendev-mcp.json` in Electron's userData folder (`~/Library/Application Support/OpenDev IDE/` on macOS, `%APPDATA%\OpenDev IDE\` on Windows).

### Slack

DM a Slack bot and the message runs in the IDE chat, with the same tools as typing in the AI panel: files, terminal,
git, services, databases, REST, Jira and the editor. The reply comes back to the DM, with live progress while it works.
The IDE also DMs you when an AI run started in the IDE takes over a minute, a service stops with an error, or a Jira
ticket run finishes.

1. **Settings → Slack → Copy manifest**, then at [api.slack.com/apps](https://api.slack.com/apps) choose
   *Create New App → From a manifest*, pick your workspace, paste, and install the app.
2. Paste the app-level token (*Basic Information → App-Level Tokens*, scope `connections:write`, `xapp-…`), the bot
   token (*OAuth & Permissions*, `xoxb-…`) and your member ID (Slack profile → ⋯ → *Copy member ID*).
3. Turn on **Connect to Slack** and press **Send test message**.

It uses Socket Mode: the IDE connects out to Slack, so there is no public URL, tunnel or open port. The chat runs tools
without asking, so the bridge acts **only on messages from your member ID**; anything else is dropped unanswered.

In the DM, `help`, `status`, `stop`, `new`, `projects` and `project <n|name>` are commands (sent on their own);
everything else goes to Claude. Each thread is its own conversation, and Slack conversations show up in the IDE's chat
history like any other.

**Screenshots.** The chat can screenshot the IDE's browser panel (the `ide_browser_screenshot` tool — the tab in front,
or a URL it opens in a new tab; viewport or full page), so "show me localhost:3000/settings" in Slack comes back as an
image in the thread. Uploading needs the `files:write` bot scope, which the manifest includes; an app created before
it was added needs the scope added under *OAuth & Permissions* and a reinstall. Only images from the screenshot folder
or the open project can be attached.

**Reading your Slack and email.** The chat runs the Claude CLI signed in to your claude.ai account, so connectors you
connect at claude.ai (Settings → Connectors — e.g. Slack, Microsoft 365) are available to it, and through it to the Slack
bridge: "summarize #engineering since yesterday", "any unread email from Jane?". Connector tools that send, forward,
delete or change your calendar are blocked unless **Settings → AI → Connectors: send and delete** is on; reading,
searching and drafting always work.

### Database connections

Right side panel → **DB** → ➕. Each profile holds host, port, user, database and
optional read-only mode. The password goes to the macOS Keychain / Windows
Credential Manager under `opendev-ide-db`.

---

## Keyboard shortcuts

| macOS | Windows | Action |
|---|---|---|
| ⌘ O | `Ctrl+O` | Open project |
| ⌘ ⇧ N | `Ctrl+Shift+N` | New project |
| ⌘ ⇧ W | `Ctrl+Shift+W` | Close project |
| ⌘ , | `Ctrl+,` | Settings |
| ⌘ P | `Ctrl+P` | Fuzzy file finder |
| ⌘ ` | ``Ctrl+` `` | Terminal |
| ⌘ ⇧ F | `Ctrl+Shift+F` | Find in files |
| ⌘ S | `Ctrl+S` | Save current file |
| Esc | `Esc` | Close modal / cancel picker |

---

## Architecture (one paragraph)

Electron app: **main** process owns workspace state, subprocess management (TypeScript LSP, ripgrep, Claude CLI, `node-pty`, and on Windows the resident PowerShell process host), DB pools, and the MCP HTTP server. **Renderer** is React + Zustand, talks to main exclusively through Electron's `contextBridge`. **Webviews** isolate user content with `nodeIntegration: false`. Long-running data sources (PTY, AI streams, service logs, DB results) are capped and back-pressured at the main-process boundary. IPC channels are namespaced (`fs:read`, `ai:send`, `db:query`, …) and typed end-to-end via `src/shared/`. A **headless test server** (`src/headless/`) runs main verbatim on plain Node so CI's smoke test exercises the real code paths on both macOS and Windows. Everything OS-specific — executable lookup, shells, process trees, port enumeration, window chrome — is isolated in `src/main/platform.ts`, `src/main/psHost.ts` and `src/main/windowChrome.ts`, with path handling in `src/shared/paths.ts`; Windows detail in [WINDOWS.md](WINDOWS.md).

---

## Known gaps

- **Windows: self-signed dev certificate only.** Published Windows builds show "Unknown publisher" / SmartScreen warnings; create your own cert and rebuild locally to remove it on your machine (see [About the signature](#about-the-signature-on-published-builds)). An OV/EV certificate is the only fix for everyone.
- **No app icon** yet (`build/icon.ico`, `build/icon.icns`).
- **Windows: no arm64 build**; Windows-on-ARM runs x64 under emulation.
- **macOS: Apple Silicon only**; Intel Macs are not supported.
- **MLX-LM** training is Apple-Silicon-only.

---

## License

[MIT](LICENSE) © David Zhao &lt;david@situfamily.com&gt; · [davidzhao.net](https://davidzhao.net)
