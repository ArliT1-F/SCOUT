# Phase 0 — Repository audit and baseline

Baseline report for the phased implementation in [`INSTRUCTIONS.md`](INSTRUCTIONS.md).
Established on branch `arena/8b07f424-scout`, 2026-10-21, in a Linux checkout with Node 22.22.3 and
npm 10.9.8. Every command quoted under *Results* was actually run in this checkout; nothing is
claimed from the README alone.

---

## 0. Scope and method

Phase 0 is an audit only — no wholesale rewrite, no new backend, no desktop authorization changes.
Method: read the repository and its documentation end to end, identify the stack and every API/data
model, run the type-check, tests and build, run both application surfaces, drive one real account
flow over HTTP, and record findings before any Phase 1 work.

Two small fixes were made while establishing the baseline (see §8): the regression suite is now
self-contained on a clean checkout, and the README's run order/count was corrected. Nothing else was
changed.

---

## 1. Current stack and repository architecture

### Runtime and language

| Layer | Technology (verified in source) |
| --- | --- |
| Local broadcast host | Node 20+ (tested on 22), Express 4, `ws` WebSocket server, zod 3 — `server/index.ts`, run via `tsx` |
| Frontend / overlay | React 18 + TypeScript, Vite 6, Tailwind 3 + PostCSS, framer-motion, lucide-react — `src/`, built to `dist/` |
| Website | Same SPA (`src/site.tsx`, `src/platform-admin.tsx`) served by the **same server** under `SCOUT_SURFACE=site` (`server/website.ts`, `server/surface.ts`) |
| Account service | `server/account-service.ts` — one HTTP listener, SQLite via Node's own `node:sqlite`, no external DB dependency |
| Persistent state | JSON/JSONL files (no ORM on the host): `config/*.json`, `config/beta/store.json`, `config/platform/store.json`, `recordings/audit.jsonl`, `recordings/matches.json` — all gitignored where they hold secrets |
| Desktop runtime | Tauri v2 Windows shell (`src-tauri/`) — launcher GUI + transparent click-through overlay over the CS2 window; starts the bundled Node host itself |
| Windows packaging | `scripts/build-installer.mjs` → staged tree (panel build, `tsc` server build, Tauri shell, Node runtime, WebView2 bootstrapper, smoke test) → Inno Setup 6.3+ wizard `SCOUT-Setup-<version>.exe` (`installer/scout.iss`) |
| CI | `ci/ci.yml` + `ci/release.yml` (kept in `ci/` because the pushing token cannot create `.github/workflows/*`; copy documented in `ci/README.md`) |

### Deployment surfaces (locked by `docs/SURFACES.md`)

The one server has two personalities, selected by `SCOUT_SURFACE` (`server/surface.ts`):

1. **`site`** — `npm start` / `npm run website`. Public website only: `/welcome`, `/apply`, `/login`,
   `/download`, `/profile`, `/admin`, account APIs, owner platform APIs, `/api/platform/device/sync`,
   `/metrics`. Refuses `/app`, `/panel`, `/game`, `/obs`, `/gsi`, `/ws` and broadcast APIs.
2. **`host`** — `npm run dev` / `npm run host`. The venue broadcast host: control panel `/` + `/panel`,
   app dashboard `/app`, touch remote `/?remote=1`, transparent outputs `/obs` + `/game`, GSI receiver
   `POST /gsi`, WebSocket `/ws`, plus the account/proxy/lease/operator APIs.

### Architecture and dependency map (concise)

```
                         ┌──────────────────────────────────────────────┐
   Public internet ────► │  SCOUT_SURFACE=site  (npm start / website.ts) │
                         │  /welcome /apply /login /download /profile   │
                         │  /admin (owner desk) · /api/beta/* ·          │
                         │  /api/platform/* (admin settings, device sync)│
                         └───────────────┬──────────────────────────────┘
                                         │ REST (docs/BETA.md contract)
                                         ▼
                         ┌──────────────────────────────────────────────┐
                         │  Account plane                                │
                         │  · local mode: config/beta/store.json          │
                         │  · hosted: server/account-service.ts (SQLite)  │
                         │    passwords=scrypt, tokens=SHA-256 digests    │
                         └───────────────▲──────────────────────────────┘
                                         │ /api/beta/* proxy (cookies)
                         ┌───────────────┴──────────────────────────────┐
   CS2 (GSI POST) ─────► │  SCOUT_SURFACE=host  (npm run dev / host)     │
   OBS browser source ─► │  GSI ingest → state/sides/series → /ws snapshot│
                         │  /obs /game overlay · scenes · radar · replay  │
                         │  panel RBAC (auth.ts) + 45s control lease      │
                         │  operator tokens · audit JSONL · releases (ops)│
                         │  licence monitor (15 min check, 7-day grace)   │
                         │  platform sync agent (opt-in, 15 s poll)       │
                         └───────────────┬──────────────────────────────┘
                                         │ device code + installation token
                         ┌───────────────▼──────────────────────────────┐
                         │  Windows machine                              │
                         │  scout-shell.exe (Tauri v2) → starts host,     │
                         │  overlay window over CS2 (F8/F9), launcher GUI │
                         │  installer: Inno Setup + bundled Node runtime  │
                         └──────────────────────────────────────────────┘
```

Hard boundary rules already in the code (to preserve): marketing/site components never touch
broadcast state; the website never relays GSI/match/OBS traffic; local tournament operation keeps
working with the account plane unreachable (`LicenceMonitor` grace + `SCOUT_REQUIRE_LICENCE` off by
default).

---

## 2. Existing website routes and components

Site surface (`src/site.tsx`, `SITE_ROUTES`, enforced by `server/surface.ts` `websitePathAllowed`):

| Route | Component | Purpose | Auth |
| --- | --- | --- | --- |
| `/` | redirect → `/welcome` | | |
| `/welcome` | `LandingPage` | product page, HUD preview, scene tour, FAQ | public |
| `/apply` | `ApplyPage` | closed-beta application form | public |
| `/login` | `LoginPage` | sign-in, invite activation (`?invite=`), device-code approval (`?link=`), panel-token unlock | public |
| `/download` | `DownloadPage` + `DownloadCard` | installer for approved accounts | account |
| `/profile` | `ProfilePage` | account status, `LauncherLinkCard`, linked devices, sign out | account |
| `/admin` | `BetaApplicationsPanel`, `PlatformAdmin` (`src/platform-admin.tsx`) | owner desk: application decisions (copyable invite link), operations (health, releases, requests), platform settings (map rotation, application availability, limits, public stats) | owner (`SCOUT_OWNER_EMAIL`) |

Host surfaces (unchanged by Phase 0, listed for the compatibility map): `/app`, `/`, `/panel`,
`/?remote=1`, `/obs`, `/game`. Shared chrome: `SiteNav`, `SiteFooter`.

Accessibility/responsive work, SEO metadata and analytics (INSTRUCTIONS §3.4–3.6) are **not yet in
place** — Phase 1 scope.

---

## 3. Existing API contracts and data models

### HTTP/WS contracts (frozen; do not break)

- **Host REST + WS** — inventory in [`docs/API-AUDIT.md`](docs/API-AUDIT.md) (every route, its gate,
  and the two historical bypass findings that are now fixed and regression-tested). Includes
  `POST /gsi` (token-authenticated feed), `GET /api/status` + `WS /ws` (public match snapshot),
  `GET /api/session`, operator/lease/audit/releases, config/overlay/radars/layout, recordings,
  archive, remote control, OBS bridge.
- **Account REST** — [`docs/BETA.md`](docs/BETA.md) *“The REST contract a hosted service has to
  implement”* (`/status`, `/apply`, `/login`, `/logout`, `/activate`, `/applications[/:id]`,
  `/device/start|poll|approve|deny`, `/devices/revoke`, `/license/check`, `/healthz`), served
  locally by `LocalBetaService` or proxied 1:1 to `server/account-service.ts`. Types are exported
  from `server/beta.ts` and imported by the pages, so contract and UI cannot drift silently.
- **Platform sync** — `POST /api/platform/device/sync` (+ `/metrics`), `GET|PUT
  /api/platform/admin/settings`, tournament CRUD under `/api/platform/tournaments` (account-owned,
  cloud-side; the website is not a live tournament host).
- **Error shape** — `{error, code}` JSON, plus bare 403/401/429 where the gate denies. No stack
  traces or secrets in responses.

### Data models

| Store | Contents | Protection |
| --- | --- | --- |
| `config/beta/store.json` (local mode) | `BetaAccount` (status pending/approved/rejected, scrypt password digest, one invite digest + expiry), `BetaSession` (SHA-256 digest), `BetaGrant` (device code digest, user code, installation token digest) | mode 0600, atomic writes, gitignored |
| `config/beta/installation.json` | this installation's device id, account link, token | mode 0600, gitignored |
| account-service SQLite | `accounts`, `sessions`, `devices`, `grants`, `platform_settings`, `events` (`CREATE TABLE IF NOT EXISTS`; no schema-version table yet) | digests only; plaintext invite/installation token exist only until collected |
| `config/platform/store.json` | platform settings (versioned), per-account tournaments, metric logs, event-id dedup ranges, config receipts | local, atomic |
| `config/operators.json` | operator tokens (salted SHA-256 digests) | gitignored |
| `config/{teams,radars,operator,layout,overlay,obs}.json`, `recordings/audit.jsonl`, `recordings/matches.json` | broadcast config, audit trail (rotating JSONL, ≤2 MiB ×3), session archives | documented |

---

## 4. Existing authentication and authorization behavior

Two independent planes — keep them distinct:

1. **Panel/operator plane** (`server/auth.ts`): local-machine trust (loopback + non-rebindable Host),
   owner `SCOUT_PANEL_TOKEN` (printed once as a startup unlock link), operator tokens (roles
   owner/producer/designer/viewer with capabilities `control`, `match-edit`, `design`,
   `manage-operators`, `view-audit`), 12 h HttpOnly session cookie `scout_panel`, same-origin checks
   on mutations, per-address unlock lockout (5 fails / 10 min), case-sensitive routing (fix for the
   documented `/API/…` bypass). `server/lease.ts` is a **45-second in-memory broadcast-control mutex**
   (one producer at a time) — it is not an authorization lease in the INSTRUCTIONS §8 sense.
2. **Account plane** (`server/beta.ts` + `server/account-service.ts`): application → owner approval →
   one-time invite (SHA-256 digest, **14-day** expiry, single-use) → password set (scrypt, ≥10 chars)
   → account cookie `scout_account` (30 days, Secure behind TLS). Device-code launcher linking
   (RFC 8628 pattern; approval requires the account session, not the code), installation token
   handed to the launcher exactly once, unlink/revocation. `GET /api/beta/license` +
   `server/licensing.ts` (`LicenceMonitor`: 15-min checks, 7-day offline grace, states
   `active|pending|unlinked|revoked|unknown|offline`, enforcement opt-in via `SCOUT_REQUIRE_LICENCE` /
   `SCOUT_SHELL_REQUIRE_LINK`). Rate limits: 3 applications/address/hour, 8 failed sign-ins/15 min,
   ≤20 pending device codes (in-memory). Owner is `SCOUT_OWNER_EMAIL` only.

No public registration endpoint exists (spec-compliant). No password-recovery flow exists yet.

---

## 5. Current Windows development and packaging commands

| Command | What it does | Prerequisites |
| --- | --- | --- |
| `npm run shell:dev` / `npm run shell:build` | Tauri v2 dev/build for `src-tauri/` | Windows (target), Rust ≥1.77, `cargo install tauri-cli --version "^2"` |
| `npm run package:windows` | `node scripts/build-installer.mjs` → `dist-installer/SCOUT-Setup-<version>.exe` | Windows, Rust + Tauri CLI, Inno Setup 6.3+; stages panel build, `tsc -p tsconfig.build.json` server build, shell exe, Node runtime, WebView2 bootstrapper, **runs a staged-host smoke test**, then packs |
| `npm run shell:test` | `cargo test` for `src-tauri/core` (geometry, plan, config, licence parser) | Rust toolchain |
| `npm run shell:test:win32` | Win32 layer vs fake `user32` (`src-tauri/verify/run.sh`) | bash + Rust |
| `ci/release.yml` | Tag/dispatch → same packaging script on `windows-latest`, `SHA256SUMS.txt`, GitHub release | workflow must be copied into `.github/workflows/` first (`ci/README.md`) |

Installer facts: bundled Node runtime (no Node on the observer machine), data in `%APPDATA%\SCOUT`
(separated from the read-only program tree via `SCOUT_APP_ROOT`, `server/runtime.ts`), GUI required
(packaging refuses `--no-shell` installers), **not code-signed** (SmartScreen prompt documented),
downloads served to approved accounts per [`docs/RELEASE.md`](docs/RELEASE.md).

---

## 6. Current test, lint, type-check, and build commands

| Command | Purpose | Baseline result (2026-10-21) |
| --- | --- | --- |
| `npm ci` | install | OK |
| `npx tsc --noEmit` | type-check (server + src) | **pass** (exit 0, no output) |
| `npm run build` | `tsc --noEmit && vite build` | **pass** — known warnings only: framer-motion `"use client"` module directives, one >500 kB chunk (`dist/assets/index-*.js` ≈ 634 kB / 187 kB gzip) |
| `npm test` | `tsx --test tests/*.test.ts` | **327/327 pass** (≈45 s). Requires `dist/` for the one “real website” test — see §8 fix |
| `npm run shell:test` | Rust core tests | **not run — no Rust toolchain in this environment** |
| `npm run shell:test:win32` | fake-user32 Win32 tests | **not run — same** |
| lint | — | **none configured** (no ESLint/Prettier config in the repo) |

Minimal regression suite: **in place** — 327 tests across 44 files (`tests/`), covering the GSI
pipeline and schema hardening, sides/series/clock/radar/weapons, scenes and SSR rendering, layout
and mobile rendering, panel RBAC and the live-host gate (including the historical bypasses),
Companion/remote actions, event packs, replay, the whole closed-beta flow (`tests/beta.test.ts`),
licence states (`tests/licensing.test.ts`), the hosted account service driven over a real socket
(`tests/account-service.test.ts`), platform sync and the site/host boundary
(`tests/surface.test.ts`), installer packaging guards, and landing-page design checks.

## 7. Verified working flows (independently exercised in this audit)

1. Clean install → type-check → production build → full test suite green (after the §8 fix).
2. **Site surface** (`PORT=8123 SCOUT_SURFACE=site npm start`): `/` 302 → `/welcome`; 200 on
   `/welcome /apply /login /download /profile /admin /healthz /api/beta/status /api/surface`;
   404 on `/app /api/status /api/config` and `POST /gsi`.
3. **Host surface** (`PORT=8124 npm run dev`): 200 on `/ /panel /app /obs /game /api/status
   /api/config /api/session /healthz`; `POST /gsi` with the default token accepted and the packet
   reflected in `GET /api/status` (GSI ingest → state → snapshot chain works).
4. **Closed-beta application** over HTTP on the host: `POST /api/beta/apply` creates a *pending
   application only* (no account, no password material); duplicate submission refused with
   `already-applied`; store on disk holds no password for a pending applicant.
5. Automated flows already covered by the green suite (not re-driven by hand): full
   apply→approve→invite→activate→sign-in→device link→revoke lifecycle, expired/reused invites,
   login lockouts, the same lifecycle against the hosted account service, licence states and
   grace, platform rotation sync with offline retention, RBAC/Companion/lease behavior.

## 8. Confirmed defects, suspected defects, and unverified assumptions

### Confirmed defects (recorded separately from anything new)

| # | Defect | Status |
| --- | --- | --- |
| D1 | On a clean checkout `npm test` failed 1/327: `tests/surface.test.ts` (“real website…”) returns 500 for `/profile` because the production `dist/` does not exist yet; README even listed `npm test` *before* `npm run build`. | **Fixed in Phase 0**: the test builds `dist/` via `vite build` on demand when missing (verified by deleting `dist/` and re-running the suite). README run order corrected. |
| D2 | README *Scope and verification* claimed “319 passing tests”; the suite is 327. | **Fixed in Phase 0** (wording now cites the baseline count and date). |

### Suspected defects / high-risk areas (do not silently change; verify before touching)

- **GSI default token `CHANGE_ME`** is accepted when `GSI_TOKEN` is unset on a dev checkout — anyone
  on the venue LAN who knows it can push fake game state (`docs/API-AUDIT.md` residual risks).
- **No TLS** on the host; tokens are only as private as the network.
- **Public match snapshot** (`GET /api/status`, `WS /ws`) — by design, but anything sensitive must
  not enter match config.
- **Rate limits and the control lease are in-memory** — reset on host restart (documented).
- **Invitation expiry is a hardcoded 14 days** (`server/beta.ts` `grantInvite`) where INSTRUCTIONS
  §6 asks for a configurable expiry with a 24-hour default. Replacement invites do invalidate the
  previous digest (single-invite slot per account), which matches the spec.
- **No password recovery** and **no email delivery** (invite links are printed to console/CLI) —
  documented gaps (`docs/BETA.md`, `docs/ACCOUNT-SERVICE.md`), required by INSTRUCTIONS §4/§6.
- **Account-service schema has no version table** (`CREATE TABLE IF NOT EXISTS` only) — the docs
  themselves flag this as the first thing to add when the schema grows.
- **Installer is unsigned** (SmartScreen); release checksums exist (`SHA256SUMS.txt`) but **no client
  verifies hashes or signatures** — relevant for Phase 6.
- **Single long-lived installation token** — no rotation; revocation is per-device (Phase 4 gap).
- **Metrics** (`METRIC_KINDS`) are game-stat aggregates opt-in via `publicStatsEnabled`, not the
  privacy-analysed event stream of INSTRUCTIONS §3.6; no telemetry allowlist exists yet.

### Unverified assumptions (explicitly not tested here)

- Real CS2 observer/GOTV GSI at 20 Hz, radar calibration values, grenade type/effect-time vocabulary.
- Real OBS Browser Source alpha compositing and `obs-websocket` behavior.
- The Tauri shell compiled and running on Windows hardware (no Rust toolchain in this environment;
  `src-tauri` glue is type-checked against Tauri 2.12 docs only).
- Windows installer build, WebView2, path-with-spaces install, SmartScreen flow.
- Venue-network reliability and any production deployment of the account service.
- `ci/release.yml` has never executed here (workflow file only).

## 9. External services and credentials required for deployment

| Item | Used for | Present today? |
| --- | --- | --- |
| `SCOUT_OWNER_EMAIL` | owner gate for `/admin` + settings writes | env var (no secret) |
| `SCOUT_BETA_API_KEY` | host↔account-service service key (`Authorization: Bearer`) | env var, generated per deployment (`openssl rand -hex 24`) |
| `GSI_TOKEN` | CS2 GSI feed auth | env var (default `CHANGE_ME` must be replaced) |
| `SCOUT_PANEL_TOKEN` / operator tokens | panel access | env var or generated per run |
| `OBS_WS_PASSWORD` | OBS bridge | env var, optional |
| Hosting: website + account service with TLS (reverse proxy: nginx/Caddy documented) | platform | **deployment choice — unresolved** |
| Email/SMTP provider | invitations, password recovery | **not integrated — unresolved** (links are printed today) |
| GitHub Releases (default download) or CDN | installer distribution | default exists |
| Authenticode code-signing certificate | Windows trust | **absent — unresolved** |
| Update-manifest signing keys (offline, rotated) | Phase 6 updates | **absent — unresolved** |
| Backup target for SQLite (`sqlite3 .backup`) and JSON stores | ops | procedure documented for SQLite only |

## 10. Known gaps in automated and manual testing

- No ESLint/Prettier (style only; type-check is the gate today).
- No browser-based UI tests (no Playwright/browser binary in this environment; jsdom SSR checks
  only). Screenshot/visual regression not present (§17 allows functional-first).
- No §16 security-acceptance suite yet (those belong to Phases 2–6 as their features land).
- No migration/backup-restore test (no migration framework yet).
- Manual checklist that requires real Windows + CS2 + OBS is documented in README *Scope and
  verification* but has not been run in this checkout.
- Concurrent-acceptance races are tested in `tests/beta.test.ts`; lease/allowance races have **no
  code to test yet** (Phase 5).

---

## 11. Compatibility map — proposed platform model vs what exists

INSTRUCTIONS §10 entities against the current code (no duplicate tables will be created where an
equivalent exists):

| Proposed entity | Existing equivalent | Gap to add (later phases) |
| --- | --- | --- |
| `beta_applications` | `BetaAccount.status` pipeline (pending/approved/rejected) in JSON store + `accounts` table | split application history/review notes; DB-enforced one-pending-per-email (currently app-level) |
| `users` | `BetaAccount` (application row *becomes* the account) | profile fields, recovery tokens, suspension state |
| `user_roles` | owner = `SCOUT_OWNER_EMAIL`; panel roles are a separate plane | platform roles `USER/BETA_REVIEWER/ADMIN/OWNER`, granted only by owner, audit-logged |
| `account_invitations` | `BetaAccount.invite` {digest, expiresAt} — single-use, replaced on re-issue | configurable expiry (24 h default vs current hardcoded 14 d), delivery, resend endpoint |
| `installations` | `BetaDevice` + `Installation` (`installation.json`) | richer status views, server-enforced suspension interplay |
| `installation_credentials` | installation token (SHA-256 digest, handed out once) | rotation, expiry, per-credential revocation |
| `entitlements` | implicit (approved account) | explicit entitlement/versioning when leases need it |
| `offline_leases` | **none** (closest: `LicenceMonitor` cache; `ControlLease` is unrelated UI mutex) | signed leases (Phase 5) — greenfield |
| `tournament_sessions` | platform `Tournament` (cloud record) | stable local `tournament_session_id` for start accounting (Phase 5) |
| `offline_lease_consumptions` | **none** | durable journal, `UNIQUE(lease_id, tournament_session_id)` (Phase 5) |
| `releases` | `ReleaseRegistry` (version, file/url, notes, size, downloads) | artifact hashes, signed manifests, channels, staged rollout, withdrawal semantics (Phase 6) |
| `audit_logs` | `AuditTrail` (host JSONL) + account-service `events` | unified platform audit incl. role grants, no secret fields (extend in place) |
| `telemetry_events` | `MetricEvent` game aggregates + `RequestLog` | §3.6 allowlisted first-party events + documented retention (Phase 1 backend-capable, else later) |

INSTRUCTIONS §11 endpoints vs existing routes (new surface will be added **alongside** old ones per
Rule A; existing `/api/beta/*` is the frozen compatibility interface):

| Proposed | Existing | Note |
| --- | --- | --- |
| `POST /beta-applications` | `POST /api/beta/apply` | map/reuse; keep path |
| `GET /beta-applications/me` | `GET /api/beta/status` | partial |
| `POST /account-invitations/accept` | `POST /api/beta/activate` | reuse semantics |
| `POST /auth/login` / `/auth/logout` | `POST /api/beta/login` / `/api/beta/logout` | reuse |
| `POST /auth/password-recovery*` | — | **new** (with email delivery) |
| `GET /admin/beta-applications`, approve/reject | `GET /api/beta/applications`, `POST /api/beta/applications/:id` | exists (owner only) |
| `POST …/resend-invitation` | — | **new** |
| `POST /desktop/pairing-requests` etc. | `POST /api/beta/device/start|poll|approve|deny`, `POST /api/beta/devices/revoke` | exists; credential rotation **new** |
| `GET /desktop/me`, `GET /installations`, `DELETE /installations/{id}` | `GET /api/beta/link`, device list in `/api/beta/status`, `POST /api/beta/devices/revoke` | reshape behind adapters |
| `POST /desktop/leases/*`, `GET /desktop/leases/current` | — | **new** (Phase 5) |
| `GET /desktop/updates/*` | — | **new** (Phase 6); release publish/retire exists at `/api/ops/releases` |
| error codes (`ACCOUNT_PENDING`, `LEASE_EXHAUSTED`, …) | `{error, code}` with codes like `already-applied`, `bad-invite` | extend the envelope, keep old codes |

Existing functionality that must remain untouched through all phases: GSI ingestion and schema
hardening, `/obs` + `/game` rendering, scenes, radar, sides/series, replay studio, archives, panel
RBAC and the control lease, operator tokens, event packs, uploads, the installer data/program split,
the docs/BETA.md account REST contract, licence states and the “never gate a live broadcast” policy,
platform sync conflict rules, and the five-second GSI signal-loss behavior.

## 12. Testing plan (baseline) and compatibility rules for later phases

1. **Every phase**: `npx tsc --noEmit` → `npm run build` → `npm test`; Rust suites when a toolchain
   is available (`npm run shell:test`, `npm run shell:test:win32`); apply any migration to a
   representative store; re-run the site/host smoke in §7; keep old API contracts green.
2. **Phase 1+**: add functional UI tests where the jsdom harness exists; keep §17 lists as the
   standing regression checklist; browser/screenshot checks remain manual in this environment.
3. **Phases 2–6**: grow the §16 security-acceptance suite feature-by-feature (invite races, lease
   accounting, signature rejection, IDOR, rate limits, log-secret scanning) — never in one dump.
4. **Phase 7**: Windows/CS2/OBS manual checklist execution is a hard gate; automated tests here can
   never substitute (documented honestly).
5. Compatibility (Rule A): every schema/API change is expand → migrate → verify → contract in a
   later change; the desktop client never depends on an endpoint that is not deployed and tested in
   the same release (Rule B); incomplete features stay behind flags (Rule G).

## 13. Unresolved deployment choices (recorded, not invented)

- Email provider and template/branding for invitations + recovery; from-address and deliverability.
- Where the website and account service are hosted; domain names; TLS termination; backup storage.
- Whether “managed hosting” (INSTRUCTIONS §2.1) means the owner-managed VPS shape documented in
  `docs/ACCOUNT-SERVICE.md`, or a different managed platform — owner decision required before Phase 3
  email/infra work.
- Update-manifest signing: algorithm, key custody/rotation, who holds release-signing authority
  (must be separate from the metadata API), Authenticode certificate purchase or not.
- Update channels (stable/beta) and staged-rollout mechanism/percentages.
- Invitation expiry default (24 h per §6 vs 14 d current) and other policy values — to be made
  configurable server-side in Phase 3.
- Data retention/deletion policy and privacy policy text for the website (account deletion is a
  known gap in `docs/ACCOUNT-SERVICE.md`).
- Whether the account-service SQLite stays the production store under managed hosting or is
  migrated (Rule E applies; no migration framework exists yet).

---

## 14. Phase 0 results and next-phase prerequisites

**Scope executed:** audit only (+ two documentation/test-harness fixes). **Files changed:**
`docs/PHASE-0-BASELINE.md` (new), `tests/surface.test.ts` (self-build when `dist/` missing),
`README.md` (run order and test count).

**Results:** type-check clean; production build succeeds with known chunk-size warnings; **327/327
tests pass** after the harness fix (the pre-fix failure is recorded as D1); both surfaces and one
account flow verified live (§7); Rust/Windows suites explicitly not run here (no toolchain).

**Compatibility:** no source, API, schema, or behavior change to the product itself.

**Security:** no new surface; the audit's residual risks (§8) are inherited and documented.

**Remaining work / Phase 1 prerequisites:** none blocking. Phase 1 (website polish and functional
public flows) may start from this baseline: improve `LandingPage` clarity/CTAs and route correctness,
responsive/accessibility passes, SEO/metadata (`noindex` on private pages), form states, and validate
the existing closed-beta flow end-to-end — without rebuilding the backend (Phase 2) and without
touching host routes.
