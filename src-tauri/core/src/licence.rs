//! Reading the host's licence answer, and deciding what it means for the launcher.
//!
//! `GET /api/beta/license` on the SCOUT host answers with a small JSON object (see
//! `server/licensing.ts`). This module is deliberately the *only* place that turns those bytes into a
//! decision, for the same reason the window geometry lives here: it can be tested with nothing but a
//! Rust toolchain, on any platform, without a host, a socket or a WebView.
//!
//! Three rules the parser keeps:
//!
//! * It never trusts the shape. The host is a small service that an operator can replace; a body that
//!   is not the expected JSON must not panic, must not be read as "revoked", and must leave the
//!   overlay alone.
//! * `unknown` and `offline` may run. A device the service has never heard of, or a service that
//!   cannot be reached, is not a revocation — and a licence server must never be able to stop a
//!   broadcast that is already on air.
//! * Only an explicit refusal stops the launcher: `revoked`, `unlinked` and `pending` when
//!   `SCOUT_SHELL_REQUIRE_LINK` is set.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Active,
    Pending,
    Unlinked,
    Revoked,
    Unknown,
    Offline,
    /// No answer was parsed at all — the host is not there, or answered something else entirely.
    None,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Active => "active",
            State::Pending => "pending",
            State::Unlinked => "unlinked",
            State::Revoked => "revoked",
            State::Unknown => "unknown",
            State::Offline => "offline",
            State::None => "none",
        }
    }

    /// The states a launcher may keep running in. `Unknown` covers "the service does not know this
    /// installation", which is a link to redo, not a reason to go off air; `None` covers "no answer
    /// was read at all", because a shell that cannot read the licence must leave the overlay alone.
    pub fn may_run(self) -> bool {
        matches!(self, State::Active | State::Unknown | State::Offline | State::None)
    }
}

impl fmt::Display for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Licence {
    pub state: State,
    /// What the host said this installation is linked to, if anything.
    pub email: Option<String>,
    /// Whether the deployment enforces the licence (`SCOUT_REQUIRE_LICENCE=1`).
    pub enforced: bool,
    /// The host's own sentence for an operator; falls back to one written here.
    pub message: Option<String>,
}

impl Licence {
    pub fn none() -> Self {
        Self { state: State::None, email: None, enforced: false, message: None }
    }

    /// Should the shell refuse to draw the overlay? Only an explicit refusal, and only when the
    /// deployment asked for enforcement — a body that could not be read is not a refusal.
    pub fn refuses(&self) -> bool {
        self.enforced && !self.state.may_run()
    }

    pub fn describe(&self) -> String {
        if let Some(message) = &self.message {
            if !message.is_empty() {
                return message.clone();
            }
        }
        match self.state {
            State::Active => "linked and verified".into(),
            State::Pending => "a launcher link is waiting to be approved".into(),
            State::Unlinked => "this installation is not linked to a SCOUT account".into(),
            State::Revoked => "this installation was unlinked or revoked".into(),
            State::Offline => "the account service could not be reached".into(),
            State::Unknown | State::None => "the licence state could not be read".into(),
        }
    }
}

/// Parse the host's answer. Tolerant on purpose: an unexpected body yields `State::None`, never a
/// panic and never a refusal.
pub fn parse(body: &str) -> Licence {
    let body = strip_chunked(body);
    let state = json_string(&body, "state").map(|value| match value.as_str() {
        "active" => State::Active,
        "pending" => State::Pending,
        "unlinked" => State::Unlinked,
        "revoked" => State::Revoked,
        "offline" => State::Offline,
        "unknown" => State::Unknown,
        _ => State::Unknown,
    });
    let Some(state) = state else {
        return Licence::none();
    };
    Licence {
        state,
        email: json_string(&body, "email").filter(|value| value.contains('@')),
        enforced: json_bool(&body, "enforced").unwrap_or(false),
        message: json_string(&body, "message"),
    }
}

/// The value of a `"key": "value"` pair, with the usual escapes left as they are: these strings are
/// addresses, states and sentences, not paths through a parser.
fn json_string(body: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut from = 0;
    while let Some(offset) = body[from..].find(&needle) {
        let index = from + offset + needle.len();
        from = index;
        let rest = body[index..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else { continue };
        let rest = rest.trim_start();
        if let Some(rest) = rest.strip_prefix("null") {
            // An explicit null (no linked account) is a real answer.
            let _ = rest;
            return None;
        }
        let Some(rest) = rest.strip_prefix('"') else { continue };
        let mut value = String::new();
        let mut chars = rest.chars();
        while let Some(character) = chars.next() {
            match character {
                '"' => return Some(value),
                '\\' => match chars.next() {
                    Some('n') => value.push('\n'),
                    Some('t') => value.push('\t'),
                    Some('u') => {
                        let hex: String = chars.by_ref().take(4).collect();
                        if let Some(character) = u16::from_str_radix(hex.trim(), 16).ok().and_then(|code| char::from_u32(u32::from(code))) {
                            value.push(character);
                        }
                    }
                    Some(other) => value.push(other),
                    None => break,
                },
                other => value.push(other),
            }
        }
        return Some(value);
    }
    None
}

fn json_bool(body: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{key}\"");
    let index = body.find(&needle)? + needle.len();
    let rest = body[index..].trim_start().strip_prefix(':')?.trim_start();
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

/// HTTP/1.0 with `Connection: close` means no chunked framing, but a proxy in front of an operator's
/// host is allowed to answer HTTP/1.1 — so unwrap chunked framing if it is there, and otherwise hand
/// the body back untouched.
fn strip_chunked(body: &str) -> String {
    let trimmed = body.trim_start();
    let Some((line, rest)) = trimmed.split_once("\r\n") else { return body.to_string() };
    if line.is_empty() || line.len() > 8 || !line.chars().all(|character| character.is_ascii_hexdigit()) {
        return body.to_string();
    }
    let Some(size) = u64::from_str_radix(line, 16).ok() else { return body.to_string() };
    if size == 0 || (size as usize) > rest.len() {
        return body.to_string();
    }
    rest[..size as usize].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACTIVE: &str = r#"{"mode":"local","state":"active","enforced":false,"email":"ada@example.com","displayName":"Ada","deviceId":"dev-1","checkedAt":1700000000000,"lastGoodAt":null,"graceExpiresAt":null,"message":"Linked to ada@example.com. This installation may run."}"#;

    #[test]
    fn a_linked_installation_is_read_and_may_run() {
        let licence = parse(ACTIVE);
        assert_eq!(licence.state, State::Active);
        assert_eq!(licence.email.as_deref(), Some("ada@example.com"));
        assert!(!licence.enforced);
        assert!(!licence.refuses());
        assert!(licence.state.may_run());
        assert!(licence.describe().contains("may run"));
    }

    #[test]
    fn every_state_the_host_can_report_is_understood() {
        for (state, expected) in [
            ("active", State::Active),
            ("pending", State::Pending),
            ("unlinked", State::Unlinked),
            ("revoked", State::Revoked),
            ("offline", State::Offline),
            ("unknown", State::Unknown),
        ] {
            let body = format!(r#"{{"state":"{state}","enforced":true,"message":"m"}}"#);
            assert_eq!(parse(&body).state, expected, "{state}");
        }
    }

    #[test]
    fn only_an_explicit_refusal_with_enforcement_stops_the_launcher() {
        let refused = |state: &str, enforced: bool| {
            parse(&format!(r#"{{"state":"{state}","enforced":{enforced}}}"#)).refuses()
        };
        assert!(refused("revoked", true));
        assert!(refused("unlinked", true));
        assert!(refused("pending", true));
        assert!(!refused("revoked", false), "without enforcement the state is reported, not acted on");
        assert!(!refused("active", true));
        assert!(!refused("unknown", true), "an unknown installation is a link to redo, not a revocation");
        assert!(!refused("offline", true), "a licence server outage must never take a broadcast down");
    }

    #[test]
    fn a_body_that_is_not_the_expected_json_is_never_a_refusal() {
        for body in [
            "",
            " ",
            "not json at all",
            "<html><body>502 Bad Gateway</body></html>",
            r#"{"error":"upstream refused"}"#,
            r#"{"state":null,"enforced":true}"#,
            r#"{"state":123}"#,
            r#"{"enforced":true}"#,
            r#"{"enforced":true,"note":"behind a captive portal"}"#,
            "\u{0}\u{1}\u{2}",
            &"x".repeat(100_000),
        ] {
            let licence = parse(body);
            assert_eq!(licence.state, State::None, "{body:.40}");
            assert!(!licence.refuses(), "{body:.40}");
        }
    }

    #[test]
    fn a_proxy_that_answers_in_chunks_is_still_read() {
        let chunked = format!("{:x}\r\n{}\r\n0\r\n\r\n", ACTIVE.len(), ACTIVE);
        assert_eq!(parse(&chunked).state, State::Active);
    }

    #[test]
    fn a_null_email_is_no_email_and_a_broken_one_is_ignored() {
        assert_eq!(parse(r#"{"state":"unlinked","email":null}"#).email, None);
        assert_eq!(parse(r#"{"state":"active","email":"not-an-address"}"#).email, None);
        assert_eq!(parse(r#"{"state":"active","email":"ada@example.com"}"#).email.as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn escaped_characters_in_the_hosts_message_survive() {
        let licence = parse(r#"{"state":"revoked","message":"Line one\nLine \"two\""}"#);
        assert_eq!(licence.message.as_deref(), Some("Line one\nLine \"two\""));
    }

    #[test]
    fn the_keys_are_found_whatever_order_they_arrive_in() {
        assert_eq!(parse(r#"{"enforced":true,"message":"x","state":"active"}"#).state, State::Active);
        assert!(parse(r#"{"enforced":true,"state":"active"}"#).enforced);
    }
}
