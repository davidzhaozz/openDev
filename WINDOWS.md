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

The installer job runs on pushes to `windows-develop`/`windows-release` and on
demand. Windows work lives on those two branches; macOS has its own
`mac-develop`/`mac-release` (see the README's *Branches* section). To get a
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

Signing is covered in its own section below. There is no `build/icon.ico` yet,
so the installer and taskbar show the default Electron icon — the same
situation as the macOS build, which has no `icon.icns` either.

## Code signing

Signing is driven entirely by the environment. electron-builder signs the
Windows binaries whenever `CSC_LINK` (a path to a `.pfx`) and
`CSC_KEY_PASSWORD` are set, and produces unsigned output when they are not —
nothing in `electron-builder.yml` names a certificate, so moving between a
local development certificate and a purchased one is a matter of pointing those
two variables somewhere else.

```powershell
. .\scripts\win-sign-env.ps1      # the leading dot is load-bearing
npm run dist:win
```

**`win-sign-env.ps1` must be dot-sourced.** Run as `.\scripts\win-sign-env.ps1`
it sets the variables in a child shell that exits immediately; electron-builder
then signs nothing, the build succeeds with no error, and you ship an unsigned
build believing it is signed. `postdist:win` exists to catch exactly that (see
below).

### The development certificate

`scripts\new-signing-cert.ps1` creates a self-signed code-signing certificate
once and installs it into `CurrentUser\Root` and `CurrentUser\TrustedPublisher`.
Every store it touches is CurrentUser, so **no administrator rights are
required**. The `.pfx` and its password land in
`%LOCALAPPDATA%\opendev-signing\`, deliberately outside the repository so no
`.gitignore` rule has to be trusted to keep a private key out of git.

Be clear about what a self-signed certificate does and does not buy:

- It **does** give every build a stable signer identity. Without one, each
  `npm run dist:win` produces a brand-new unknown binary, and an EDR exclusion
  can only be written against a hash that is stale by the next build. With one,
  the exclusion can name the certificate instead.
- It **does not** satisfy SmartScreen, which is reputation-based and ignores
  self-signed certificates entirely. Only a purchased OV/EV certificate quiets
  that warning.
- It **does not** by itself make a managed EDR trust the app. The certificate is
  the thing an exclusion can be written against; it is not the exclusion.

### What gets signed

electron-builder signs the app binary, the installer, the portable build, the
uninstaller, and the bundled third-party executables it finds in the package —
`OpenConsole.exe`, `winpty-agent.exe` and `rg.exe`, all of which previously
shipped unsigned and are spawned from a user-writable directory.

It has no notion of signing a PowerShell script, so `resources\procmap.ps1` is
signed by the `afterPack` hook in `scripts\sign-ps1.mjs`, with the same
certificate. That script is run with `-File` by the process-table host, and
signing it means it also satisfies an `AllSigned` execution policy and survives
a Mark-of-the-Web on the installed copy.

### Build guards

`npm run dist:win` is wrapped by two npm lifecycle scripts, because both of the
ways this has broken were silent:

| Hook | Script | Catches |
|---|---|---|
| `predist:win` | `bump-version.mjs`, `check-builder-config.mjs` | a version collision with the installed build; malformed `electron-builder.yml`; a dropped `extraResources` or `afterPack` key |
| `postdist:win` | `verify-win-build.mjs` | an artifact missing, or unsigned when `CSC_LINK` was set |

The version bump matters more than it looks. `predist` only ever ran for the
macOS `dist` target, so `dist:win` rebuilt the *same* version number on top of
itself — the installed app and a freshly signed build both claimed 0.8.0 with
no way to tell them apart and no version delta for the installer to act on.

`verify-win-build.mjs` fails the build if signing was requested and any artifact
is not validly signed. If `CSC_LINK` is unset it warns loudly and passes: an
unsigned build is a legitimate thing to want, just never by accident.

## Antivirus and EDR

An IDE's normal work — enumerating processes, listing listening ports, killing
process trees, running shells through a PTY — is behaviourally close to what
recon and loader malware does, so an EDR agent will have opinions. What matters
is not tripping the *avoidable* indicators.

The one that mattered was `powershell.exe -EncodedCommand <base64>`. The
resident process-table host in `src/main/psHost.ts` used to inline its script
and pass it base64-encoded, which is close to a canonical obfuscated-execution
indicator and, at a 4-second poll, looked like something re-arming itself
continuously. The script now ships as a readable file, `resources\procmap.ps1`,
and is run with `-File`.

The two other ways to avoid base64 are both worse and were rejected:

- **`-Command -`, with the script on stdin.** stdin is already the query channel
  the host reads with `[Console]::In.ReadLine()`, and `-Command -` makes
  PowerShell consume that same stream as its script text.
- **The script in an environment variable, evaluated with `Invoke-Expression`.**
  Works, and is as far as any EDR is concerned exactly as suspicious as the
  base64 it replaces.

`extraResources` places the script directly in `<resourcesPath>` rather than
inside the asar, because PowerShell cannot open a `-File` path inside an
archive. `src/main/psHost.ts` resolves it there when packaged and two levels up
from `out/main` in development.

What remains visible to an EDR is inherent to the product and should be handled
with an exclusion rather than a code change: process-table reads via
`CreateToolhelp32Snapshot`, `netstat -ano` and `tasklist` for the ports panel,
`taskkill /T /F` for stopping services, and ConPTY spawning shells. On a
corporate-managed agent, ask for a **path** exclusion covering both the install
directory and the build tree, in a mode that also covers **child processes** —
most of the detections come from what the IDE spawns, not from the IDE binary,
so a parent-only exclusion leaves them in place.

## Verifying it without a Windows machine

`scripts/smoke-headless.mjs` runs the **real main process** — every module under
`src/main/` — on plain Node, using the headless test server from `src/headless/`. So a
Windows runner executing it is genuinely exercising the Windows branches, not a
re-implementation of them:

```
npm run smoke:headless
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

**...and that cmd.exe is located from `%SystemRoot%`, not `%COMSPEC%`.** See
the credential section below: `shell: true` takes the shell from `COMSPEC`, and
a `COMSPEC` pointing at PowerShell turns every shell-routed spawn into
`powershell -c "<command>"`, profile and all. `systemCmdExe()` pins
`System32\cmd.exe`, which also keeps Node on the `/d /s /c` argument path —
`/d` is what suppresses cmd.exe's own `AutoRun` hook.

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

**History type-ahead.** The dim inline suggestion that zsh-autosuggestions
gives you on macOS is PSReadLine's `PredictionSource` on Windows, and
`terminalShell()` turns it on by passing `-NoExit -Command` with a short init
line. Two things make that init safe to run unconditionally:

- `PredictionSource` doesn't exist before **PSReadLine 2.1**, where it reads
  back as null. Comparing null against `'None'` is false, so an older shell
  skips the call rather than printing a parameter-binding error into the pane.
  That in-band check is deliberate — probing the version in a separate process
  would cost seconds on a machine whose EDR agent inspects process creation,
  the same reason `processParentMap` caches.
- Any value other than `None` means the user's profile already chose a mode, so
  we leave it alone. pwsh 7.2+ defaults to `HistoryAndPlugin` and falls through
  untouched.

Windows PowerShell 5.1 ships PSReadLine **2.0**, which predates the feature, so
a stock box gets no suggestions until `Install-Module PSReadLine -Scope
CurrentUser` puts a 2.1+ copy ahead of the one in `Program Files`.

That install has a trap worth knowing about. The default execution policy on
Windows client is `Restricted`, and under it the module's signed
`PSReadLine.format.ps1xml` raises an *"untrusted publisher"* console prompt on
every shell start — which in a PTY pane is unanswerable, so the terminal just
hangs at the prompt. The fix belongs to the machine, not the app:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (no admin needed).
openDev deliberately does **not** pass `-ExecutionPolicy` itself; silently
loosening a user's script policy isn't the IDE's call, and VS Code doesn't do
it either.

History persistence needs nothing from us — PSReadLine saves incrementally to
`ConsoleHost_history.txt` as each line is accepted, so a tab closed with its
PTY killed underneath still keeps what was typed in it. Note that a running
tab won't pick up commands from a sibling tab until it restarts; there's no
equivalent of zsh's `share_history`.

### Which Claude account the built-in AI uses

Everything openDev spawns on the user's behalf gets its environment from
`cliChildEnv()`, and the AI paths — chat (`ai.ts`), Jira runs (`jira.ts`),
agents (`agents.ts`, `peers.ts`) and the AI's own shell tool (`mcp.ts`) — all
go through it. Three things there decide which credential store the Claude CLI
opens:

- **`CLAUDE_CONFIG_DIR` is pinned to `<real home>\.claude`**, not merely
  deleted. Deleting it makes the CLI fall back to `~/.claude`, which is only
  the same answer as long as nothing downstream re-derives `~` or re-sets the
  variable.
- **`HOME` / `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH` are pinned to
  `realHome()`**, which reads the account database (`os.userInfo()`) rather
  than the environment. `os.homedir()` would just echo whatever
  `%USERPROFILE%` was inherited — and Git Bash, WSL interop and roaming
  profiles all set a different `HOME`.
- **Names are matched case-insensitively.** Windows environment blocks are, so
  `$env:claude_config_dir` set in a profile arrives here as a lowercase key
  and would sail past an `===` check while the child still reads it as
  `CLAUDE_CONFIG_DIR`.

**The one case the app cannot close by itself.** A PowerShell profile runs on
every non-`-NoProfile` invocation, *after* we hand over the environment, so a
profile line like

```powershell
$env:CLAUDE_CONFIG_DIR = "C:\Users\me\.claude-agent"
```

re-injects a second account into any PowerShell the AI happens to spawn for
itself. No parent-side scrubbing can reach that; the assignment has to guard
itself. Every AI child therefore carries `OPENDEV_CLAUDE_CONFIG_PINNED=1`
(`CLAUDE_CONFIG_PIN_MARKER`), so a profile that wants a different account for
*interactive* use can say so:

```powershell
if (-not $env:OPENDEV_CLAUDE_CONFIG_PINNED) {
  $env:CLAUDE_CONFIG_DIR = "C:\Users\me\.claude-agent"
}
```

Terminal tabs are deliberately excluded — `ptyEnv()` strips the marker back
off. A tab *is* the user's shell, and a profile pointing it at a second
account is exactly the sort of thing that should still take effect there.

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

- **Signed, but only self-signed.** Builds carry a stable signer identity (see
  [Code signing](#code-signing)), which is enough for an EDR exclusion to be
  written against the certificate. SmartScreen is reputation-based and will keep
  warning until an OV/EV certificate is purchased and `CSC_LINK` points at it.
- **No app icon.** `build/icon.ico` doesn't exist yet (nor does `icon.icns`).
- **Linux is untested.** The code now takes the "not macOS" branch everywhere,
  which is mostly right for Linux, but nothing has run there.
- **Windows-on-ARM** runs the x64 build under emulation; there's no arm64 target.
