#!/usr/bin/env bash
# Runs the *real* Windows branch of src/win32.rs — the raw pointers, the UTF-16 buffers, the EnumWindows callback —
# on Linux or macOS, against a fake user32 (fake_user32.rs) whose functions behave like Windows's own: buffer
# truncation and NUL terminator, EnumWindows stopping when the callback returns 0, GetClientRect anchored at (0,0).
# It needs only a Rust toolchain: no Windows, no CS2, no Tauri, no network.
#
#   bash src-tauri/verify/run.sh            (or: npm run shell:test:win32)
#
# On Windows itself the real user32 is used by the shell, so this script is not needed (and would clash with kernel32).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"
cp -r "$here/../core" "$work/core"
rm -rf "$work/core/target" "$work/core/Cargo.lock"
# The real source, minus what cannot live inside an `include!`d module body (inner doc comments) and the #[link]
# attributes (the fake functions are linked into the test binary instead of the DLLs).
grep -v -e '^ *#\[link(name = ' -e '^//!' "$here/../src/win32.rs" > "$work/src/win32_nolink.rs"
cp "$here/fake_user32.rs" "$work/src/fake.rs"
cat > "$work/Cargo.toml" <<'TOML'
[package]
name = "win32-verify"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
scout-shell-core = { path = "core" }
TOML
cat > "$work/src/lib.rs" <<'RS'
#![allow(dead_code)]
pub mod win32 {
    include!("win32_nolink.rs");
}
#[cfg(test)]
mod fake;
RS
cd "$work"
# `--cfg windows` makes the Windows branch compile here; recent rustc denies setting it by hand unless allowed.
RUSTFLAGS="--cfg windows -A explicit_builtin_cfgs_in_flags" cargo test --lib "$@"
