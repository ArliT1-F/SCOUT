# SCOUT Shell — Windows overlay

A small [Tauri v2](https://v2.tauri.app/) app with two windows and one job each:

* the **overlay** — the SCOUT host's `/game` page in a **transparent, click-through, always-on-top window laid exactly over
  the CS2 window**, hidden whenever CS2 is not in front. An alternative to the OBS Browser Source for when the overlay should
  appear on the observer's own screen;
* the **operator panel** — the host's own control surface (`/`) in an ordinary window of the launcher: teams, players, maps,
  scenes, the OBS source address, the layout editor, the beta applications and the launcher link. It opens as soon as the host
  answers and is toggled with **F9**, which is what makes the launcher the whole product rather than a spare monitor for the
  overlay. `--no-panel` turns it off for overlay-only use.

Like the rest of SCOUT it is strictly external. It never opens, reads or modifies the CS2 process and injects nothing; it
enumerates top-level windows the way any task switcher does and draws its own window on top. As with any third-party
software near a game, follow your event's rules.

## What it does

| | |
| --- | --- |
| **Finds CS2** | Every 250 ms it looks for a visible top-level window titled exactly `Counter-Strike 2` (case-insensitive) whose class is `SDL_app` (Win32 `EnumWindows`), and reads its client area, whether it is minimised, and whether it is the foreground window. Exact matching matters: a browser tab called "Counter-Strike 2 on Steam – Chrome" or a folder called "Counter-Strike 2" in Explorer is not the game. |
| **Covers it** | The overlay window is sized and positioned to the game's *client area* in physical pixels, and follows the game if it is moved or resized (including onto a second monitor). The overlay page letterboxes its 1920 × 1080 canvas into whatever size that is. |
| **Foreground visibility** | Visible only while CS2 is the foreground window. It shows the moment CS2 comes to the front and hides after ~400 ms of CS2 being out of front (debounced, so a notification or the Alt-Tab switcher opening does not make it blink). No game, minimised, or a zero-sized window all hide it. |
| **Click-through** | Mouse input passes through to the game (`set_ignore_cursor_events`). The window is created unfocused and non-focusable (`focused(false)`, `focusable(false)`) and has no taskbar button, so showing it should never take the keyboard from CS2 — one of the things to confirm on Windows, see below. |
| **F8** | Toggles the overlay on and off (global hotkey). Off means hidden whatever CS2 does, and takes effect immediately. |
| **F9** | Shows and hides the operator window (`--panel-hotkey`). Never the same chord as F8 or the quit hotkey. |
| **Ctrl+Shift+F8** | Quits the shell. A hidden, click-through window with no taskbar button has no other way out short of Task Manager. |
| **The operator panel** | A normal window on the host root, derived from `--url` (`http://10.0.0.7:9000/game` → `http://10.0.0.7:9000/`) unless `--panel-url` says otherwise. It loads the blank page the app ships, shows itself the first time the host answers, and after that it is the operator's window. |
| **The licence check** | With `--require-link` (or `SCOUT_SHELL_REQUIRE_LINK=1`) the shell asks the host `GET /api/beta/license` every minute and draws nothing while the answer is an explicit refusal. Off by default: a licence server outage must never be able to take a broadcast off air. `active`, `unknown` and `offline` all run; `revoked`, `unlinked` and `pending` hide the overlay. |
| **Waits for the host** | The window starts on a blank transparent page shipped in the app. The overlay is only loaded once the SCOUT host answers on its address, so a host that is not running yet draws nothing over the game — never a browser error page. |

CS2 must run in **Fullscreen Windowed** (borderless). A window cannot be drawn over exclusive fullscreen.

The overlay window is given **no Tauri permissions** (there is no `capabilities/` directory), so the page it displays cannot
call into the native side at all.

## Build and run

Requirements: Windows 10/11 (WebView2 ships with Windows 11 and current Windows 10; the installer fetches it if missing), the [Rust toolchain](https://rustup.rs/) with the MSVC build tools,
and the Tauri CLI:

```sh
cargo install tauri-cli --version "^2"
npm run shell:build     # = cargo tauri build → src-tauri/target/release/scout-shell.exe and an NSIS installer
npm run shell:dev       # = cargo tauri dev
```

Start the SCOUT host first (`npm run dev` or `npm start`) — or in any order; the shell waits for it. Then launch
`scout-shell.exe` and start CS2.

To try the shell **without CS2** (or anywhere that is not Windows), cover a fixed rectangle permanently:

```powershell
$env:SCOUT_SHELL_ALWAYS = 1; cargo tauri dev
scout-shell.exe --always --rect 0,0,1280,720
```

## What the installed icon does

`SCOUT-Setup.exe` puts the launcher at `{app}\host\scout-shell.exe` with the host next to it
(`{app}\host\server\index.js`, `{app}\runtime\node.exe`) and one Start-menu/desktop entry called
**SCOUT**. Pressing it runs the launcher, which reads the same small text files the installed
shortcuts use (`%APPDATA%\SCOUT\app-root.txt`, `port.txt`, `gsi_token.txt`, `panel_token.txt`,
`remote.txt` — see `installer/launcher/scout-host.cmd`), starts the host if it is not already
answering, opens the panel window and puts the overlay over CS2. `docs/INSTALL.md` is the version of
this written for the observer rather than for a developer.

## Options

Environment variables configure it; command-line arguments override them. A bad value never stops the shell — it falls back to
the default and prints a warning.

| Argument | Environment variable | Default | |
| --- | --- | --- | --- |
| `--url` | `SCOUT_URL` | `http://127.0.0.1:8080/game` | The overlay page (`http`/`https`). Use the host's LAN address when the host runs on another PC. |
| `--title` | `SCOUT_SHELL_TITLE` | `Counter-Strike 2` | Exact window title to follow. |
| `--class` | `SCOUT_SHELL_CLASS` | `SDL_app` | Window class to follow; empty matches any class. |
| `--hotkey` | `SCOUT_SHELL_HOTKEY` | `F8` | Toggle. Any key the global-shortcut plugin accepts, e.g. `F9` or `Ctrl+F8`. |
| `--quit-hotkey` | `SCOUT_SHELL_QUIT_HOTKEY` | `Ctrl+Shift+F8` | Quit. Empty disables it. Never the same chord as the toggle. |
| `--poll` | `SCOUT_SHELL_POLL_MS` | `250` | Poll interval, 50–2000 ms. |
| `--hide` | `SCOUT_SHELL_HIDE_MS` | `400` | How long CS2 must be out of front before the overlay hides, 0–5000 ms. |
| `--always` | `SCOUT_SHELL_ALWAYS` | off | Ignore CS2 and cover `--rect` permanently (development). |
| `--rect x,y,w,h` | `SCOUT_SHELL_RECT` | `0,0,1920,1080` | Rectangle for `--always`, physical pixels, at least 200 × 200. |
| `--panel` / `--no-panel` | `SCOUT_SHELL_PANEL` | on | Open the host's operator panel in a window of its own. |
| `--panel-url` | `SCOUT_SHELL_PANEL_URL` | derived from `--url` | The panel address. Same scheme/host/port as the overlay address, root path, unless set. |
| `--panel-hotkey` | `SCOUT_SHELL_PANEL_HOTKEY` | `F9` | Show/hide the operator window. Empty disables the hotkey; a chord already used is refused with a warning. |
| `--require-link` / `--no-require-link` | `SCOUT_SHELL_REQUIRE_LINK` | off | Hide the overlay unless the host reports that this installation may run. See the licence row above and `docs/BETA.md`. |
| `--start-host` / `--no-start-host` | `SCOUT_SHELL_START_HOST` | on | Start the host that ships next to the launcher, when there is one and nothing is already answering. This is what makes the installed **SCOUT** icon the only thing an operator presses: the launcher brings up the host (without a console window — its output goes to `%APPDATA%\SCOUT\scout-host.log`), the panel window and the overlay, and stops that host again on exit. A checkout has no bundled host, and a launcher pointed at another machine does not start one. |

A release build has no console. When you start it **from a terminal** it attaches to that terminal, so its diagnostics
(what it is following, hotkey presses, load errors) are visible there.

## If nothing shows

1. Run `scout-shell.exe` from a terminal and read what it prints.
2. `scout-shell.exe --always` — if the overlay appears, rendering works and the problem is finding or following the game.
3. Is CS2 in Fullscreen Windowed? Is the window title exactly `Counter-Strike 2`? (`--title` / `--class` override both.)
4. Is `http://127.0.0.1:8080/game` (or your `--url`) reachable from this PC? The overlay loads only once something answers there.
5. The overlay follows the *foreground*: clicking another window — even on a second monitor — hides it after the hide delay.
   Lengthen `--hide`, or use `--always` to stop following.

## Layout

```
src-tauri/
├─ core/              scout-shell-core: every decision, dependency-free (geometry, plan + flicker tracker, configuration)
├─ src/main.rs        Tauri glue: the window, F8, the polling thread
├─ src/win32.rs       the only OS code: user32 window polling (hand-declared FFI), with a stand-in off Windows
├─ verify/            runs win32.rs's real Windows code against a fake user32, on Linux/macOS
├─ ui/index.html      the blank transparent page the window starts on
├─ tauri.conf.json    no windows in config (the window is built in code); NSIS bundle; identifier app.scout.shell
└─ icons/             generated with `tauri icon` from the SCOUT mark
```

## Testing and what has been verified

```sh
npm run shell:test          # cargo test in core/ — 32 tests, needs only a Rust toolchain (no Tauri, no network)
npm run shell:test:win32    # bash verify/run.sh — 15 tests exercising win32.rs against a fake user32 (Linux/macOS)
```

Verified where this was written (Linux, no Windows, no CS2, no crates.io access):

- `core`: 32 unit tests — the show/hide decision for every state of the game window, the flicker tracker, configuration
  parsing with hostile input, URL and host parsing, exact window-title/class matching. `clippy -D warnings` and `rustfmt` clean.
- `win32.rs`: the *Windows* branch was compiled (`--cfg windows`) and **executed** against a fake `user32` that has the real
  functions' semantics (UTF-16 buffer truncation and NUL terminator, `EnumWindows` stopping when the callback returns 0,
  `GetClientRect` anchored at (0, 0)) — 15 tests, including look-alike windows, a reused window handle, secondary-monitor
  coordinates and a minimised game. Deliberately breaking the code in three ways makes them fail.
- `main.rs`: type-checked (and `clippy -D warnings` clean) against stub crates whose signatures were copied from the
  docs.rs pages of `tauri` 2.12 and `tauri-plugin-global-shortcut` 2.4 (`WebviewWindowBuilder`, `WebviewWindow`,
  `GlobalShortcut::on_shortcut`, `AppHandle::exit`, `tauri.conf.json` fields).
- The icon set was produced by the official Tauri CLI's `tauri icon` command, from the SCOUT mark.

**Not verified** — the shell has never been compiled against the real Tauri crates or run on Windows:

- that the WebView2 window is genuinely transparent and click-through together, and does not steal focus when shown;
- that F8 and the quit chord register on your machine (another program may own the key; the shell says so and carries on);
- how it behaves against a real CS2 window — the title and class were taken from what CS2 is known to use, and both can be
  overridden with `--title` / `--class`.

Please try it on the observer machine before relying on it on air, and report what you see.
