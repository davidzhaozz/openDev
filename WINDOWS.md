# OpenDev on Windows

OpenDev was written on a Mac, and everything platform-specific it does — finding
an executable, opening a shell, listing who owns a port, killing a process tree,
splitting a path — assumed POSIX. This document is what changed to make it run
on Windows, and how to build and verify it **without owning a Windows machine**.

---

## Getting a build

Nothing here can be built usefully on macOS. `keytar` compiles to a Mach-O
binary and `@vscode/ripgrep` installs a per-platform `rg` — cross-packaging
from a Mac produces an installer that launches and then fails at the first
search or credential read. The Windows artifact has to be produced on Windows.

**GitHub Actions does that** — `.github/workflows/build.yml`:

| Job | Runner | What it does |
|---|---|---|
| `check` | `windows-latest` + `macos-latest` | typecheck, build both bundles, run the headless smoke |
| `windows-installer` | `windows-latest` | `npm run dist:win`, uploads the `.exe`s as an artifact |

The installer job runs on pushes to `develop`/`main` and on demand. To get a
build now:

```
gh workflow run build.yml            # or the "Run workflow" button on GitHub
gh run watch
gh run download --name OpenDev-IDE-windows
```

That produces `OpenDev IDE-<version>-x64.exe` (NSIS installer) and
`OpenDev IDE-<version>-x64-portable.exe` for machines where an installer can't
be run. The portable target needs its own `artifactName`: both default to
`${productName}-${version}-${arch}.${ext}`, and portable renders second, so
without it the portable build overwrites the installer and the job still
reports success with a single `.exe` in the artifact.

`npmRebuild` is off. node-pty 1.1 builds against node-addon-api and ships
`prebuilds/win32-x64`; keytar publishes its binaries with `prebuild -r napi`.
N-API is ABI-stable across Node and Electron, so both load under Electron as
npm installed them. `@electron/rebuild` doesn't recognise the prebuildify
layout and tries to compile node-pty from source anyway — the only thing in
this build that wants a C++ toolchain, and it fails on the runner with
"Could not find any Visual Studio installation to use". If a NAN-based native
is ever added, the rebuild has to come back on and the runner needs a working
MSVC.

The build is **unsigned**, so SmartScreen warns on first launch until it's
signed — set `CSC_LINK` and `CSC_KEY_PASSWORD` in the workflow environment with
an OV/EV code-signing certificate to fix that. There is also no `build/icon.ico`
yet, so the installer and taskbar show the default Electron icon — the same
situation as the macOS build, which has no `icon.icns` either.

## Verifying it without a Windows machine

`scripts/smoke-headless.mjs` runs the **real main process** — every module under
`src/main/` — on plain Node, using the headless server from `src/server/`. So a
Windows runner executing it is genuinely exercising the Windows branches, not a
re-implementation of them:

```
npm run web:build
node scripts/smoke-headless.mjs
```

It checks: workspace open, file list/read/write/delete, fuzzy search (ripgrep),
git status, **listening-port enumeration** (asserts it finds its own port),
**a live PTY** (writes `echo` and waits for the text to come back), Python
interpreter detection, built-in agents, project templates, and settings. That
covers the parts most likely to be platform-broken.

For anything interactive — how the frameless chrome actually feels, whether a
dev server starts — a throwaway Windows box is the only real answer. A
`t3.medium` Windows EC2 instance is about $0.06/hour; spin one up, RDP in,
install the artifact, terminate it when done.

---

## What changed

### One module for OS differences: `src/main/platform.ts`

Executable lookup, shell selection, process-tree killing and spawn options all
live there, so the rest of `src/main/` stays platform-blind.

**`resolveBinPath` now understands `PATHEXT`.** On Windows `npm`, `npx`, `tsx`,
`claude` and `codex` are all `.cmd` shims — a bare name matches nothing on disk.
It also searches the per-user npm prefix, Scoop shims, Chocolatey and
`Program Files\nodejs`.

**`spawnBin` routes `.cmd`/`.bat` through cmd.exe.** Since the Node 20 CVE fix,
`spawn()` refuses to execute a batch file without a shell (`EINVAL`), so every
call site that spawns a resolved CLI goes through this helper, which quotes each
argument — install paths contain spaces.

**Process trees.** POSIX puts a service's shell and children in a process group
and signals the group. Windows has no equivalent, and `detached: true` there
would open a console window per service — so the tree is walked with
`taskkill /T /F` instead.

### Ports: `netstat` instead of `lsof`

`netstat -ano` needs no elevation and exists on every Windows since XP;
`tasklist` supplies the process names that `lsof` gave for free. Services find
the ports they're holding by matching the listener table against their own
descendant PIDs (from a CIM parent-link walk) rather than a process group.

### Terminal

PowerShell 7 (`pwsh`) if installed, else Windows PowerShell, else `%COMSPEC%`.
node-pty drives ConPTY, which needs `conpty.dll`, `OpenConsole.exe` and
`winpty-agent.exe` unpacked from the asar — `electron-builder.yml` now unpacks
all of `node_modules/node-pty`.

### Paths: `src/shared/paths.ts`

The renderer has no `node:path`, so it had grown ~37 uses of `p.split('/')`,
each of which is wrong for `C:\Users\me\project`. They now go through shared
helpers (`baseName`, `dirName`, `isAbsolutePath`, `isWithin`, `shortenHome`)
that accept either separator. The main process uses the same helpers where a
path was being compared as a string — including `safeWithinRoot`, the check that
keeps file operations inside the workspace, which `root + '/'` could never
satisfy on Windows.

**File URIs** are the sharp edge: `file://${path}` yields `file://C:\Users\…`,
which no language server accepts. `pathToFileUri` / `fileUriToPath` produce and
parse `file:///C:/Users/…` and also read back vscode-uri's percent-encoded
`file:///c%3A/…` form.

### Window chrome

macOS insets its traffic lights over the custom titlebar. Windows and Linux get
a frameless window plus minimize/maximize/close buttons the renderer draws
(`src/renderer/src/components/WindowControls.tsx`), because `titleBarOverlay` —
the native alternative — can't be combined with a transparent window, and window
transparency is what the `--bg-alpha` slider in Settings controls.

There's no native application menu on a frameless window, so the four menu
accelerators (`Ctrl+,`, `Ctrl+O`, `Ctrl+Shift+N`, `Ctrl+Shift+W`) are bound in
the renderer instead. `⌘` in button hints becomes `Ctrl+`, and in Settings the
"⌘ + click" and "literal Control + click" chords collapse onto Ctrl+click, since
there is no Command key to distinguish them.

### Everything else

| Area | macOS | Windows |
|---|---|---|
| Tool installs | `brew install …` | `winget install --id …` (Node LTS, Maven, Temurin 17, .NET 8) |
| `which` | `/usr/bin/which` | `where` |
| PATH hydration | login shell `-ilc` | skipped; adds nodejs / npm prefix / Scoop / Chocolatey |
| Python detection | Homebrew, framework builds, pyenv, conda | `py -0p`, `…\Programs\Python*`, conda at the install root, `Scripts\python.exe` venvs (and Store alias stubs are skipped) |
| Memory | `vm_stat` (wired + active + compressed) | `total - free` |
| GPU | `system_profiler` incl. core counts | CIM adapter count |
| File descriptors | `/dev/fd` + `ulimit -Sn` | not applicable — the FD pill is hidden |
| DB LAN relay | `nc` relay for the Local Network prompt | not applicable; the netcat probe is skipped |

---

## Known gaps

- **Not signed.** SmartScreen will warn until a certificate is wired in.
- **No app icon.** `build/icon.ico` doesn't exist yet (nor does `icon.icns`).
- **Linux is untested.** The code now takes the "not macOS" branch everywhere,
  which is mostly right for Linux, but nothing has run there.
- **Windows-on-ARM** runs the x64 build under emulation; there's no arm64 target.
