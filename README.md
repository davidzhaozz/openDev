# openDev for Windows

> **This branch line (`windows-develop` / `windows-release`) is the Windows
> version of openDev only.** The macOS version lives on `mac-develop` /
> `mac-release` and is built, tested and released separately — see
> [Branches](#branches-macos-and-windows-are-separate-lines).

**An AI-first IDE for Windows 10/11 — JavaScript, TypeScript, and Python.** Claude lives in the core, an embedded browser with an element picker turns "make this bigger" into a real patch, a built-in SQL client puts MySQL / Postgres / Elasticsearch alongside your code, and a Python toolchain (interpreter picker, pip manager, debugpy) sits right next to it.

---

## Why use this

Most JS / TS developers reach for VS Code or WebStorm. Both work; both have specific pain points that this project addresses head-on:

- **AI is part of the IDE, not a sidecar.** openDev embeds the Anthropic SDK + Claude CLI directly, and every panel (files, editor, browser, DB, services) is also an MCP endpoint. The model can see and act on IDE state without going through plugin glue.
- **The picker → AI → preview loop is the product.** Open your dev server in the embedded browser, click an element, and the IDE captures its CSS path, computed styles, HTML, and a screenshot — all of which goes straight to Claude with your instruction. The change runs in a git worktree so you can accept or discard cleanly.
- **SQL lives next to your code.** Connection profiles for MySQL, Postgres, and Elasticsearch; schema browser; query editor with autocomplete; editable results grid.
- **Light on memory, fast to start.** Electron-based but kept lean, and tuned for Windows specifically: one resident PowerShell host instead of a process spawn per poll, opaque windows instead of DWM per-pixel alpha.
- **Opinionated minimalism.** JetBrains-style density and chrome. Working defaults instead of a settings sprawl.

---

## Branches: macOS and Windows are separate lines

openDev ships as **two versions, one per operating system**, and each has its own
development and release branch:

| Branch | Platform | Purpose |
|---|---|---|
| `windows-develop` | Windows | day-to-day Windows work; merge feature branches here |
| `windows-release` | Windows | what ships as the NSIS / portable `.exe`; only take tested commits from `windows-develop` |
| `mac-develop` | macOS | day-to-day macOS work |
| `mac-release` | macOS | what ships as the `.app` / `.dmg` |

They are kept apart on purpose. The two builds target different systems —
different shells, process and port handling, Keychain vs. Windows Credential
Manager / DPAPI, native modules built per platform, `.dmg` vs. `.exe`
packaging — and a change that is right for one can break the other.

- Start Windows work from `windows-develop` and merge back into it.
- Promote to `windows-release` only once the build has been installed and run on Windows.
- A fix that applies to both (shared code in `src/shared/`, the renderer, etc.)
  is committed to one `-develop` branch and cherry-picked into the other —
  don't merge `mac-*` and `windows-*` into each other wholesale.
- The Windows installer job in CI runs on `windows-develop`, `windows-release`
  and on demand.

---

## Where openDev keeps things on Windows

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

### Which Claude account the built-in AI uses

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

## How it does things on Windows

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
- Saved logins (DPAPI-sealed)
- **Network panel** — one log of the browser panel's traffic (via DevTools Protocol, with bodies) and the IDE's own HTTP (REST, Jira, Elasticsearch, AI SDKs)
- Bearer tokens seen in the browser can be reused by REST requests

**Databases & REST**
- MySQL, Postgres, Elasticsearch / OpenSearch; schema tree; autocomplete from live schema
- Results grid with sort, copy as CSV / JSON / Markdown, safe parameterized inline edits
- Read-only connection mode for production
- Passwords in Windows Credential Manager, never on disk
- REST workspace with saved requests

**Jira, diagrams, recording**
- Jira panel for your boards (site, email and API token in Settings)
- Mermaid workspace with live rendering
- Screen recorder saving `.webm` to `Videos\OpenDev`

**Python (opt-in per workspace)**
- Interpreter picker, **Create .venv**, Run / Debug configurations, `debugpy` debugger, pip package manager with `requirements.txt` support
- The MLX-LM training panel is Apple-Silicon-only and does nothing useful on Windows

**Services & ports**
- Auto-detect runnable services from `apps/*/package.json` and `packages/*/package.json`
- Start / stop / restart with live output; stops kill the full process tree
- Port panel listing every listening TCP port and its owning process; one-click free

**Git**
- Status in the file tree, inline diff, stage / commit / push / pull / branch switch
- File history, blame, log, worktree management

**Terminal**
- `xterm.js` + `node-pty` (ConPTY), PowerShell by default, opens at project root
- Coalesced output batching so `Get-Content huge.log` doesn't freeze the renderer

**Quality of life**
- Welcome screen with recent workspaces, per-workspace session restore
- Multiple themes (dark by default)
- Memory watchdog and hard caps on file reads, DB rows, subprocess output and AI streams

---

## Quickstart

### Requirements

- Windows 10 or 11, x64 (Windows-on-ARM runs the x64 build under emulation)
- Node.js 20+ and npm (`winget install OpenJS.NodeJS.LTS`)
- Git for Windows
- (Optional) `claude` CLI for the CLI streaming path and **Settings → AI → Claude account**
- (Optional) `codex` CLI for OpenAI / Codex
- (Optional) Python 3.10+ via the `py` launcher or a workspace `.venv\`
- (Recommended) `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, so an updated PSReadLine doesn't hang terminal tabs on an "untrusted publisher" prompt

### Install & run from source

```powershell
git clone git@github.com:davidzhaozz/openDev.git
cd openDev
git switch windows-develop
npm install
npm run dev
```

`npm run dev` boots Electron with hot-reload.

### Build the installer

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

### About the signature on published builds

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

CI (`.github/workflows/build.yml`) builds the same installer on a
`windows-latest` runner:

```powershell
gh workflow run build.yml
gh run watch
gh run download --name OpenDev-IDE-windows
```

### Smoke tests

```powershell
npm run smoke:headless                                  # real main process on plain Node: ports, PTY, git, ripgrep, Python
$env:SMOKE_WORKSPACE = "C:\path\to\project"; npm run smoke
```

### Antivirus / EDR

An IDE enumerates processes, lists ports, kills process trees and spawns shells —
behaviour an EDR agent watches closely. On a managed machine, ask IT for a
**path exclusion covering child processes** for `%LOCALAPPDATA%\Programs\OpenDev IDE\`
(and your build tree), or one written against the signing certificate. Details
in [WINDOWS.md](WINDOWS.md#antivirus-and-edr).

---

## Configuration

Open **Settings** (`Ctrl+,` or *File → Settings…*):

- **Anthropic API key** — for the default SDK chat path ([console.anthropic.com](https://console.anthropic.com)).
- **Claude account** — sign the built-in Claude CLI in or out (`%USERPROFILE%\.claude`).
- **Claude CLI path** — optional; defaults to `claude` on PATH (the npm `.cmd` shim is found automatically).
- **OpenAI API key** + **Codex CLI path** — optional.
- **Jira** — site, email and API token for the Jira panel.
- **Themes & font sizes.**

These are saved to `%APPDATA%\openDev\settings.json` in plain text, so treat
that file like any other credential file in your profile.

### MCP server for external Claude / Codex CLIs

The IDE runs an HTTP MCP server on `127.0.0.1:53825`. Add it to your CLI's MCP config:

```json
{
  "mcpServers": {
    "opendev-ide": { "type": "http", "url": "http://127.0.0.1:53825/" }
  }
}
```

Settings shows the exact snippet; it is also written to `%APPDATA%\OpenDev IDE\opendev-mcp.json`.

### Database connections

Right side panel → **DB** → ➕. Each profile holds host, port, user, database and
optional read-only mode. The password goes to Windows Credential Manager under
`opendev-ide-db`.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open project |
| `Ctrl+Shift+N` | New project |
| `Ctrl+Shift+W` | Close project |
| `Ctrl+,` | Settings |
| `Ctrl+P` | Fuzzy file finder |
| ``Ctrl+` `` | Terminal |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+S` | Save current file |
| `Esc` | Close modal / cancel picker |

---

## Architecture (one paragraph)

Electron app: **main** process owns workspace state, subprocess management (TypeScript LSP, ripgrep, Claude CLI, `node-pty`/ConPTY, the resident PowerShell process host), DB pools, and the MCP HTTP server. **Renderer** is React + Zustand, talks to main exclusively through Electron's `contextBridge`. **Webviews** isolate user content with `nodeIntegration: false`. Long-running data sources (PTY, AI streams, service logs, DB results) are capped and back-pressured at the main-process boundary. IPC channels are namespaced (`fs:read`, `ai:send`, `db:query`, …) and typed end-to-end via `src/shared/`. A **headless test server** (`src/headless/`) runs main verbatim on plain Node so CI's smoke test exercises the real Windows code paths. Everything OS-specific — executable lookup, shells, process trees, port enumeration — is isolated in `src/main/platform.ts` and `src/main/psHost.ts`, with path handling in `src/shared/paths.ts`; see [WINDOWS.md](WINDOWS.md).

---

## Known gaps

- **Self-signed dev certificate only.** Published builds show "Unknown publisher" / SmartScreen warnings; create your own cert and rebuild locally to remove it on your machine (see [About the signature](#about-the-signature-on-published-builds)). An OV/EV certificate is the only fix for everyone.
- **No app icon** yet (`build/icon.ico`).
- **No arm64 build**; Windows-on-ARM runs x64 under emulation.
- **MLX-LM** training is macOS-only.

---

## License

[MIT](LICENSE) © David Zhao &lt;david@situfamily.com&gt; · [davidzhao.net](https://davidzhao.net)
