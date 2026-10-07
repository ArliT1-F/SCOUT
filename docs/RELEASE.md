# Cutting a SCOUT release

The artifact a user receives is **`SCOUT-Setup-<version>.exe`**: one wizard that installs the host
(and its own Node runtime), the control panel and overlay pages, the CS2 Game State Integration
config, the launcher, and the shortcuts to run them. `installer/README.md` describes what is inside
it and how `scripts/build-installer.mjs` builds, self-checks and packs it. This document is about
getting that file to the right people, and about what is *not* automated.

## Two ways to build it

| | |
| --- | --- |
| **By hand** | `npm run package:windows` on a Windows box with Node 20+, the Rust toolchain, the Tauri CLI and Inno Setup 6.3+. Output: `dist-installer\SCOUT-Setup-<version>.exe`. Version defaults to `package.json`; override with `node scripts/build-installer.mjs --version 0.4.1`. |
| **By the workflow** | `ci/release.yml` (copy it to `.github/workflows/` — see [`ci/README.md`](../ci/README.md) for why it is not there yet). Push a tag (`git tag v0.4.1 && git push origin v0.4.1`) or run the workflow by hand with a version. It installs the same toolchain, runs `cargo test` on the shell's decision logic, calls the same packaging script, writes `SHA256SUMS.txt`, uploads both as build artifacts, and creates (or updates) the GitHub release the file belongs to. |

The workflow changes nothing about the build: it runs `npm run package:windows` with a `--version`,
and that script refuses to produce an installer whose staged host does not answer the panel, the OBS
page and a GSI push.

## How the download reaches a dashboard

`/dashboard` shows the installer only to an approved account. Where the URL comes from, in order:

1. **A release published on the host** — the operator's **Operations** tab (`POST /api/ops/releases`).
   Publish a file that is on this machine (`public/download/SCOUT-Setup-0.4.1.exe` → served as
   `/download/SCOUT-Setup-0.4.1.exe`) or an external URL (a CDN, an object store, a GitHub release).
   The host counts the downloads it serves, so the Operations tab answers "how is the beta going".
2. **`SCOUT_DOWNLOAD_URL` on the host** — for a deployment that always points somewhere else.
3. **The repository's releases** — the default (`DEFAULT_DOWNLOAD_URL` in `server/beta.ts`), which is
   why a tag built by the workflow needs no configuration at all.

In hosted mode (`SCOUT_BETA_API_URL`) the account service owns the download; the one exception is a
release published on the host, which still wins, because that is the file the operator is standing
next to. Retiring a release (`DELETE /api/ops/releases/:version`) drops the dashboard back to the
next source, which is the rollback path: republish the previous version.

## Version numbers

- `--version 0.4.1` becomes the installer's version, `SCOUT-Setup-0.4.1.exe`, and the file name.
- The Inno Setup script gets a four-part `VersionInfoVersion` (`0.4.1.0`) derived from it; `-beta.2`
  style suffixes are accepted by the release registry (`VERSION_PATTERN`) and by the workflow.
- `package.json`'s version is only the fallback. Bump it when the repository itself is the release.

## Trust, signing and SmartScreen

The installer is **not code-signed**, so Windows will show "Windows protected your PC" until an
operator clicks through *More info → Run anyway*. That is stated on the landing page rather than
hidden, and every release carries `SHA256SUMS.txt` so a download can be checked:

```powershell
Get-FileHash .\SCOUT-Setup-0.4.1.exe -Algorithm SHA256
```

To sign a release, sign `scout-shell.exe` (and, if wanted, the whole staged tree) *before* packing —
`installer/README.md` says where that step belongs — or sign the finished installer afterwards with
an EV certificate. Signing does not change anything in this repository; it is a step on the machine
that builds.

## What is checked before a release goes out

- `ci/ci.yml` on every push (installed as `.github/workflows/ci.yml`): `tsc --noEmit`, `vite build`, `npm test` (host, panel,
  beta, licensing, operations and the account service), and `cargo test` for
  `src-tauri/core` — the geometry, the plan, the configuration parser and the licence parser.
- The packaging script's own smoke test: it starts the **staged** host and checks the panel, the OBS
  page and a synthetic GSI push before it invokes Inno Setup.
- The release workflow runs the shell tests again on Windows, because that is the platform the
  installer actually lands on.

What is *not* automated, and is worth doing by hand once per release on a real machine: install it,
confirm the shortcuts, confirm the launcher opens the operator panel and that `F8`/`F9`/`Ctrl+Shift+F8`
behave, and confirm a GSI push from CS2 shows up. `src-tauri/verify/run.sh` and the checklist in
`src-tauri/README.md` exist for the parts of the shell that only a Windows desktop can prove.
