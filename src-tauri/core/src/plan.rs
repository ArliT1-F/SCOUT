//! What the overlay should do on each poll, and how to apply it without flicker.
use crate::geometry::{Rect, Target};

/// The operator's switches, independent of what the game is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prefs {
    /// The F8 master switch. Off means hidden, whatever the game does.
    pub enabled: bool,
    /// Development mode: ignore the game and cover `fallback` permanently (for trying the shell without CS2).
    pub always: bool,
    /// The rectangle covered in `always` mode.
    pub fallback: Rect,
}

/// Why the overlay is (or is about to be) hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Switched off with the hotkey.
    Disabled,
    /// No game window was found.
    NoGame,
    /// The game window is minimised.
    Minimized,
    /// The game is running but something else has the foreground.
    Background,
    /// The game window has no usable client area (zero-sized, parked off-screen).
    BadRect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Hide(Reason),
    Show(Rect),
}

/// The pure decision: cover the game's client area exactly while the game is in the foreground, and be hidden
/// otherwise. An always-on-top overlay that lingered over a browser or a chat window would be worse than none.
pub fn plan(target: Option<&Target>, prefs: &Prefs) -> Plan {
    if !prefs.enabled {
        return Plan::Hide(Reason::Disabled);
    }
    if prefs.always {
        return if prefs.fallback.is_usable() { Plan::Show(prefs.fallback) } else { Plan::Hide(Reason::BadRect) };
    }
    let Some(target) = target else { return Plan::Hide(Reason::NoGame) };
    if target.minimized {
        return Plan::Hide(Reason::Minimized);
    }
    if !target.foreground {
        return Plan::Hide(Reason::Background);
    }
    if !target.rect.is_usable() {
        return Plan::Hide(Reason::BadRect);
    }
    Plan::Show(target.rect)
}

/// The one window operation a poll results in, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Show(Rect),
    Move(Rect),
    Hide,
}

/// Turns a stream of plans into the minimum number of window operations.
///
/// Showing is immediate: the overlay should be there the moment the game is. Hiding is debounced, because the
/// foreground window flickers for reasons that are not the player leaving the game (a notification, the map
/// loading, the Alt-Tab switcher opening). Only the hotkey hides at once.
#[derive(Debug, Clone)]
pub struct Tracker {
    shown: Option<Rect>,
    misses: u32,
    hide_after: u32,
}

impl Tracker {
    /// `hide_after` is how many consecutive "hide" polls it takes to actually hide (minimum 1).
    pub fn new(hide_after: u32) -> Self {
        Self { shown: None, misses: 0, hide_after: hide_after.max(1) }
    }

    pub fn is_shown(&self) -> bool {
        self.shown.is_some()
    }

    pub fn apply(&mut self, plan: Plan) -> Option<Action> {
        match plan {
            Plan::Show(rect) => {
                self.misses = 0;
                match self.shown {
                    None => {
                        self.shown = Some(rect);
                        Some(Action::Show(rect))
                    }
                    Some(current) if current != rect => {
                        self.shown = Some(rect);
                        Some(Action::Move(rect))
                    }
                    Some(_) => None,
                }
            }
            Plan::Hide(reason) => {
                if self.shown.is_none() {
                    self.misses = 0;
                    return None;
                }
                self.misses += 1;
                if reason == Reason::Disabled || self.misses >= self.hide_after {
                    self.shown = None;
                    self.misses = 0;
                    Some(Action::Hide)
                } else {
                    None
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAME: Rect = Rect::new(0, 0, 1920, 1080);
    const PREFS: Prefs = Prefs { enabled: true, always: false, fallback: Rect::new(0, 0, 1920, 1080) };
    const fn target(rect: Rect, foreground: bool, minimized: bool) -> Target {
        Target { rect, foreground, minimized }
    }

    #[test]
    fn covers_the_game_exactly_while_it_is_in_front() {
        assert_eq!(plan(Some(&target(GAME, true, false)), &PREFS), Plan::Show(GAME));
        let windowed = Rect::new(210, 95, 1280, 720);
        assert_eq!(plan(Some(&target(windowed, true, false)), &PREFS), Plan::Show(windowed), "follows a windowed game");
    }

    #[test]
    fn hides_for_every_way_the_game_can_be_absent_and_says_why() {
        assert_eq!(plan(None, &PREFS), Plan::Hide(Reason::NoGame));
        assert_eq!(plan(Some(&target(GAME, false, false)), &PREFS), Plan::Hide(Reason::Background));
        assert_eq!(plan(Some(&target(GAME, true, true)), &PREFS), Plan::Hide(Reason::Minimized));
        assert_eq!(plan(Some(&target(Rect::new(0, 0, 0, 0), true, false)), &PREFS), Plan::Hide(Reason::BadRect));
        assert_eq!(plan(Some(&target(Rect::new(-32000, -32000, 1920, 1080), true, false)), &PREFS), Plan::Hide(Reason::BadRect));
    }

    #[test]
    fn minimised_outranks_foreground_and_background_outranks_a_bad_rectangle() {
        assert_eq!(plan(Some(&target(GAME, true, true)), &PREFS), Plan::Hide(Reason::Minimized));
        assert_eq!(plan(Some(&target(Rect::new(0, 0, 10, 10), false, false)), &PREFS), Plan::Hide(Reason::Background));
    }

    #[test]
    fn the_hotkey_switch_beats_everything() {
        let off = Prefs { enabled: false, ..PREFS };
        assert_eq!(plan(Some(&target(GAME, true, false)), &off), Plan::Hide(Reason::Disabled));
        assert_eq!(plan(None, &off), Plan::Hide(Reason::Disabled));
        let off_always = Prefs { enabled: false, always: true, ..PREFS };
        assert_eq!(plan(None, &off_always), Plan::Hide(Reason::Disabled), "even development mode obeys F8");
    }

    #[test]
    fn always_mode_ignores_the_game_but_not_a_broken_rectangle() {
        let always = Prefs { always: true, ..PREFS };
        assert_eq!(plan(None, &always), Plan::Show(GAME));
        assert_eq!(plan(Some(&target(Rect::new(5, 5, 300, 300), false, true)), &always), Plan::Show(GAME));
        let broken = Prefs { always: true, fallback: Rect::new(0, 0, 0, 0), ..PREFS };
        assert_eq!(plan(None, &broken), Plan::Hide(Reason::BadRect));
    }

    #[test]
    fn showing_is_immediate_and_repeat_shows_do_nothing() {
        let mut tracker = Tracker::new(3);
        assert!(!tracker.is_shown());
        assert_eq!(tracker.apply(Plan::Show(GAME)), Some(Action::Show(GAME)));
        assert!(tracker.is_shown());
        assert_eq!(tracker.apply(Plan::Show(GAME)), None);
        assert_eq!(tracker.apply(Plan::Show(GAME)), None);
    }

    #[test]
    fn a_moved_or_resized_game_moves_the_overlay_without_hiding_it() {
        let mut tracker = Tracker::new(3);
        tracker.apply(Plan::Show(GAME));
        let moved = Rect::new(100, 40, 1600, 900);
        assert_eq!(tracker.apply(Plan::Show(moved)), Some(Action::Move(moved)));
        assert_eq!(tracker.apply(Plan::Show(moved)), None);
        assert_eq!(tracker.apply(Plan::Show(GAME)), Some(Action::Move(GAME)));
    }

    #[test]
    fn hiding_needs_consecutive_misses_so_a_flicker_does_not_blink_the_overlay() {
        let mut tracker = Tracker::new(3);
        tracker.apply(Plan::Show(GAME));
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), None);
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), None);
        assert_eq!(tracker.apply(Plan::Show(GAME)), None, "the game came back: the miss counter starts over");
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), None);
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), None);
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), Some(Action::Hide));
        assert!(!tracker.is_shown());
    }

    #[test]
    fn the_reason_can_change_while_waiting_and_the_wait_still_counts() {
        let mut tracker = Tracker::new(3);
        tracker.apply(Plan::Show(GAME));
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), None);
        assert_eq!(tracker.apply(Plan::Hide(Reason::NoGame)), None);
        assert_eq!(tracker.apply(Plan::Hide(Reason::Minimized)), Some(Action::Hide));
    }

    #[test]
    fn the_hotkey_hides_at_once_with_no_debounce() {
        let mut tracker = Tracker::new(10);
        tracker.apply(Plan::Show(GAME));
        assert_eq!(tracker.apply(Plan::Hide(Reason::Disabled)), Some(Action::Hide));
    }

    #[test]
    fn hiding_when_already_hidden_is_a_no_op_and_shows_again_cleanly() {
        let mut tracker = Tracker::new(2);
        assert_eq!(tracker.apply(Plan::Hide(Reason::NoGame)), None);
        assert_eq!(tracker.apply(Plan::Hide(Reason::Disabled)), None);
        tracker.apply(Plan::Show(GAME));
        tracker.apply(Plan::Hide(Reason::Background));
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), Some(Action::Hide));
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), None);
        assert_eq!(tracker.apply(Plan::Show(GAME)), Some(Action::Show(GAME)), "shows again after having been hidden");
    }

    #[test]
    fn a_debounce_of_zero_still_hides_on_the_first_miss() {
        let mut tracker = Tracker::new(0);
        tracker.apply(Plan::Show(GAME));
        assert_eq!(tracker.apply(Plan::Hide(Reason::Background)), Some(Action::Hide));
    }
}
