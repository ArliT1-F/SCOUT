# SCOUT — Windows installer

Builds **`SCOUT-Setup-<version>.exe`**, a single wizard that installs the whole of SCOUT on an
observer's Windows machine: the Node host (with its own bundled runtime, so the machine needs no
Node.js and no npm), the built control panel and overlay pages, the CS2 Game State Integration
config, the transparent overlay shell, and the shortcuts to run them.

Nothing here changes how SCOUT runs from a checkout: `npm run dev` is still `tsx server/index.ts`
against the repository, and the shell is still built by `npm run shell:build`.

## Build it

Prerequisites, all on the machine that builds (not on the machine that runs SCOUT):

| | |
| --- | --- |
| **Node.js 20+** | builds the panel and the host; ships as the bundled runtime too |
| **Rust + `cargo install tauri-cli --version "^2"`** | builds `scout-shell.exe` (skip with `--no-shell`) |
| **[Inno Setup 6.3+](https://jrsoftware.org/isdl.php)** | packs the wizard (`ISCC.exe`) |
| Internet | to fetch the Node runtime and the WebView2 bootstrapper, both verified/skipped cleanly if absent |

```powershell
npm run package:windows
# = node scripts/build-installer.mjs

node scripts/build-installer.mjs --help
node scripts/build-installer.mjs --no-shell            # no overlay shell in the installer
node scripts/build-installer.mjs --runtime-zip C:\node-v22.20.0-win-x64.zip   # offline runtime
node scripts/build-installer.mjs --no-installer --no-shell   # just stage and smoke-test the tree
```

The script refuses to build something that would not run: it compiles the host, installs the host's
production dependencies into a staging directory, **starts that staged host** and checks that the
panel, the OBS page and a GSI push all answer, and only then calls Inno Setup. Every failure names
the command that failed.

Output: `dist-installer\SCOUT-Setup-<version>.exe`.

### What the script stages

```
dist-stage\
├─ host\            the program files: server\ (compiled JS), dist\ (the panel plus the radar
│                   overviews, scene thumbnails and icons vite copies from public\), config\,
│                   node_modules\ (express, ws, zod and their dependencies), scout-shell.exe,
│                   scout.ico, package.json ({"type":"module"})
├─ runtime\node.exe Node runtime, checksum-verified against nodejs.org's SHASUMS256.txt
├─ launcher\        scout-host.cmd, scout-stop.cmd, OPERATOR-NOTES.txt
├─ redist\          MicrosoftEdgeWebview2Setup.exe (optional; the wizard skips it if absent)
└─ docs\            README.md, this file, src-tauri\README.md
```

## What the wizard does

| Page | Asks |
| --- | --- |
| Tasks | Desktop shortcut · install the CS2 GSI config · allow the panel/OBS/GSI from another machine (firewall rule) · install WebView2 if missing (only offered when it *is* missing) |
| Host settings | Port (default 8080), GSI token (generated, editable), panel token. A port that is already taken only raises a warning; a token under 8 characters is replaced and shown |
| Counter-Strike 2 | The CS2 `cfg` folder — auto-detected from the registry and every Steam library in `libraryfolders.vdf`, overridable with Browse. Skipped when the GSI task is unticked. A folder that does not exist or cannot be written is reported rather than failing the install |
| Finish | Start the host now · open the control panel |

At install time it also writes `port.txt`, `gsi_token.txt`, `app-root.txt`, `remote.txt`
(`panel_token.txt` when remote access is on) into the data directory, generates
`gamestate_integration_overlay.cfg` from `config\gamestate_integration_overlay.cfg` with the chosen
port and token, and adds the firewall rule if that task is ticked.

## Where things land

| | |
| --- | --- |
| Program files | `%LOCALAPPDATA%\Programs\SCOUT` (per-user default; "install for all users" puts it under `C:\Program Files`) |
| Data directory | `%APPDATA%\SCOUT` — `config\`, `public\uploads\`, `public\radars\`, `public\thumbs\`, `recordings\`, the launcher and the token/port files. It belongs to the account that ran the installer, so on a shared machine install it while logged in as the operator (the default, per-user install, always does) |
| CS2 config | `<Steam>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_overlay.cfg` (legacy `csgo\cfg` is detected too) |
| Shortcuts | Start menu: SCOUT host · SCOUT control panel · SCOUT overlay shell · Stop the SCOUT host; desktop: SCOUT host (optional) |
| Firewall rule | `SCOUT host` — inbound TCP on the chosen port, scoped to `…\SCOUT\runtime\node.exe`, all profiles |

The split between program files and data directory is deliberate: `C:\Program Files` is not
writable, and `config/`, `public/uploads/` and `recordings/` change constantly. The host reads only
its built panel (`dist/`) from the program files — `SCOUT_APP_ROOT`, see `server/runtime.ts` — and
writes everything relative to its working directory, which the launcher sets to the data directory.
That is also why an update can replace every program file without touching match data.

Two install-time details that matter:

- The files written for the launcher and CS2 are **plain ASCII with CRLF and no byte order mark**
  (`SaveStringsToFile`). A UTF-8 BOM would make CS2's KeyValues parser ignore the GSI config.
- The firewall rule is added with `netsh advfirewall firewall add rule … program="…\node.exe"
  protocol=TCP localport=<port> profile=any`. It is removed by the uninstaller, and only if it is
  actually there. No administrator rights are needed for anything else, and the rule is skipped
  entirely when the operator unticks that task — a host and CS2 on the same machine never need it.

## Updating and uninstalling

Re-run a newer `SCOUT-Setup-*.exe` over the installed one: it stops a running host first
(`scout.pid`, image name checked before anything is killed), replaces the program files, and leaves
the data directory alone — the seeded defaults (`teams.json`, `radars.json`, the radar images) are
only copied when missing, so no match data is ever overwritten by an update.

Uninstalling removes the program files, the shortcuts and the firewall rule, and then asks, in the
uninstaller, whether the data directory should go too. Silent uninstalls keep it.

## Signing

Unsigned installers and executables get a SmartScreen warning on other people's machines. Sign on
the build machine after the installer is produced:

```powershell
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" sign `
  /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a dist-installer\SCOUT-Setup-0.1.0.exe
```

Sign `scout-shell.exe` (or the whole staged tree) before packing if the shell should carry a
signature of its own.

## Why Inno Setup

- One self-contained wizard `.exe`, no MSI tooling, no admin rights for the normal case.
- Real wizard pages in a few hundred lines: port, token, CS2 folder detection, firewall, WebView2.
- The same script can also produce an MSI later (an Inno 6.3+ feature) if a managed deployment ever
  needs one, without throwing away this setup.

The Tauri app keeps its own NSIS installer (`npm run shell:build`) for shell-only installs; this
installer ships the shell's `.exe` directly instead of nesting another installer inside it.

## Verified, and not

Verified while this was written (Linux, no Windows, no Inno Setup, no cargo):
the host compiles to plain JavaScript and runs from a staged layout with the data directory as its
working directory (`SCOUT_APP_ROOT` set, panel/OBS/GSI all answering), the production dependency
tree is small (≈6 MB: express, ws, zod; the panel's UI libraries are already inside the `dist`
bundle and are trimmed with a guard that fails the build if the server ever imports one), and the
staging script runs end to end with `--no-shell --no-runtime --no-webview2 --no-installer`.

**Not verified**: `installer\scout.iss` has never been compiled by ISCC, and the wizard has never
run on Windows. Expect to fix a line or two on the first `npm run package:windows` — the places
worth checking first are Inno's wizard-page APIs (`CreateInputQueryPage`, `CreateInputDirPage`) and
the `netsh` quoting.
