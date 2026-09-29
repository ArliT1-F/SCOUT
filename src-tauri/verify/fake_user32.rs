//! Test-only (see run.sh). A fake `user32`/`kernel32` with the semantics of the real functions the shell calls:
//! GetWindowTextW/GetClassNameW copy at most max-1 UTF-16 units plus a NUL and return the count copied;
//! EnumWindows stops when the callback returns 0; GetClientRect is always anchored at (0,0).
use crate::win32::GameFinder;
use scout_shell_core::{Rect, Target};
use std::sync::Mutex;

#[derive(Clone)]
struct FakeWindow {
    hwnd: isize,
    title: String,
    class: String,
    visible: bool,
    iconic: bool,
    client: (i32, i32),
    origin: (i32, i32),
    client_ok: bool,
}
struct World {
    windows: Vec<FakeWindow>,
    foreground: isize,
}
static WORLD: Mutex<World> = Mutex::new(World { windows: Vec::new(), foreground: 0 });
static SERIAL: Mutex<()> = Mutex::new(());
fn world() -> std::sync::MutexGuard<'static, World> {
    WORLD.lock().unwrap_or_else(|e| e.into_inner())
}
fn find(hwnd: isize) -> Option<FakeWindow> {
    world().windows.iter().find(|w| w.hwnd == hwnd).cloned()
}

fn copy_out(text: &str, buffer: *mut u16, max: i32) -> i32 {
    if max <= 0 {
        return 0;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let count = units.len().min((max - 1) as usize);
    unsafe {
        for (i, unit) in units[..count].iter().enumerate() {
            *buffer.add(i) = *unit;
        }
        *buffer.add(count) = 0;
    }
    count as i32
}
#[no_mangle]
pub extern "system" fn EnumWindows(callback: Option<unsafe extern "system" fn(isize, isize) -> i32>, lparam: isize) -> i32 {
    let snapshot: Vec<isize> = world().windows.iter().map(|w| w.hwnd).collect(); // the lock is NOT held during callbacks
    let callback = callback.expect("callback");
    for hwnd in snapshot {
        if unsafe { callback(hwnd, lparam) } == 0 {
            return 0;
        }
    }
    1
}
#[no_mangle]
pub extern "system" fn GetWindowTextW(hwnd: isize, buffer: *mut u16, max: i32) -> i32 {
    find(hwnd).map_or(0, |w| copy_out(&w.title, buffer, max))
}
#[no_mangle]
pub extern "system" fn GetClassNameW(hwnd: isize, buffer: *mut u16, max: i32) -> i32 {
    find(hwnd).map_or(0, |w| copy_out(&w.class, buffer, max))
}
#[no_mangle]
pub extern "system" fn IsWindow(hwnd: isize) -> i32 {
    find(hwnd).is_some() as i32
}
#[no_mangle]
pub extern "system" fn IsWindowVisible(hwnd: isize) -> i32 {
    find(hwnd).is_some_and(|w| w.visible) as i32
}
#[no_mangle]
pub extern "system" fn IsIconic(hwnd: isize) -> i32 {
    find(hwnd).is_some_and(|w| w.iconic) as i32
}
#[no_mangle]
pub extern "system" fn GetForegroundWindow() -> isize {
    world().foreground
}
#[repr(C)]
pub struct RawRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
pub struct RawPoint {
    x: i32,
    y: i32,
}
#[no_mangle]
pub extern "system" fn GetClientRect(hwnd: isize, rect: *mut RawRect) -> i32 {
    match find(hwnd) {
        Some(w) if w.client_ok => {
            unsafe { *rect = RawRect { left: 0, top: 0, right: w.client.0, bottom: w.client.1 } };
            1
        }
        _ => 0,
    }
}
#[no_mangle]
pub extern "system" fn ClientToScreen(hwnd: isize, point: *mut RawPoint) -> i32 {
    match find(hwnd) {
        Some(w) => {
            unsafe {
                (*point).x += w.origin.0;
                (*point).y += w.origin.1
            };
            1
        }
        None => 0,
    }
}
#[no_mangle]
pub extern "system" fn AttachConsole(_pid: u32) -> i32 {
    0
}

fn window(hwnd: isize, title: &str, class: &str) -> FakeWindow {
    FakeWindow {
        hwnd,
        title: title.into(),
        class: class.into(),
        visible: true,
        iconic: false,
        client: (1920, 1080),
        origin: (0, 0),
        client_ok: true,
    }
}
fn cs2(hwnd: isize) -> FakeWindow {
    window(hwnd, "Counter-Strike 2", "SDL_app")
}
fn scene(windows: Vec<FakeWindow>, foreground: isize) -> std::sync::MutexGuard<'static, ()> {
    let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut w = world();
    w.windows = windows;
    w.foreground = foreground;
    guard
}
fn finder() -> GameFinder {
    GameFinder::new("Counter-Strike 2", "SDL_app")
}
fn snap(finder: &mut GameFinder) -> Option<Target> {
    finder.snapshot()
}

#[test]
fn finds_the_game_by_exact_title_and_class_and_reports_its_client_area() {
    let _s = scene(vec![window(1, "Desktop", "Progman"), cs2(42)], 42);
    let target = snap(&mut finder()).expect("game found");
    assert_eq!(target, Target { rect: Rect::new(0, 0, 1920, 1080), foreground: true, minimized: false });
}
#[test]
fn the_client_area_is_offset_by_its_screen_position_including_secondary_monitors() {
    let mut game = cs2(7);
    game.client = (1280, 720);
    game.origin = (-1920, 180);
    let _s = scene(vec![game], 7);
    assert_eq!(snap(&mut finder()).unwrap().rect, Rect::new(-1920, 180, 1280, 720));
}
#[test]
fn foreground_is_true_only_while_the_game_owns_it() {
    let _s = scene(vec![cs2(1), window(2, "Notepad", "Notepad")], 2);
    assert!(!snap(&mut finder()).unwrap().foreground);
    world().foreground = 1;
    assert!(snap(&mut finder()).unwrap().foreground);
    world().foreground = 0;
    assert!(!snap(&mut finder()).unwrap().foreground, "no foreground window at all");
}
#[test]
fn a_minimised_game_is_reported_as_minimised() {
    let mut game = cs2(9);
    game.iconic = true;
    game.origin = (-32000, -32000);
    game.client = (160, 28);
    let _s = scene(vec![game], 0);
    let target = snap(&mut finder()).unwrap();
    assert!(target.minimized);
    assert!(!target.rect.is_usable());
}
#[test]
fn lookalikes_are_not_the_game() {
    let _s = scene(
        vec![
            window(1, "Counter-Strike 2 on Steam - Google Chrome", "Chrome_WidgetWin_1"),
            window(2, "Counter-Strike 2", "CabinetWClass"), // a folder in File Explorer
            window(3, "counter-strike 2 - notes", "SDL_app"),
        ],
        1,
    );
    assert_eq!(snap(&mut finder()), None);
}
#[test]
fn an_invisible_window_with_the_right_title_is_skipped_in_favour_of_the_visible_one() {
    let mut hidden = cs2(1);
    hidden.visible = false;
    let _s = scene(vec![hidden, cs2(2)], 2);
    let mut f = finder();
    assert_eq!(snap(&mut f).unwrap().foreground, true, "found window 2, which is the foreground window");
}
#[test]
fn no_game_running_is_none_and_the_search_repeats_until_it_appears() {
    let _s = scene(vec![window(1, "Desktop", "Progman")], 1);
    let mut f = finder();
    assert_eq!(snap(&mut f), None);
    assert_eq!(snap(&mut f), None);
    world().windows.push(cs2(50));
    world().foreground = 50;
    assert_eq!(snap(&mut f).unwrap().foreground, true);
}
#[test]
fn when_the_game_closes_the_cached_handle_is_dropped_and_a_restart_is_found_under_its_new_handle() {
    let _s = scene(vec![cs2(10)], 10);
    let mut f = finder();
    assert!(snap(&mut f).is_some());
    world().windows.clear();
    assert_eq!(snap(&mut f), None, "the window is gone");
    let mut restarted = cs2(99);
    restarted.client = (2560, 1440);
    world().windows.push(restarted);
    world().foreground = 99;
    assert_eq!(snap(&mut f).unwrap().rect, Rect::new(0, 0, 2560, 1440));
}
#[test]
fn a_reused_handle_that_is_now_some_other_window_is_not_mistaken_for_the_game() {
    let _s = scene(vec![cs2(10)], 10);
    let mut f = finder();
    assert!(snap(&mut f).is_some());
    world().windows[0].title = "Calculator".into();
    world().windows[0].class = "CalcFrame".into();
    assert_eq!(snap(&mut f), None, "handle 10 is Calculator now");
}
#[test]
fn a_client_area_that_cannot_be_measured_is_none_not_a_zero_rectangle() {
    let mut game = cs2(3);
    game.client_ok = false;
    let _s = scene(vec![game], 3);
    assert_eq!(snap(&mut finder()), None);
}
#[test]
fn an_overlong_title_is_truncated_safely_and_does_not_match() {
    let _s = scene(vec![window(1, &"Counter-Strike 2".repeat(100), "SDL_app")], 1);
    assert_eq!(snap(&mut finder()), None);
}
#[test]
fn titles_with_characters_outside_the_bmp_do_not_break_decoding() {
    let _s = scene(vec![window(1, "𝔠𝔬𝔲𝔫𝔱𝔢𝔯 🎮 \u{1F4A5}", "SDL_app"), cs2(2)], 2);
    assert_eq!(snap(&mut finder()).unwrap().foreground, true);
}
#[test]
fn an_empty_wanted_class_matches_any_class() {
    let _s = scene(vec![window(5, "Counter-Strike 2", "SomeOtherClass")], 5);
    assert!(GameFinder::new("Counter-Strike 2", "").snapshot().is_some());
    assert!(GameFinder::new("Counter-Strike 2", "SDL_app").snapshot().is_none());
}
#[test]
fn enumeration_stops_at_the_first_match_and_many_windows_are_fine() {
    let mut windows: Vec<FakeWindow> = (100..600).map(|h| window(h, &format!("Window {h}"), "Generic")).collect();
    windows.push(cs2(1));
    windows.push(cs2(2));
    let _s = scene(windows, 1);
    let mut f = finder();
    let target = snap(&mut f).unwrap();
    assert!(target.foreground, "the first matching window (1) is the one tracked");
}
#[test]
fn attaching_a_console_is_harmless_when_there_is_none() {
    crate::win32::attach_parent_console();
}
