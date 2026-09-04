# OpenDev Web

The same IDE, served to a browser. Point it at any machine you can reach — a
desktop upstairs, a workstation at the office, an EC2 box — and get the real
file tree, the real terminal, the real LSP, the real git and database panels,
running on *that* machine's filesystem.

```bash
npm run web          # build both bundles, start the server, open a browser
```

The URL it prints carries an access token:

```
  OpenDev Web 0.7.19
  http://127.0.0.1:5199/?token=6f2c…
```

The token is exchanged for an `HttpOnly` cookie on first load and dropped from
the URL, so it never lingers in the address bar or in a `Referer` header.

---

## How it works

The desktop app is three layers: an Electron **main** process, a **preload**
script that exposes `window.opendev`, and a React **renderer**. The web build
keeps all three — it only replaces the two Electron-specific ends.

```
  DESKTOP                                WEB
  ─────────────────────────────          ─────────────────────────────
  src/renderer/  React app        ←──→   src/renderer/  React app        (identical)
  src/preload/   contextBridge    ←──→   src/preload/   contextBridge    (identical)
       ↕ Electron IPC                         ↕ WebSocket  /rpc
  src/main/      main process     ←──→   src/main/      main process     (identical)
       ↕ electron module                      ↕ src/server/electron.ts
  Electron runtime                       Node + src/server/index.ts
```

**Server side** — `src/server/electron.ts` is a drop-in replacement for the
`electron` module. Between them the ~30 files in `src/main/` touch a small
slice of Electron: `ipcMain`, a few `app.getPath()` calls, two `dialog`
helpers, two `shell` helpers, and `BrowserWindow.getAllWindows()` (from
`safeSend`). The build aliases `electron` to the shim, so `fs.ts`, `git.ts`,
`db.ts`, `term.ts`, `lsp.ts` and the rest run under plain Node with **zero
forked copies to keep in sync**. `ipcMain.handle` registrations become a
dispatch table for WebSocket calls; `webContents.send` becomes a broadcast to
every connected tab — which is what `safeSend` already meant.

**Client side** — `src/web/electron.ts` does the same trick in reverse. It
implements `contextBridge` and `ipcRenderer` over the WebSocket, and the web
entry imports **the real `src/preload/index.ts`**. That's why there's no
hand-written copy of the ~250 methods on `window.opendev`: the preload file
stays the single definition of the API, and it can't drift.

---

## What's different in the browser

| | Desktop | Web |
|---|---|---|
| File / folder pickers | native `dialog` panel | remote picker that walks the **server's** disk (`src/web/picker.ts`) |
| Tab tear-off | new `BrowserWindow` | new browser window on the same URL, `?popout=…` |
| App menu | native macOS menu | the same accelerators bound in `src/web/overrides.ts` (⌘, ⌘O ⇧⌘N ⇧⌘W) |
| Browser panel | `<webview>` | an iframe upgraded in place (`src/web/webview.ts`) |
| Element picker ("Pick") | any page | same-origin pages only — an iframe can't be scripted across origins |
| Reveal in Finder | opens Finder | not available; the panel says so |
| Relaunch (Settings) | restarts the app | reloads the page |

Everything else — editor, LSP diagnostics and hover, fuzzy find, find-in-files,
git (status/diff/blame/worktrees), terminals, services, run configs, REST
client, SQL/Elasticsearch clients, AI chat and agents, Python/pip, MLX — runs
unchanged.

Multiple tabs can be open at once. They share one server, so they share one
workspace, one set of terminals, and one set of running services — the same
model as the desktop app's pop-out windows.

---

## Security

A browser tab that reaches this server gets a shell, the filesystem, and the
AI credentials of the account running it. Treat the URL like an SSH key.

- **Token required** on every HTTP request and on the WebSocket upgrade.
  It's generated on first run and stored `0600` at
  `~/Library/Application Support/openDev/web-token`.
- **Loopback by default.** `--host 0.0.0.0` is opt-in and prints a warning.
- **Origin is checked** on the WebSocket upgrade, so another site can't open a
  socket with your cookie.
- **No TLS of its own.** Off-machine, put it behind a VPN, an SSH tunnel, or a
  reverse proxy that terminates TLS:

  ```bash
  ssh -L 5199:127.0.0.1:5199 you@workstation   # then open the printed URL locally
  ```

---

## Commands

| Command | What it does |
|---|---|
| `npm run web` | build both bundles, start the server, open a browser |
| `npm run web:build` | build only (`out-web/server`, `out-web/renderer`) |
| `npm run web:server` | start the server against an existing build |
| `npm run web:dev` | Vite dev server on :5174 with HMR, proxying `/rpc` to the API server |

For `web:dev`, run `npm run web:server` in another shell first — Vite reads the
token file and proxies the socket to it.

### Flags and environment

| Flag | Env | Default |
|---|---|---|
| `--port 5199` | `OPENDEV_WEB_PORT` | `5199` |
| `--host 0.0.0.0` | `OPENDEV_WEB_HOST` | `127.0.0.1` |
| `--token <t>` | `OPENDEV_WEB_TOKEN` | generated, persisted |
| `--web-root <dir>` | `OPENDEV_WEB_ROOT` | `out-web/renderer` |
| `--open` | — | off |
| — | `OPENDEV_DATA_DIR` | shares the desktop app's data dir |
| — | `OPENDEV_MCP_PORT` | `53825` |

By default the web server reads and writes the **same** settings, recent
projects, and conversations as the desktop app. To run both at once, give the
web server its own `OPENDEV_DATA_DIR` and `OPENDEV_MCP_PORT`:

```bash
OPENDEV_DATA_DIR=~/.opendev-web OPENDEV_MCP_PORT=53826 npm run web
```

---

## Running it on a server

```bash
git clone <repo> && cd openDev
npm install
npm run web:build
OPENDEV_WEB_HOST=127.0.0.1 npm run web:server
```

Then tunnel in (`ssh -L 5199:127.0.0.1:5199 …`) or front it with nginx +
TLS + your own auth. The Node process needs the same things the desktop app
needs — `git`, a shell, and `node` on `PATH` — plus `node_modules`, since the
server bundle keeps its dependencies external.
