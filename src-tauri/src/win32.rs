//! The only OS-specific code in the shell: find the CS2 window and describe what it is doing.
//!
//! On Windows this polls a handful of `user32` functions (the "HWND polling" of the shell). The bindings are declared
//! by hand instead of pulling in a Win32 crate: these signatures have been stable since Windows NT, the shell needs
//! nine of them, and a hand-written block cannot drift with a crate release. On any other platform the poller is a
//! stand-in that never finds a game, so the shell can still be developed and run there with `--always`.
//!
//! Nothing here reads or writes the game's memory, injects into it or hooks it. It asks Windows the questions any
//! task switcher asks — is there a window with this title, where is it, is it in front — and nothing else.
pub use imp::{attach_parent_console, GameFinder};

#[cfg(windows)]
mod imp {
    use scout_shell_core::config::{class_matches, title_matches};
    use scout_shell_core::{Rect, Target};

    /// `HWND` is a pointer-sized handle; `isize` has the same size and calling convention.
    type Hwnd = isize;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct RawRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct RawPoint {
        x: i32,
        y: i32,
    }

    // `BOOL` is `i32`; `LPARAM` is pointer-sized like `isize`.
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>, lparam: isize) -> i32;
        fn GetWindowTextW(hwnd: Hwnd, buffer: *mut u16, max_count: i32) -> i32;
        fn GetClassNameW(hwnd: Hwnd, buffer: *mut u16, max_count: i32) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetClientRect(hwnd: Hwnd, rect: *mut RawRect) -> i32;
        fn ClientToScreen(hwnd: Hwnd, point: *mut RawPoint) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }

    /// A release build has no console of its own (`windows_subsystem = "windows"`). When it is started from a
    /// terminal, attach to that terminal so the shell's diagnostics are visible there.
    pub fn attach_parent_console() {
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        // SAFETY: plain FFI call with a constant argument; failure (no parent console) is harmless.
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    fn read_text(hwnd: Hwnd, read: unsafe extern "system" fn(Hwnd, *mut u16, i32) -> i32) -> String {
        let mut buffer = [0u16; 256];
        // SAFETY: `buffer` is valid for `buffer.len()` UTF-16 units and the length passed matches it.
        let copied = unsafe { read(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if copied <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..(copied as usize).min(buffer.len())])
    }

    fn window_title(hwnd: Hwnd) -> String {
        read_text(hwnd, GetWindowTextW)
    }

    fn window_class(hwnd: Hwnd) -> String {
        read_text(hwnd, GetClassNameW)
    }

    struct Search<'a> {
        title: &'a str,
        class: &'a str,
        found: Hwnd,
    }

    unsafe extern "system" fn on_window(hwnd: Hwnd, lparam: isize) -> i32 {
        // SAFETY: `lparam` is the address of the `Search` that `find_window` keeps alive for the whole enumeration.
        let search = unsafe { &mut *(lparam as *mut Search) };
        // SAFETY: plain FFI calls on a handle Windows just handed to this callback.
        let candidate = unsafe { IsWindowVisible(hwnd) } != 0
            && title_matches(&window_title(hwnd), search.title)
            && class_matches(&window_class(hwnd), search.class);
        if candidate {
            search.found = hwnd;
            0 // stop enumerating
        } else {
            1
        }
    }

    fn find_window(title: &str, class: &str) -> Option<Hwnd> {
        let mut search = Search { title, class, found: 0 };
        // SAFETY: `search` outlives the call, and the callback only touches it through the pointer passed here.
        // EnumWindows returns FALSE when the callback stops the enumeration, which is not an error, so the result is
        // deliberately ignored and `found` is what counts.
        unsafe {
            EnumWindows(Some(on_window), &mut search as *mut Search as isize);
        }
        (search.found != 0).then_some(search.found)
    }

    /// Finds the game window once and keeps re-checking that the cached handle is still that window (a handle can
    /// die, and Windows may reuse it), searching again only when it is not.
    pub struct GameFinder {
        title: String,
        class: String,
        hwnd: Hwnd,
    }

    impl GameFinder {
        pub fn new(title: &str, class: &str) -> Self {
            Self { title: title.to_string(), class: class.to_string(), hwnd: 0 }
        }

        fn cached_is_still_the_game(&self) -> bool {
            // SAFETY: `IsWindow` accepts any handle value, including stale ones.
            self.hwnd != 0
                && unsafe { IsWindow(self.hwnd) } != 0
                && title_matches(&window_title(self.hwnd), &self.title)
                && class_matches(&window_class(self.hwnd), &self.class)
        }

        /// What the game window is doing right now, or `None` when there is no such window.
        pub fn snapshot(&mut self) -> Option<Target> {
            if !self.cached_is_still_the_game() {
                self.hwnd = find_window(&self.title, &self.class).unwrap_or(0);
            }
            let hwnd = self.hwnd;
            if hwnd == 0 {
                return None;
            }
            let mut client = RawRect::default();
            let mut origin = RawPoint::default();
            // SAFETY: both pointers refer to live, correctly laid-out locals.
            let measured = unsafe { GetClientRect(hwnd, &mut client) != 0 && ClientToScreen(hwnd, &mut origin) != 0 };
            if !measured {
                return None;
            }
            // SAFETY: plain FFI calls with a handle value.
            let (minimized, foreground) = unsafe { (IsIconic(hwnd) != 0, GetForegroundWindow() == hwnd) };
            // The client area's top-left is (0, 0) in its own coordinates; ClientToScreen gave its screen position.
            let rect = Rect::from_edges(origin.x, origin.y, origin.x.saturating_add(client.right), origin.y.saturating_add(client.bottom));
            Some(Target { rect, foreground, minimized })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use scout_shell_core::Target;

    pub fn attach_parent_console() {}

    /// There is no game window to poll off Windows; use `--always` to develop the shell there.
    pub struct GameFinder;

    impl GameFinder {
        pub fn new(_title: &str, _class: &str) -> Self {
            Self
        }

        pub fn snapshot(&mut self) -> Option<Target> {
            None
        }
    }
}
