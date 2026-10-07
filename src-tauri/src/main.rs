//! SCOUT overlay shell.
//!
//! Two windows, one launcher:
//!
//! * the **overlay** — a transparent, click-through, always-on-top window that shows the SCOUT host's `/game` page
//!   exactly over the CS2 window while CS2 is in the foreground, hidden otherwise. F8 switches it on and off;
//! * the **operator window** — the host's own control panel (`/`), in a normal window of the launcher, opened when the
//!   host answers and toggled with F9. That is what makes the launcher the whole product rather than a spare monitor
//!   for the overlay: teams, players, maps, scenes, the OBS source address and the launcher link are all in there.
//!
//! With `--require-link` (or `SCOUT_SHELL_REQUIRE_LINK=1`) the shell also asks the host whether this installation is
//! entitled to run, and draws nothing while the answer is an explicit refusal — the launcher's half of the
//! website/launcher link.
//!
//! It is an *external* window, in keeping with the rest of SCOUT: it never reads the game's memory, injects into it or
//! hooks it. It asks Windows where the CS2 window is and whether it is in front (the same questions a task switcher
//! asks), and draws its own window on top. CS2 must run in "Fullscreen Windowed" (borderless): a window cannot be
//! drawn over exclusive fullscreen.
//!
//! Every decision lives in `scout-shell-core` (tested without Tauri); this file observes, asks it, and acts.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod win32;

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::cell::RefCell;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use scout_shell_core::config::host_port;
use scout_shell_core::licence::Licence;
use scout_shell_core::{plan, Action, Prefs, Rect, ShellConfig, Tracker};
use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const LABEL: &str = "overlay";
/// A second label, not a second process: the operator window lives in the same webview host.
const PANEL_LABEL: &str = "panel";
thread_local! {
    /// The host this launcher started, if it started one, so leaving SCOUT can put the machine back
    /// the way it found it — a host the launcher did not start is never touched. Thread-local rather
    /// than a `static` on purpose: the setup hook and the event loop both run on the main thread, and
    /// this way the child never has to cross a thread boundary (or satisfy `Send`) at all.
    static STARTED_HOST: RefCell<Option<Child>> = const { RefCell::new(None) };
}
/// How long between licence re-checks while the shell is running. A revocation therefore reaches a
/// launcher within a minute, without asking the account service on every poll.
const LICENCE_POLL: Duration = Duration::from_secs(60);

fn log(message: &str) {
    eprintln!("[scout-shell] {message}");
}

fn main() {
    win32::attach_parent_console();
    let config = ShellConfig::parse(std::env::args().skip(1), |key| std::env::var(key).ok());
    for warning in &config.warnings {
        log(warning);
    }
    if config.always {
        log(&format!("--always: covering {},{} {}x{} permanently", config.rect.x, config.rect.y, config.rect.width, config.rect.height));
    } else {
        log(&format!("following the window \"{}\" (class \"{}\"), overlay {}", config.title, config.class, config.url));
    }

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            // The window starts on a blank, transparent page shipped inside the app (`ui/index.html`) and is hidden. The
            // overlay page is only loaded once the SCOUT host answers, so a host that is not up yet shows nothing at all
            // instead of a browser error page over the game.
            let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
                .title("SCOUT overlay")
                .transparent(true)
                .decorations(false)
                // `shadow(true)` would give an undecorated Windows window a 1 px white border.
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                // Never take keyboard focus from the game: not when created, not when shown.
                .focused(false)
                .focusable(false)
                .visible(false)
                .inner_size(1280.0, 720.0)
                .position(0.0, 0.0)
                .build()?;
            // Click-through: mouse input goes to the game underneath.
            window.set_ignore_cursor_events(true)?;

            let enabled = Arc::new(AtomicBool::new(true));
            let (wake, woken) = mpsc::channel::<()>();
            let wake = Arc::new(Mutex::new(wake));

            // F8: switch the overlay on and off. The poller is woken so it reacts at once rather than at the next poll.
            {
                let enabled = Arc::clone(&enabled);
                let wake = Arc::clone(&wake);
                let registered = app.global_shortcut().on_shortcut(config.hotkey.as_str(), move |_app, _shortcut, event| {
                    if matches!(event.state(), ShortcutState::Pressed) {
                        let now_enabled = !enabled.load(Ordering::SeqCst);
                        enabled.store(now_enabled, Ordering::SeqCst);
                        log(if now_enabled { "overlay on" } else { "overlay off" });
                        if let Ok(sender) = wake.lock() {
                            let _ = sender.send(());
                        }
                    }
                });
                if let Err(error) = registered {
                    log(&format!("could not register the hotkey \"{}\": {error} — the overlay works, without the hotkey", config.hotkey));
                }
            }
            // A hidden, click-through window with no taskbar button needs its own way out.
            if !config.quit_hotkey.is_empty() {
                let registered = app.global_shortcut().on_shortcut(config.quit_hotkey.as_str(), move |app, _shortcut, event| {
                    if matches!(event.state(), ShortcutState::Pressed) {
                        log("quit requested");
                        app.exit(0);
                    }
                });
                if let Err(error) = registered {
                    log(&format!("could not register the quit hotkey \"{}\": {error}", config.quit_hotkey));
                }
            }

            // The operator window: the host's panel, in a normal window of the launcher. It starts hidden on the
            // blank page the app ships, shows itself the first time the host answers, and is toggled with F9.
            let panel = if config.panel {
                let built = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("index.html".into()))
                    .title("SCOUT — operator panel")
                    .decorations(true)
                    .resizable(true)
                    .always_on_top(false)
                    .skip_taskbar(false)
                    .focused(true)
                    .focusable(true)
                    .visible(false)
                    .inner_size(1440.0, 900.0)
                    .center()
                    .build();
                match built {
                    Ok(window) => {
                        if !config.panel_hotkey.is_empty() {
                            let toggle = window.clone();
                            let registered = app.global_shortcut().on_shortcut(config.panel_hotkey.as_str(), move |_app, _shortcut, event| {
                                if !matches!(event.state(), ShortcutState::Pressed) {
                                    return;
                                }
                                let visible = toggle.is_visible().unwrap_or(false);
                                if visible {
                                    log("operator window hidden");
                                    let _ = toggle.hide();
                                } else {
                                    log("operator window shown");
                                    let _ = toggle.show();
                                    let _ = toggle.set_focus();
                                }
                            });
                            if let Err(error) = registered {
                                log(&format!(
                                    "could not register the panel hotkey \"{}\": {error} — the operator window still opens",
                                    config.panel_hotkey
                                ));
                            }
                        }
                        Some(window)
                    }
                    Err(error) => {
                        // An overlay-only shell is a working shell: report it and carry on.
                        log(&format!("could not create the operator window: {error}"));
                        None
                    }
                }
            } else {
                None
            };

            // The licence gate. Without --require-link nothing here runs.
            let licence_gate = if config.require_link {
                let state = Arc::new(AtomicBool::new(true));
                let checked = window.clone();
                let gate_config = config.clone();
                let gate_state = Arc::clone(&state);
                std::thread::Builder::new().name("scout-shell-licence".into()).spawn(move || {
                    let mut first = true;
                    loop {
                        let licence = check_licence(&gate_config.url, first);
                        first = false;
                        let allowed = !licence.refuses();
                        gate_state.store(allowed, Ordering::SeqCst);
                        if !allowed {
                            log(&format!("licence: {} — {}", licence.state, licence.describe()));
                            let _ = checked.hide();
                        }
                        std::thread::sleep(LICENCE_POLL);
                    }
                })?;
                Some(state)
            } else {
                None
            };

            // The installed launcher is the whole of SCOUT as far as an observer is concerned, so it
            // brings the host up itself when one ships next to it. Without this, pressing the icon on a
            // fresh install shows a blank window and nothing else - which is exactly the sort of thing
            // that makes a broadcast tool feel broken.
            if config.start_host {
                start_host_if_needed(&config);
            }

            let poller = window.clone();
            let config = config.clone();
            std::thread::Builder::new().name("scout-shell-poll".into()).spawn(move || {
                poll_loop(poller, panel, config, enabled, licence_gate, wake, woken)
            })?;
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match result {
        Ok(app) => app,
        Err(error) => {
            log(&format!("stopped with an error: {error}"));
            std::process::exit(1);
        }
    };
    // `Builder::run` is build + `App::run(|_, _| {})`; taking the two steps separately is what makes
    // the exit arm below possible at all.
    app.run(|_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_host_started_here();
        }
    });
}

/// Once per poll: make sure the pages are loaded, ask Windows about the game, let the core decide, apply it.
fn poll_loop(
    window: WebviewWindow,
    panel: Option<WebviewWindow>,
    config: ShellConfig,
    enabled: Arc<AtomicBool>,
    licence: Option<Arc<AtomicBool>>,
    keep_alive: Arc<Mutex<Sender<()>>>,
    woken: Receiver<()>,
) {
    let mut finder = win32::GameFinder::new(&config.title, &config.class);
    let mut tracker = Tracker::new(config.hide_after_polls());
    let mut overlay_loaded = false;
    let mut panel_loaded = false;
    let mut panel_shown = false;
    let mut told_off_air = false;
    let interval = Duration::from_millis(config.poll_ms);
    // The sender stays alive in this thread, so a failed hotkey registration cannot make `woken` report a hang-up.
    let _keep_alive = keep_alive;
    let no_gate = licence.is_none();
    loop {
        if !overlay_loaded {
            overlay_loaded = load_page(&window, &config.url, "overlay");
        }
        // The operator window follows the host rather than the game, and only opens once: after that it is the
        // operator's window, and F9 is how it comes back.
        if let Some(panel_window) = &panel {
            if !panel_loaded {
                panel_loaded = load_page(panel_window, &config.panel_url, "operator panel");
            }
            if panel_loaded && !panel_shown {
                panel_shown = true;
                log("the host answered: opening the operator panel — F9 hides and shows it");
                let _ = panel_window.show();
            }
        }
        // A refusal that arrived while the shell was running puts the overlay away, and says so once.
        if !no_gate && !licence.as_ref().map(|state| state.load(Ordering::SeqCst)).unwrap_or(true) {
            if !told_off_air {
                told_off_air = true;
                log("licence refused: the overlay stays hidden until the installation is linked again");
                let _ = window.hide();
            }
        } else {
            told_off_air = false;
        }
        let allowed = licence.as_ref().map(|state| state.load(Ordering::SeqCst)).unwrap_or(true);
        let prefs = Prefs { enabled: enabled.load(Ordering::SeqCst) && allowed, always: config.always, fallback: config.rect };
        let target = if config.always { None } else { finder.snapshot() };
        match tracker.apply(plan(target.as_ref(), &prefs)) {
            Some(Action::Show(rect)) => {
                place(&window, rect);
                // Something else may have pushed the overlay down the z-order while it was hidden.
                if let Err(error) = window.set_always_on_top(true) {
                    log(&format!("set_always_on_top failed: {error}"));
                }
                if let Err(error) = window.show() {
                    log(&format!("show failed: {error}"));
                }
            }
            Some(Action::Move(rect)) => place(&window, rect),
            Some(Action::Hide) => {
                if let Err(error) = window.hide() {
                    log(&format!("hide failed: {error}"));
                }
            }
            None => {}
        }
        match woken.recv_timeout(interval) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => std::thread::sleep(interval),
        }
    }
}

/// Position and size are physical pixels, the unit Windows reports the game's client area in.
fn place(window: &WebviewWindow, rect: Rect) {
    if let Err(error) = window.set_size(PhysicalSize::new(rect.width, rect.height)) {
        log(&format!("set_size failed: {error}"));
    }
    if let Err(error) = window.set_position(PhysicalPosition::new(rect.x, rect.y)) {
        log(&format!("set_position failed: {error}"));
    }
}

/// Where the installer puts an operator's data, and the files the installed shortcuts read. Kept in
/// step with `installer/launcher/scout-host.cmd` and `installer/scout.iss` (`{#DataDir}`): the shell
/// reads the same small text files rather than inventing a second convention.
fn data_dir() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = std::path::Path::new(&appdata).join("SCOUT");
    dir.is_dir().then_some(dir)
}

fn read_trimmed(file: &std::path::Path) -> Option<String> {
    let value = fs::read_to_string(file).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The program files root: `app-root.txt` in the data directory (written by the installer, and what
/// the shortcuts use), or this executable's own parent directory as a fallback, so a launcher that
/// still sits inside `{app}\host` finds `{app}\runtime\node.exe` either way.
fn program_root(data: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Some(root) = read_trimmed(&data.join("app-root.txt")) {
        let path = std::path::PathBuf::from(root);
        if path.join("host").join("server").join("index.js").is_file() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let host_dir = exe.parent()?;
    // {app}\host\scout-shell.exe -> {app}
    let root = host_dir.parent()?.to_path_buf();
    root.join("host").join("server").join("index.js").is_file().then_some(root)
}

/// Start the host that ships next to the launcher, unless one is already answering where the overlay
/// is pointed. Nothing here reaches the network beyond a single connection attempt: the point is to
/// make the icon work, not to supervise the host.
fn start_host_if_needed(config: &ShellConfig) -> Option<()> {
    let Some((host, port)) = host_port(&config.url) else { return None };
    // A launcher pointed at a host on another machine must not start a second one here.
    let local = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]");
    if !local {
        log(&format!("the host is {host}: the launcher only starts a host that runs on this machine"));
        return None;
    }
    if reachable(&host, port) {
        log(&format!("a SCOUT host is already answering on port {port}; using it"));
        return None;
    }
    let data = data_dir()?;
    let root = program_root(&data)?;
    let url_port = port;
    let port = read_trimmed(&data.join("port.txt")).unwrap_or_else(|| port.to_string());
    if let Ok(installed) = port.parse::<u16>() {
        // The installer picks the port and bakes it into the shortcuts; somebody starting the
        // executable by hand with the default URL would otherwise watch a blank window.
        if installed != url_port {
            log(&format!(
                "the installed host listens on port {installed}, but this launcher is pointed at port {url_port}; start SCOUT from its shortcut, or pass --url http://127.0.0.1:{installed}/game"
            ));
        }
    }
    let node = root.join("runtime").join("node.exe");
    let entry = root.join("host").join("server").join("index.js");
    if !node.is_file() || !entry.is_file() {
        log("no bundled host next to this launcher; not starting one");
        return None;
    }
    // The host log: the console an operator would have had, in a file they can attach to a message.
    // Trimmed at 1 MB so a long event cannot fill a disk with routing lines.
    let log_path = data.join("scout-host.log");
    if fs::metadata(&log_path).map(|meta| meta.len() > 1_000_000).unwrap_or(false) {
        let _ = fs::write(&log_path, b"");
    }
    let log_file = fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let mut command = Command::new(&node);
    command
        .arg(&entry)
        // The host keeps config/, public/uploads/ and recordings/ in the working directory.
        .current_dir(&data)
        .env("NODE_ENV", "production")
        .env("PORT", &port)
        .env("SCOUT_APP_ROOT", &root)
        .env("SCOUT_PID_FILE", data.join("scout.pid"))
        .stdin(Stdio::null());
    for (file, variable) in [
        ("gsi_token.txt", "GSI_TOKEN"),
        ("panel_token.txt", "SCOUT_PANEL_TOKEN"),
        ("remote.txt", "SCOUT_REMOTE"),
    ] {
        if let Some(value) = read_trimmed(&data.join(file)) {
            command.env(variable, value);
        }
    }
    match log_file {
        Some(file) => {
            let clone = file.try_clone();
            command.stdout(Stdio::from(file));
            if let Ok(clone) = clone {
                command.stderr(Stdio::from(clone));
            } else {
                command.stderr(Stdio::null());
            }
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    // A console window for a program nobody watches is the thing an observer is least comfortable
    // with, so the child is created detached from one (CreateProcess's CREATE_NO_WINDOW).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    match command.spawn() {
        Ok(child) => {
            log(&format!(
                "started the SCOUT host on port {port} (log: {})",
                log_path.display()
            ));
            STARTED_HOST.with(|slot| *slot.borrow_mut() = Some(child));
            Some(())
        }
        Err(error) => {
            log(&format!("could not start the SCOUT host ({}): {error}", node.display()));
            None
        }
    }
}

/// Stop the host only if this launcher started it. Called as the app exits, so closing SCOUT from
/// the panel, F8/F9 or Ctrl+Shift+F8 leaves no stray node.exe behind.
fn stop_host_started_here() {
    STARTED_HOST.with(|slot| {
        if let Some(mut child) = slot.borrow_mut().take() {
            log("stopping the SCOUT host this launcher started");
            let _ = child.kill();
            let _ = child.wait();
        }
    });
}

/// Navigates a window to its page once something is listening at the address. Returns true when it has.
fn load_page(window: &WebviewWindow, address: &str, what: &str) -> bool {
    let Some((host, port)) = host_port(address) else { return false };
    if !reachable(&host, port) {
        return false;
    }
    match tauri::Url::parse(address) {
        Ok(url) => match window.navigate(url) {
            Ok(()) => {
                log(&format!("loaded {what} · {address}"));
                true
            }
            Err(error) => {
                log(&format!("could not load {what} {address}: {error}"));
                false
            }
        },
        Err(error) => {
            log(&format!("{address} is not a valid address: {error}"));
            false
        }
    }
}

/// Ask the host what it thinks of this installation. The host always answers; only a host that is not
/// running (or a body that is not the expected JSON) yields "no answer", which never refuses.
fn check_licence(overlay_url: &str, force: bool) -> Licence {
    let Some((host, port)) = host_port(overlay_url) else { return Licence::none() };
    let path = if force { "/api/beta/license?refresh=1" } else { "/api/beta/license" };
    match http_get(&host, port, path) {
        Some(body) => scout_shell_core::licence::parse(&body),
        None => Licence::none(),
    }
}

/// A GET and its body, without an HTTP client crate: one request, `Connection: close`, HTTP/1.0 so
/// every server answers with a plain body. The shell has no other need for HTTP, and a dependency
/// that only exists to read one small JSON document would be one more thing to audit in an installer.
fn http_get(host: &str, port: u16, path: &str) -> Option<String> {
    let addresses = (host, port).to_socket_addrs().ok()?;
    let mut stream = addresses
        .into_iter()
        .find_map(|address| TcpStream::connect_timeout(&address, Duration::from_millis(400)).ok())?;
    stream.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
    let request = format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/") || !head.lines().next()?.contains(" 200") {
        return None;
    }
    Some(body.to_string())
}

/// Is anything accepting connections at host:port? A short timeout keeps the poller responsive when it is not.
fn reachable(host: &str, port: u16) -> bool {
    match (host, port).to_socket_addrs() {
        Ok(addresses) => addresses.into_iter().any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()),
        Err(_) => false,
    }
}
