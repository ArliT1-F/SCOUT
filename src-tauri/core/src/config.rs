//! How the shell is configured: environment variables, overridden by command-line arguments, with every value
//! validated. A bad value never stops the shell — it is replaced by the default and reported in `warnings`.
use crate::geometry::Rect;

pub const DEFAULT_URL: &str = "http://127.0.0.1:8080/game";
/// CS2's window title. Matched exactly (case-insensitively), not as a substring: a browser tab called
/// "Counter-Strike 2 on Steam - Google Chrome" must not be mistaken for the game.
pub const DEFAULT_TITLE: &str = "Counter-Strike 2";
/// CS2 is an SDL application. The class is checked as well so a folder called "Counter-Strike 2" open in File
/// Explorer (class `CabinetWClass`) cannot be mistaken for the game either. An empty class matches any.
pub const DEFAULT_CLASS: &str = "SDL_app";
pub const DEFAULT_HOTKEY: &str = "F8";
/// Start the host that ships next to the launcher, when it is there and nothing is listening yet.
/// On by default: the installed launcher is the one icon an observer presses, and it should bring up
/// the whole of SCOUT rather than waiting for a console the observer was never told about. A dev
/// checkout has no host next to the executable, so nothing happens there; `--no-start-host` turns it
/// off for anyone who starts the host themselves.
pub const DEFAULT_START_HOST: bool = true;
/// The operator window is the panel of the host the shell is pointed at: the whole SCOUT control
/// surface, in a normal window of the launcher rather than a browser tab. On by default — that is the
/// point of a launcher — and `--no-panel` (or SCOUT_SHELL_PANEL=0) turns it off for overlay-only use.
pub const DEFAULT_PANEL_URL: &str = "http://127.0.0.1:8080/";
pub const DEFAULT_SHOW_PANEL: bool = true;
/// Shows and hides the operator window. Distinct from the overlay's toggle: the panel is a window to
/// work in, not something that follows the game.
pub const DEFAULT_PANEL_HOTKEY: &str = "F9";
/// A window that is hidden, click-through and has no taskbar button needs another way to be closed.
pub const DEFAULT_QUIT_HOTKEY: &str = "Ctrl+Shift+F8";
pub const DEFAULT_POLL_MS: u64 = 250;
pub const DEFAULT_HIDE_MS: u64 = 400;
pub const DEFAULT_RECT: Rect = Rect::new(0, 0, 1920, 1080);
const MAX_URL: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellConfig {
    /// The overlay page: the SCOUT host's `/game` route.
    pub url: String,
    pub title: String,
    pub class: String,
    pub hotkey: String,
    /// Quits the shell. Empty disables it (the shell can then only be closed from Task Manager).
    pub quit_hotkey: String,
    pub poll_ms: u64,
    /// How long the game must be out of the foreground before the overlay hides.
    pub hide_ms: u64,
    /// Development mode: cover `rect` permanently instead of following CS2.
    pub always: bool,
    /// Whether the shell opens the host's operator panel in a window of its own.
    pub panel: bool,
    /// The operator panel's address: the host root, derived from `url` unless it is set explicitly.
    pub panel_url: String,
    pub panel_hotkey: String,
    /// Start the host that ships next to the launcher (see `DEFAULT_START_HOST`).
    pub start_host: bool,
    /// Refuse to draw the overlay unless the host reports a licence that may run
    /// (`SCOUT_REQUIRE_LICENSE=1` style enforcement; off by default, see src-tauri/README.md).
    pub require_link: bool,
    /// The rectangle covered in `always` mode.
    pub rect: Rect,
    /// Things that were wrong with the configuration and were replaced by defaults.
    pub warnings: Vec<String>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_URL.into(),
            title: DEFAULT_TITLE.into(),
            class: DEFAULT_CLASS.into(),
            hotkey: DEFAULT_HOTKEY.into(),
            quit_hotkey: DEFAULT_QUIT_HOTKEY.into(),
            poll_ms: DEFAULT_POLL_MS,
            hide_ms: DEFAULT_HIDE_MS,
            always: false,
            panel: DEFAULT_SHOW_PANEL,
            panel_url: panel_url(DEFAULT_URL),
            panel_hotkey: DEFAULT_PANEL_HOTKEY.into(),
            start_host: DEFAULT_START_HOST,
            require_link: false,
            rect: DEFAULT_RECT,
            warnings: Vec::new(),
        }
    }
}

#[derive(Default)]
struct Raw {
    url: Option<String>,
    title: Option<String>,
    class: Option<String>,
    hotkey: Option<String>,
    quit_hotkey: Option<String>,
    poll: Option<String>,
    hide: Option<String>,
    always: Option<String>,
    rect: Option<String>,
    panel: Option<String>,
    panel_url: Option<String>,
    panel_hotkey: Option<String>,
    require_link: Option<String>,
    start_host: Option<String>,
}

impl ShellConfig {
    /// How many consecutive "the game is not in front" polls it takes to hide the overlay.
    pub fn hide_after_polls(&self) -> u32 {
        let poll = self.poll_ms.max(1);
        (self.hide_ms.saturating_add(poll - 1) / poll).clamp(1, u64::from(u32::MAX)) as u32
    }

    /// `args` excludes the program name. `env` looks up an environment variable.
    pub fn parse<I, E>(args: I, env: E) -> Self
    where
        I: IntoIterator<Item = String>,
        E: Fn(&str) -> Option<String>,
    {
        let mut warnings = Vec::new();
        let mut raw = Raw {
            url: env("SCOUT_URL"),
            title: env("SCOUT_SHELL_TITLE"),
            class: env("SCOUT_SHELL_CLASS"),
            hotkey: env("SCOUT_SHELL_HOTKEY"),
            quit_hotkey: env("SCOUT_SHELL_QUIT_HOTKEY"),
            poll: env("SCOUT_SHELL_POLL_MS"),
            hide: env("SCOUT_SHELL_HIDE_MS"),
            always: env("SCOUT_SHELL_ALWAYS"),
            rect: env("SCOUT_SHELL_RECT"),
            panel: env("SCOUT_SHELL_PANEL"),
            panel_url: env("SCOUT_SHELL_PANEL_URL"),
            panel_hotkey: env("SCOUT_SHELL_PANEL_HOTKEY"),
            require_link: env("SCOUT_SHELL_REQUIRE_LINK"),
            start_host: env("SCOUT_SHELL_START_HOST"),
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let (name, inline) = match arg.split_once('=') {
                Some((name, value)) if arg.starts_with("--") => (name.to_string(), Some(value.to_string())),
                _ => (arg.clone(), None),
            };
            if name == "--always" {
                raw.always = Some(inline.unwrap_or_else(|| "1".into()));
                continue;
            }
            // Boolean switches: `--panel` / `--no-panel`, `--require-link` / `--no-require-link`.
            // `--flag=0` and `--flag=no` work too, through the same `parse_bool` the environment uses.
            if let Some(value) = name.strip_prefix("--no-") {
                let slot = match value {
                    "panel" => Some(&mut raw.panel),
                    "require-link" => Some(&mut raw.require_link),
                    "start-host" => Some(&mut raw.start_host),
                    _ => None,
                };
                if let Some(slot) = slot {
                    *slot = Some(inline.unwrap_or_else(|| "0".into()));
                    continue;
                }
            }
            if name == "--panel" || name == "--require-link" || name == "--start-host" {
                let slot = match name {
                    "--panel" => &mut raw.panel,
                    "--start-host" => &mut raw.start_host,
                    _ => &mut raw.require_link,
                };
                *slot = Some(inline.unwrap_or_else(|| "1".into()));
                continue;
            }
            let slot = match name.as_str() {
                "--url" => &mut raw.url,
                "--title" => &mut raw.title,
                "--class" => &mut raw.class,
                "--hotkey" => &mut raw.hotkey,
                "--quit-hotkey" => &mut raw.quit_hotkey,
                "--poll" => &mut raw.poll,
                "--hide" => &mut raw.hide,
                "--rect" => &mut raw.rect,
                "--panel-url" => &mut raw.panel_url,
                "--panel-hotkey" => &mut raw.panel_hotkey,
                _ => {
                    warnings.push(format!("ignored unknown argument `{arg}`"));
                    continue;
                }
            };
            match inline.or_else(|| args.next()) {
                Some(value) => *slot = Some(value),
                None => warnings.push(format!("`{name}` needs a value")),
            }
        }

        let mut cfg = Self::default();
        if let Some(value) = raw.url {
            match validate_url(&value) {
                Ok(url) => cfg.url = url,
                Err(why) => warnings.push(format!("url `{}` ignored: {why}; using {DEFAULT_URL}", shorten(&value))),
            }
        }
        if let Some(value) = raw.title {
            let title = value.trim();
            if title.is_empty() || title.chars().count() > 200 {
                warnings.push(format!("window title must be 1-200 characters; using `{DEFAULT_TITLE}`"));
            } else {
                cfg.title = title.to_string();
            }
        }
        if let Some(value) = raw.class {
            let class = value.trim();
            if class.chars().count() > 100 {
                warnings.push(format!("window class is too long; using `{DEFAULT_CLASS}`"));
            } else {
                cfg.class = class.to_string();
            }
        }
        if let Some(value) = raw.hotkey {
            match validate_hotkey(&value) {
                Some(hotkey) => cfg.hotkey = hotkey,
                None => warnings.push(format!("hotkey `{}` ignored; using {DEFAULT_HOTKEY}", shorten(&value))),
            }
        }
        if let Some(value) = raw.quit_hotkey {
            if value.trim().is_empty() {
                cfg.quit_hotkey.clear();
            } else {
                match validate_hotkey(&value) {
                    Some(hotkey) => cfg.quit_hotkey = hotkey,
                    None => warnings.push(format!("quit hotkey `{}` ignored; using {DEFAULT_QUIT_HOTKEY}", shorten(&value))),
                }
            }
        }
        // One chord cannot both toggle and quit; the toggle wins, because an accidental quit ends the broadcast overlay.
        if cfg.quit_hotkey.eq_ignore_ascii_case(&cfg.hotkey) {
            warnings.push(format!("the quit hotkey `{}` is the same as the toggle hotkey; the quit hotkey is disabled", cfg.quit_hotkey));
            cfg.quit_hotkey.clear();
        }
        if let Some(value) = raw.poll {
            cfg.poll_ms = clamp_ms(&value, "poll interval", 50, 2000, DEFAULT_POLL_MS, &mut warnings);
        }
        if let Some(value) = raw.hide {
            cfg.hide_ms = clamp_ms(&value, "hide delay", 0, 5000, DEFAULT_HIDE_MS, &mut warnings);
        }
        if let Some(value) = raw.always {
            match parse_bool(&value) {
                Some(always) => cfg.always = always,
                None => warnings.push(format!("always `{}` is not a yes/no value; leaving it off", shorten(&value))),
            }
        }
        if let Some(value) = raw.panel {
            match parse_bool(&value) {
                Some(panel) => cfg.panel = panel,
                None => warnings.push(format!("panel `{}` is not a yes/no value; leaving it on", shorten(&value))),
            }
        }
        // Read before the value is moved: the default panel address is derived from the overlay
        // address at the end of this function, and only when nothing set it explicitly.
        let explicit_panel_url = raw.panel_url.is_some();
        if let Some(value) = raw.panel_url {
            match validate_url(&value) {
                Ok(url) => cfg.panel_url = url,
                Err(why) => warnings.push(format!("panel url `{}` ignored: {why}; using {}", shorten(&value), cfg.panel_url)),
            }
        }
        if let Some(value) = raw.panel_hotkey {
            if value.trim().is_empty() {
                cfg.panel_hotkey.clear();
            } else {
                match validate_hotkey(&value) {
                    Some(hotkey) => cfg.panel_hotkey = hotkey,
                    None => warnings.push(format!("panel hotkey `{}` ignored; using {DEFAULT_PANEL_HOTKEY}", shorten(&value))),
                }
            }
        }
        // One chord cannot do two things: the overlay toggle and the quit chord win over the panel
        // toggle, because losing the overlay (or the only way to quit) is worse than losing the panel.
        if !cfg.panel_hotkey.is_empty() && (cfg.panel_hotkey.eq_ignore_ascii_case(&cfg.hotkey) || cfg.panel_hotkey.eq_ignore_ascii_case(&cfg.quit_hotkey)) {
            warnings.push(format!("the panel hotkey `{}` is already used; the operator window opens on {DEFAULT_PANEL_HOTKEY} instead", cfg.panel_hotkey));
            cfg.panel_hotkey.clear();
        }
        if let Some(value) = raw.require_link {
            match parse_bool(&value) {
                Some(require) => cfg.require_link = require,
                None => warnings.push(format!("require-link `{}` is not a yes/no value; leaving it off", shorten(&value))),
            }
        }
        if let Some(value) = raw.start_host {
            match parse_bool(&value) {
                Some(start) => cfg.start_host = start,
                None => warnings.push(format!("start-host `{}` is not a yes/no value; leaving it on", shorten(&value))),
            }
        }
        // The default panel address follows the overlay address, unless it was set explicitly: an
        // operator pointing the shell at a host on another machine gets that machine's panel too.
        if !explicit_panel_url {
            cfg.panel_url = panel_url(&cfg.url);
        }
        if let Some(value) = raw.rect {
            match parse_rect(&value) {
                Some(rect) => cfg.rect = rect,
                None => warnings.push(format!(
                    "rect `{}` ignored (want x,y,width,height, at least {}px wide and high)",
                    shorten(&value),
                    Rect::MIN_SIDE
                )),
            }
        }
        cfg.warnings = warnings;
        cfg
    }
}

fn shorten(value: &str) -> String {
    let short: String = value.chars().take(60).collect();
    if value.chars().count() > 60 {
        format!("{short}…")
    } else {
        short
    }
}

fn clamp_ms(value: &str, what: &str, min: u64, max: u64, default: u64, warnings: &mut Vec<String>) -> u64 {
    match value.trim().parse::<u64>() {
        Ok(ms) if (min..=max).contains(&ms) => ms,
        Ok(ms) => {
            let clamped = ms.clamp(min, max);
            warnings.push(format!("{what} {ms} ms is outside {min}-{max} ms; using {clamped}"));
            clamped
        }
        Err(_) => {
            warnings.push(format!("{what} `{}` is not a number of milliseconds; using {default}", shorten(value)));
            default
        }
    }
}

pub fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" | "" => Some(false),
        _ => None,
    }
}

/// `x,y,width,height`, and a size the overlay can actually use.
pub fn parse_rect(value: &str) -> Option<Rect> {
    let parts: Vec<&str> = value.split(',').map(str::trim).collect();
    if parts.len() != 4 {
        return None;
    }
    let rect = Rect::new(parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?, parts[3].parse().ok()?);
    rect.is_usable().then_some(rect)
}

/// A key name the global-shortcut plugin can parse, e.g. `F8` or `Ctrl+F8`. The plugin has the last word; this
/// only keeps obvious garbage out.
pub fn validate_hotkey(value: &str) -> Option<String> {
    let hotkey = value.trim();
    let ok = !hotkey.is_empty()
        && hotkey.chars().count() <= 40
        && hotkey.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '_' | ' '));
    ok.then(|| hotkey.to_string())
}

/// An `http(s)://` address made only of printable ASCII, with a host. Whether it is *reachable* is decided later.
pub fn validate_url(value: &str) -> Result<String, String> {
    let url = value.trim();
    if url.len() > MAX_URL {
        return Err("it is longer than 2048 characters".into());
    }
    if !url.chars().all(|c| c.is_ascii_graphic()) {
        return Err("it contains spaces, control or non-ASCII characters".into());
    }
    if host_port(url).is_none() {
        return Err("it is not an http:// or https:// address with a host".into());
    }
    Ok(url.to_string())
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

/// The host and port of an `http(s)` URL, with the scheme's default port when none is given. Just enough to
/// ask "is anything listening there yet?"; the real URL is parsed by Tauri when navigating.
pub fn host_port(url: &str) -> Option<(String, u16)> {
    let (default_port, rest) = match strip_prefix_ci(url, "http://") {
        Some(rest) => (80, rest),
        None => (443, strip_prefix_ci(url, "https://")?),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    if let Some(inside) = authority.strip_prefix('[') {
        let (host, tail) = inside.split_once(']')?;
        let port = if tail.is_empty() { default_port } else { tail.strip_prefix(':')?.parse().ok()? };
        return (!host.is_empty()).then(|| (host.to_string(), port));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (authority, default_port),
    };
    (!host.is_empty()).then(|| (host.to_string(), port))
}

/// The host's operator panel address, derived from the overlay address: same scheme, same host, same
/// port, root path. `http://127.0.0.1:8080/game` → `http://127.0.0.1:8080/`, and a host behind a path
/// prefix keeps it. Query and fragment are dropped: the panel route is the root of the host.
pub fn panel_url(overlay_url: &str) -> String {
    let url = overlay_url.trim();
    let Some(scheme_end) = url.find("://") else { return DEFAULT_PANEL_URL.into() };
    let after_scheme = &url[scheme_end + 3..];
    let end = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
    if after_scheme.is_empty() {
        return DEFAULT_PANEL_URL.into();
    }
    let authority = &after_scheme[..end];
    if authority.is_empty() {
        return DEFAULT_PANEL_URL.into();
    }
    format!("{}://{}/", &url[..scheme_end], authority)
}

/// Exact, case-insensitive title match.
pub fn title_matches(actual: &str, wanted: &str) -> bool {
    actual.trim().eq_ignore_ascii_case(wanted.trim())
}

/// A wanted class of "" matches any window class.
pub fn class_matches(actual: &str, wanted: &str) -> bool {
    let wanted = wanted.trim();
    wanted.is_empty() || actual.trim().eq_ignore_ascii_case(wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str], env: &[(&str, &str)]) -> ShellConfig {
        let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ShellConfig::parse(args.iter().map(|a| a.to_string()), move |key| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()))
    }

    #[test]
    fn with_nothing_configured_it_follows_cs2_and_shows_the_local_host() {
        let cfg = parse(&[], &[]);
        assert_eq!(cfg, ShellConfig::default());
        assert_eq!(
            (cfg.url.as_str(), cfg.title.as_str(), cfg.class.as_str(), cfg.hotkey.as_str()),
            (DEFAULT_URL, "Counter-Strike 2", "SDL_app", "F8")
        );
        assert!(!cfg.always && cfg.warnings.is_empty());
    }

    #[test]
    fn the_environment_configures_and_arguments_override_it() {
        let cfg = parse(
            &["--url", "http://10.0.0.7:8080/game", "--poll=100"],
            &[("SCOUT_URL", "http://127.0.0.1:9000/game"), ("SCOUT_SHELL_POLL_MS", "500"), ("SCOUT_SHELL_HOTKEY", "F9")],
        );
        assert_eq!(cfg.url, "http://10.0.0.7:8080/game", "the argument wins over SCOUT_URL");
        assert_eq!(cfg.poll_ms, 100, "--key=value works as well as --key value");
        assert_eq!(cfg.hotkey, "F9", "an environment-only value is used");
        assert!(cfg.warnings.is_empty(), "{:?}", cfg.warnings);
    }

    #[test]
    fn every_option_can_be_set() {
        let cfg = parse(
            &["--always", "--title", "  My Game ", "--class", "", "--hide", "800", "--rect", "10, 20, 1280, 720", "--hotkey", "Ctrl+F8"],
            &[],
        );
        assert!(cfg.always);
        assert_eq!((cfg.title.as_str(), cfg.class.as_str()), ("My Game", ""));
        assert_eq!(cfg.hide_ms, 800);
        assert_eq!(cfg.rect, Rect::new(10, 20, 1280, 720));
        assert_eq!(cfg.hotkey, "Ctrl+F8");
        assert!(cfg.warnings.is_empty(), "{:?}", cfg.warnings);
    }

    #[test]
    fn bad_values_fall_back_to_the_default_and_say_so_instead_of_stopping_the_shell() {
        let cfg = parse(
            &[
                "--url",
                "javascript:alert(1)",
                "--poll",
                "fast",
                "--hide",
                "9999999",
                "--rect",
                "1,2,3",
                "--hotkey",
                "F8; rm -rf",
                "--always=maybe",
                "--title",
                "   ",
                "--bogus",
            ],
            &[],
        );
        assert_eq!(cfg.url, DEFAULT_URL);
        assert_eq!(cfg.poll_ms, DEFAULT_POLL_MS);
        assert_eq!(cfg.hide_ms, 5000, "out of range is clamped, not rejected");
        assert_eq!(cfg.rect, DEFAULT_RECT);
        assert_eq!(cfg.hotkey, DEFAULT_HOTKEY);
        assert!(!cfg.always);
        assert_eq!(cfg.title, DEFAULT_TITLE);
        assert_eq!(cfg.warnings.len(), 8, "{:#?}", cfg.warnings);
        assert!(cfg.warnings.iter().any(|w| w.contains("unknown argument `--bogus`")));
    }

    #[test]
    fn an_option_missing_its_value_is_reported_and_the_rest_still_apply() {
        let cfg = parse(&["--poll", "100", "--url"], &[]);
        assert_eq!(cfg.poll_ms, 100);
        assert!(cfg.warnings.iter().any(|w| w.contains("`--url` needs a value")), "{:?}", cfg.warnings);
    }

    #[test]
    fn garbage_of_any_shape_never_panics() {
        let junk = [
            "",
            " ",
            "--",
            "---",
            "=",
            "--=",
            "--url=",
            "--rect=,,,",
            "--poll=-5",
            "--poll=1e3",
            "\u{0}",
            "ünïcödé",
            "--hotkey=\u{202e}",
            &"x".repeat(100_000),
        ];
        for value in junk {
            let _ = parse(
                &[
                    "--url", value, "--title", value, "--class", value, "--hotkey", value, "--poll", value, "--hide", value, "--rect",
                    value, "--always", value,
                ],
                &[],
            );
            let _ = parse(&[value], &[("SCOUT_URL", value), ("SCOUT_SHELL_RECT", value), ("SCOUT_SHELL_ALWAYS", value)]);
            let _ = host_port(value);
            let _ = validate_url(value);
            let _ = parse_rect(value);
        }
    }

    #[test]
    fn the_shell_can_be_quit_from_the_keyboard_and_that_can_be_changed_or_turned_off() {
        assert_eq!(parse(&[], &[]).quit_hotkey, "Ctrl+Shift+F8");
        assert_eq!(parse(&["--quit-hotkey", "Ctrl+Alt+Q"], &[]).quit_hotkey, "Ctrl+Alt+Q");
        assert_eq!(parse(&[], &[("SCOUT_SHELL_QUIT_HOTKEY", "Ctrl+Alt+Z")]).quit_hotkey, "Ctrl+Alt+Z");
        assert_eq!(parse(&["--quit-hotkey="], &[]).quit_hotkey, "", "an empty value turns it off");
        assert_eq!(parse(&["--quit-hotkey", "  "], &[]).quit_hotkey, "");
        let bad = parse(&["--quit-hotkey", "F8;"], &[]);
        assert_eq!(bad.quit_hotkey, DEFAULT_QUIT_HOTKEY);
        assert!(bad.warnings.iter().any(|w| w.contains("quit hotkey")), "{:?}", bad.warnings);
    }

    #[test]
    fn one_chord_never_both_toggles_and_quits() {
        let cfg = parse(&["--hotkey", "ctrl+shift+f8"], &[]);
        assert_eq!(cfg.hotkey, "ctrl+shift+f8");
        assert_eq!(cfg.quit_hotkey, "", "the toggle wins over the default quit chord");
        assert!(cfg.warnings.iter().any(|w| w.contains("same as the toggle")), "{:?}", cfg.warnings);
        let both = parse(&["--hotkey", "F9", "--quit-hotkey", "F9"], &[]);
        assert_eq!((both.hotkey.as_str(), both.quit_hotkey.as_str()), ("F9", ""));
    }

    #[test]
    fn poll_and_hide_delays_are_kept_in_a_sane_range() {
        assert_eq!(parse(&["--poll", "10"], &[]).poll_ms, 50, "polling faster than this only burns CPU");
        assert_eq!(parse(&["--poll", "60000"], &[]).poll_ms, 2000, "and slower makes F8 and alt-tab feel broken");
        assert_eq!(parse(&["--hide", "0"], &[]).hide_ms, 0);
    }

    #[test]
    fn the_hide_delay_becomes_a_whole_number_of_polls_of_at_least_one() {
        let cfg = |poll, hide| ShellConfig { poll_ms: poll, hide_ms: hide, ..ShellConfig::default() };
        assert_eq!(cfg(250, 400).hide_after_polls(), 2);
        assert_eq!(cfg(250, 500).hide_after_polls(), 2);
        assert_eq!(cfg(250, 501).hide_after_polls(), 3);
        assert_eq!(cfg(250, 0).hide_after_polls(), 1, "never zero: at least one poll has to say so");
        assert_eq!(cfg(100, 400).hide_after_polls(), 4);
        assert_eq!(cfg(2000, 5000).hide_after_polls(), 3);
        assert_eq!(cfg(0, u64::MAX).hide_after_polls(), u32::MAX, "no overflow even with nonsense");
    }

    #[test]
    fn the_operator_window_is_on_by_default_and_can_be_turned_off() {
        let cfg = parse(&[], &[]);
        assert!(cfg.panel, "a launcher shows the panel; that is what it is for");
        assert_eq!(cfg.panel_hotkey, "F9");
        assert_eq!(cfg.panel_url, "http://127.0.0.1:8080/");
        assert!(!parse(&["--no-panel"], &[]).panel);
        assert!(!parse(&["--panel=0"], &[]).panel);
        assert!(!parse(&[], &[("SCOUT_SHELL_PANEL", "off")]).panel);
        assert!(parse(&["--panel"], &[("SCOUT_SHELL_PANEL", "0")]).panel, "the command line wins over the environment");
        assert!(parse(&["--panel=maybe"], &[]).panel, "a value that is not a yes/no leaves it on");
        assert!(parse(&["--panel=maybe"], &[]).warnings.iter().any(|w| w.contains("panel")));
    }

    #[test]
    fn the_panel_address_follows_the_overlay_address_and_can_be_overridden() {
        assert_eq!(parse(&["--url", "http://10.0.0.7:9000/game"], &[]).panel_url, "http://10.0.0.7:9000/");
        assert_eq!(parse(&["--url", "https://scout.example.com/game"], &[]).panel_url, "https://scout.example.com/");
        assert_eq!(parse(&["--url", "http://[::1]:8080/game?x=1"], &[]).panel_url, "http://[::1]:8080/");
        assert_eq!(parse(&["--url", "http://host:8080/obs"], &[("SCOUT_SHELL_PANEL_URL", "http://host:8080/")]).panel_url, "http://host:8080/");
        assert_eq!(parse(&["--panel-url", "http://192.168.1.5:8080/"], &[]).panel_url, "http://192.168.1.5:8080/");
        let bad = parse(&["--panel-url", "javascript:alert(1)"], &[]);
        assert_eq!(bad.panel_url, "http://127.0.0.1:8080/");
        assert!(bad.warnings.iter().any(|w| w.contains("panel url")), "{:?}", bad.warnings);
        for (url, expected) in [
            ("http://127.0.0.1:8080/game", "http://127.0.0.1:8080/"),
            ("https://host/game", "https://host/"),
            ("http://host", "http://host/"),
            ("http://host:8080/", "http://host:8080/"),
            ("http://user:pw@host:8080/game", "http://user:pw@host:8080/"),
        ] {
            assert_eq!(panel_url(url), expected, "{url}");
        }
        for broken in ["", "not a url", "http://", "http:///game", "host:8080/game"] {
            assert_eq!(panel_url(broken), DEFAULT_PANEL_URL, "{broken:?}");
        }
    }

    #[test]
    fn the_launcher_starts_the_host_next_to_it_unless_told_not_to() {
        // The installed launcher is the one icon an observer presses, so this defaults on and is
        // quietly irrelevant in a checkout (no host sits next to the executable there - main.rs
        // checks that before it spawns anything).
        assert!(parse(&[], &[]).start_host);
        assert!(!parse(&["--no-start-host"], &[]).start_host);
        assert!(!parse(&["--start-host=off"], &[]).start_host);
        assert!(!parse(&[], &[("SCOUT_SHELL_START_HOST", "0")]).start_host);
        assert!(parse(&["--start-host"], &[("SCOUT_SHELL_START_HOST", "no")]).start_host, "the command line wins over the environment");
        let unclear = parse(&["--start-host=perhaps"], &[]);
        assert!(unclear.start_host);
        assert!(unclear.warnings.iter().any(|w| w.contains("start-host")), "{:?}", unclear.warnings);
    }

    #[test]
    fn the_link_requirement_is_opt_in_and_never_steals_another_hotkey() {
        assert!(!parse(&[], &[]).require_link, "the broadcast is never gated by default");
        assert!(parse(&["--require-link"], &[]).require_link);
        assert!(parse(&[], &[("SCOUT_SHELL_REQUIRE_LINK", "1")]).require_link);
        assert!(!parse(&["--no-require-link"], &[("SCOUT_SHELL_REQUIRE_LINK", "yes")]).require_link);
        assert!(!parse(&["--require-link=maybe"], &[]).require_link);
        let clash = parse(&["--panel-hotkey", "F8"], &[]);
        assert_eq!(clash.panel_hotkey, "", "the overlay toggle keeps F8");
        assert!(clash.warnings.iter().any(|w| w.contains("panel hotkey")), "{:?}", clash.warnings);
        let quit_clash = parse(&["--panel-hotkey", "Ctrl+Shift+F8"], &[]);
        assert_eq!(quit_clash.panel_hotkey, "");
        assert_eq!(parse(&["--panel-hotkey", "Ctrl+Alt+P"], &[]).panel_hotkey, "Ctrl+Alt+P");
        assert_eq!(parse(&["--panel-hotkey="], &[]).panel_hotkey, "", "an empty value turns the hotkey off");
        assert_eq!(parse(&[], &[]).panel_hotkey, DEFAULT_PANEL_HOTKEY);
    }

    #[test]
    fn booleans_accept_the_usual_spellings() {
        for yes in ["1", "true", "TRUE", " yes ", "On"] {
            assert_eq!(parse_bool(yes), Some(true), "{yes}");
        }
        for no in ["0", "false", "No", "off", ""] {
            assert_eq!(parse_bool(no), Some(false), "{no:?}");
        }
        assert_eq!(parse_bool("maybe"), None);
    }

    #[test]
    fn a_rectangle_needs_four_numbers_and_a_usable_size() {
        assert_eq!(parse_rect("0,0,1920,1080"), Some(Rect::new(0, 0, 1920, 1080)));
        assert_eq!(parse_rect(" -1920 , 0 , 1920 , 1080 "), Some(Rect::new(-1920, 0, 1920, 1080)));
        for bad in ["", "1,2,3", "1,2,3,4,5", "a,b,c,d", "0,0,10,10", "0,0,-5,1080", "0,0,1920", "0,0,1920,1080,"] {
            assert_eq!(parse_rect(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_plain_http_addresses_with_a_host_are_accepted_as_the_overlay_url() {
        for good in [
            "http://127.0.0.1:8080/game",
            "https://overlay.example.com/game?x=1#top",
            "HTTP://LOCALHOST:8080/game",
            "http://[::1]:8080/game",
            "http://user:pw@host/game",
            "http://10.0.0.7",
        ] {
            assert!(validate_url(good).is_ok(), "{good}");
        }
        assert_eq!(validate_url("  http://host/game  ").unwrap(), "http://host/game", "surrounding space is trimmed");
        for bad in [
            "",
            "host:8080/game",
            "ftp://host/game",
            "file:///c:/x",
            "javascript:alert(1)",
            "data:text/html,hi",
            "http://",
            "http:///game",
            "http://:8080/",
            "http://host:notaport/",
            "http://host/ga me",
            "http://host/\u{e9}",
            "http://host/a\nb",
            "http://host/a\tb",
            "https://",
        ] {
            assert!(validate_url(bad).is_err(), "{bad:?}");
        }
        assert!(validate_url(&format!("http://h/{}", "a".repeat(2048))).is_err(), "over-long");
    }

    #[test]
    fn the_host_and_port_come_out_of_an_address_with_the_schemes_default_port() {
        assert_eq!(host_port("http://127.0.0.1:8080/game"), Some(("127.0.0.1".into(), 8080)));
        assert_eq!(host_port("http://localhost/game"), Some(("localhost".into(), 80)));
        assert_eq!(host_port("https://overlay.example.com/game"), Some(("overlay.example.com".into(), 443)));
        assert_eq!(host_port("http://[::1]:8080/game"), Some(("::1".into(), 8080)));
        assert_eq!(host_port("http://[fe80::1]/game"), Some(("fe80::1".into(), 80)));
        assert_eq!(
            host_port("http://user:secret@10.0.0.7:9000/x"),
            Some(("10.0.0.7".into(), 9000)),
            "credentials are not part of the host"
        );
        assert_eq!(host_port("http://host?x=1"), Some(("host".into(), 80)));
        assert_eq!(host_port("http://host#frag"), Some(("host".into(), 80)));
        assert_eq!(host_port("HtTp://Host:81"), Some(("Host".into(), 81)));
        for bad in
            ["", "http://", "http://:80", "http://[::1", "http://[]:80", "http://host:99999", "http://host:-1", "mailto:a@b", "ws://host"]
        {
            assert_eq!(host_port(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn hotkeys_are_plain_key_names_with_optional_modifiers() {
        for good in ["F8", "f8", " F9 ", "Ctrl+F8", "CmdOrControl+Shift+K", "Alt+Shift+F12"] {
            assert!(validate_hotkey(good).is_some(), "{good}");
        }
        assert_eq!(validate_hotkey("  F8 ").as_deref(), Some("F8"));
        for bad in ["", "   ", "F8;", "Ctrl+", "a\nb", "F8'", &"F".repeat(41)] {
            // "Ctrl+" is syntactically plain; the plugin rejects it later, so it is allowed through here.
            if bad == "Ctrl+" {
                assert!(validate_hotkey(bad).is_some());
            } else {
                assert!(validate_hotkey(bad).is_none(), "{bad:?}");
            }
        }
    }

    #[test]
    fn the_game_window_is_recognised_by_its_exact_title_and_class() {
        assert!(title_matches("Counter-Strike 2", DEFAULT_TITLE));
        assert!(title_matches("  counter-strike 2 ", DEFAULT_TITLE));
        assert!(!title_matches("Counter-Strike 2 on Steam - Google Chrome", DEFAULT_TITLE), "a browser tab is not the game");
        assert!(!title_matches("Counter-Strike 2 - Notepad", DEFAULT_TITLE));
        assert!(!title_matches("", DEFAULT_TITLE));
        assert!(class_matches("SDL_app", DEFAULT_CLASS));
        assert!(class_matches("sdl_app", DEFAULT_CLASS), "window class names are case-insensitive");
        assert!(!class_matches("CabinetWClass", DEFAULT_CLASS), "a folder called Counter-Strike 2 in Explorer is not the game");
        assert!(class_matches("anything at all", ""), "an empty class means any class");
        assert!(class_matches("", "  "));
    }
}
