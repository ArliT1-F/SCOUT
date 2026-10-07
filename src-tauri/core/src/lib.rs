//! The decision logic of the SCOUT overlay shell, free of any windowing or OS dependency.
//!
//! The shell is a transparent, click-through, always-on-top window that shows the SCOUT host's `/game` page
//! exactly over the CS2 window while CS2 is in the foreground. Everything that *decides* something lives
//! here so it can be tested anywhere (`cargo test` in this directory needs nothing but a Rust toolchain):
//!
//! * [`geometry`] — rectangles and what the Windows layer observed about the game window,
//! * [`plan`] — the pure decision (cover the game / hide) and the [`plan::Tracker`] that applies it without flicker,
//! * [`config`] — command line and environment parsing, URL and window-title matching,
//! * [`licence`] — the host's licence answer, parsed and turned into "may this launcher run".
//!
//! The Tauri application (`../src`) only observes Windows, asks these functions what to do, and does it.
pub mod config;
pub mod geometry;
pub mod licence;
pub mod plan;

pub use config::ShellConfig;
pub use geometry::{Rect, Target};
pub use licence::{Licence, State};
pub use plan::{plan, Action, Plan, Prefs, Reason, Tracker};
