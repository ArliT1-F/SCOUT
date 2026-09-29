# SCOUT Shell — Windows overlay

A small [Tauri v2](https://v2.tauri.app/) app that shows the SCOUT host's `/game` page in a **transparent, click-through,
always-on-top window laid exactly over the CS2 window**, and hides it whenever CS2 is not in front. It is an alternative to
the OBS Browser Source for when the overlay should appear on the observer's own screen.

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
| **Ctrl+Shift+F8** | Quits the shell. A hidden, click-through window with no taskbar button has no other way out short of Task Manager. |
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
