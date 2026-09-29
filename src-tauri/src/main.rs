//! SCOUT overlay shell.
//!
//! A transparent, click-through, always-on-top window that shows the SCOUT host's `/game` page exactly over the CS2
//! window while CS2 is in the foreground, and hides itself otherwise. F8 switches it on and off.
//!
//! It is an *external* window, in keeping with the rest of SCOUT: it never reads the game's memory, injects into it or
//! hooks it. It asks Windows where the CS2 window is and whether it is in front (the same questions a task switcher
//! asks), and draws its own window on top. CS2 must run in "Fullscreen Windowed" (borderless): a window cannot be
//! drawn over exclusive fullscreen.
//!
//! Every decision lives in `scout-shell-core` (tested without Tauri); this file observes, asks it, and acts.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod win32;

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use scout_shell_core::config::host_port;
use scout_shell_core::{plan, Action, Prefs, Rect, ShellConfig, Tracker};
use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const LABEL: &str = "overlay";

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

            let poller = window.clone();
            let config = config.clone();
            std::thread::Builder::new().name("scout-shell-poll".into()).spawn(move || poll_loop(poller, config, enabled, wake, woken))?;
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        log(&format!("stopped with an error: {error}"));
        std::process::exit(1);
    }
}

/// Once per poll: make sure the overlay page is loaded, ask Windows about the game, let the core decide, apply it.
fn poll_loop(
    window: WebviewWindow,
    config: ShellConfig,
    enabled: Arc<AtomicBool>,
    keep_alive: Arc<Mutex<Sender<()>>>,
    woken: Receiver<()>,
) {
    let mut finder = win32::GameFinder::new(&config.title, &config.class);
    let mut tracker = Tracker::new(config.hide_after_polls());
    let mut loaded = false;
    let interval = Duration::from_millis(config.poll_ms);
    // The sender stays alive in this thread, so a failed hotkey registration cannot make `woken` report a hang-up.
    let _keep_alive = keep_alive;
    loop {
        if !loaded {
            loaded = load_overlay(&window, &config.url);
        }
        let prefs = Prefs { enabled: enabled.load(Ordering::SeqCst), always: config.always, fallback: config.rect };
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

/// Navigates to the overlay page once something is listening at its address. Returns true when it has.
fn load_overlay(window: &WebviewWindow, address: &str) -> bool {
    let Some((host, port)) = host_port(address) else { return false };
    if !reachable(&host, port) {
        return false;
    }
    match tauri::Url::parse(address) {
        Ok(url) => match window.navigate(url) {
            Ok(()) => {
                log(&format!("loaded {address}"));
                true
            }
            Err(error) => {
                log(&format!("could not load {address}: {error}"));
                false
            }
        },
        Err(error) => {
            log(&format!("{address} is not a valid address: {error}"));
            false
        }
    }
}

/// Is anything accepting connections at host:port? A short timeout keeps the poller responsive when it is not.
fn reachable(host: &str, port: u16) -> bool {
    match (host, port).to_socket_addrs() {
        Ok(addresses) => addresses.into_iter().any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()),
        Err(_) => false,
    }
}
