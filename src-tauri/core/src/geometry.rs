//! Window geometry as Windows reports it: physical pixels, top-left origin.

/// A rectangle in physical (device) pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    /// Smallest side a game window can plausibly have. Anything smaller is a placeholder: a minimised window,
    /// a window that is still being created, or a zero-sized client area.
    pub const MIN_SIDE: u32 = 200;
    /// Windows parks minimised windows around (-32000, -32000).
    const PARKED_BELOW: i32 = -30_000;

    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    /// Build from Win32 `RECT` edges. Inverted or empty edges give a zero-sized rectangle rather than a
    /// negative one, and arithmetic cannot overflow.
    pub fn from_edges(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        let span = |from: i32, to: i32| (i64::from(to) - i64::from(from)).clamp(0, i64::from(u32::MAX)) as u32;
        Self { x: left, y: top, width: span(left, right), height: span(top, bottom) }
    }

    /// Windows reports minimised windows at (-32000, -32000); that is not a place to draw an overlay.
    pub fn is_parked(&self) -> bool {
        self.x <= Self::PARKED_BELOW || self.y <= Self::PARKED_BELOW
    }

    /// Large enough, and not parked off-screen, to be the game's real client area.
    pub fn is_usable(&self) -> bool {
        self.width >= Self::MIN_SIDE && self.height >= Self::MIN_SIDE && !self.is_parked()
    }
}

/// What the Win32 layer observed about the game window on one poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    /// The game's client area in screen coordinates (the drawable part, without borders or a title bar).
    pub rect: Rect,
    /// The game window (or the overlay itself) is the foreground window.
    pub foreground: bool,
    /// The game window is minimised.
    pub minimized: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_become_a_position_and_a_size() {
        assert_eq!(Rect::from_edges(100, 50, 2020, 1130), Rect::new(100, 50, 1920, 1080));
        assert_eq!(Rect::from_edges(-1920, 0, 0, 1080), Rect::new(-1920, 0, 1920, 1080), "a monitor left of the primary");
    }

    #[test]
    fn inverted_or_extreme_edges_never_go_negative_or_overflow() {
        assert_eq!(Rect::from_edges(500, 500, 100, 100), Rect::new(500, 500, 0, 0));
        assert_eq!(Rect::from_edges(0, 0, 0, 0).width, 0);
        let huge = Rect::from_edges(i32::MIN, i32::MIN, i32::MAX, i32::MAX);
        assert_eq!((huge.width, huge.height), (u32::MAX, u32::MAX));
    }

    #[test]
    fn only_a_real_sized_on_screen_window_is_usable() {
        assert!(Rect::new(0, 0, 1920, 1080).is_usable());
        assert!(Rect::new(-1920, 0, 1920, 1080).is_usable(), "secondary monitors have negative coordinates");
        assert!(Rect::new(0, 0, 1280, 720).is_usable());
        assert!(Rect::new(0, 0, Rect::MIN_SIDE, Rect::MIN_SIDE).is_usable());
        assert!(!Rect::new(0, 0, Rect::MIN_SIDE - 1, 1080).is_usable());
        assert!(!Rect::new(0, 0, 1920, Rect::MIN_SIDE - 1).is_usable());
        assert!(!Rect::new(0, 0, 0, 0).is_usable());
    }

    #[test]
    fn a_minimised_window_parked_off_screen_is_not_usable_even_if_it_kept_its_size() {
        assert!(Rect::new(-32000, -32000, 1920, 1080).is_parked());
        assert!(!Rect::new(-32000, -32000, 1920, 1080).is_usable());
        assert!(Rect::new(-30_000, 0, 1920, 1080).is_parked());
        assert!(!Rect::new(-29_999, 0, 1920, 1080).is_parked());
    }
}
