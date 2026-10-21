# Phase 1 — Website polish and functional public flows

Phase report per [`INSTRUCTIONS.md`](INSTRUCTIONS.md) §18. Baseline: [`PHASE-0-BASELINE.md`](PHASE-0-BASELINE.md).
Completed 2026-10-21 on branch `arena/8b07f424-scout`.

## 1. Scope — what changed and why

Phase 1 only touches the public website surfaces (`src/site.tsx`, `src/landing.css`, `src/style.css`
site rules, `index.html`), their tests, and documentation. **No server route, API contract, account
store, host behavior, or desktop code was modified** — the backend is rebuilt in Phase 2, as ordered.

| INSTRUCTIONS | Change |
| --- | --- |
| §3.1 primary message | Hero lead now opens with the recommended **“A better broadcast for every CS2 tournament.”** (existing headline identity kept). |
| §3.1 CTAs | Primary hero action is **Join the Closed Beta** (→ `/apply`); **Get SCOUT** (→ `/download`) appears only for a signed-in account; secondary jumps to the real interactive scene tour (`#scenes`) — labelled “Explore the live demo”, not a video we do not have. Nav CTA follows the same language. |
| §3.1 map showcase | The oversized nine-tile strip is now a focused 2×2 selection with an accessible **“Show all nine maps”** disclosure (`aria-expanded`); the full pool is one click away. |
| §3.1 assets | Marketing artwork optimized (ImageMagick, lossless resample at ≥2× display size + strip): `oceanic-deag` 1.0 MB→180 KB, `ak-47` 832 KB→144 KB, `cs2` 608 KB→520 KB, `m4a1-s` 276 KB→88 KB (**≈2.7 MB→932 KB, −65 %**). Thumbs get `width`/`height` (no layout shift). Artwork itself unchanged (verified visually). |
| §3.2 navigation & routes | Two misleading CTAs fixed: the **“Open the app dashboard” `/app` link** and the **“served by your host” card** now render only when `/api/surface` reports a real broadcast host — on the public website `/app` is a 404 and the card was wrong. New **`/privacy`** page (footer links); every nav/footer link points at a route or anchor that exists. |
| §3.3 application form | Client validation mirroring the server (name ≥ 2, email shape — `server/beta.ts` stays authoritative), per-field errors with `aria-invalid` + `aria-describedby`, `required` semantics with `noValidate` (own messages), optional-field hint, `aria-busy` on submit. Distinct **validation / rate-limit (429) / server-error (5xx) / server-message** outcomes in the error notice (`role="alert"`). |
| §3.4 responsive & a11y | Existing pinned guarantees kept (reduced-motion, focus-visible, 320 px grids, phone drawer); new controls inherit them; thumbs carry intrinsic dimensions; privacy table is phone-safe. |
| §3.5 SEO & metadata | `index.html` gains Open Graph + Twitter card + canonical + `robots` defaults (public). `PAGE_META`/`useDocumentMeta` set per-route title, description, canonical and robots; **`noindex`** on `/login`, `/download`, `/profile`, `/admin` and the moved-dashboard page. |
| §3.6 analytics | **No third-party trackers added** (none exist). The `/privacy` page documents exactly what is collected today (application/account data, in-memory request summaries, security counters, opt-in aggregate metrics) with retention/deletion, and publishes the **first-party event allowlist** as the contract future telemetry must obey — every entry currently marked *not collected* and pinned that way by a test. Actual event collection is deferred: the backend has no telemetry endpoint or consent model yet (Phase 2+). |

## 2. Dependencies

Only the Phase 0 baseline (working build + green suite). No later-phase dependency was introduced.

## 3. Files and components

- `src/site.tsx` — `PAGE_META`, `useDocumentMeta`, `useSurface`, `PrivacyPage`, `ANALYTICS_EVENT_ALLOWLIST`,
  `validateApplication`, hero/nav/footer copy and CTAs, map-showcase disclosure, apply-form states
  and a11y wiring, host-only gating on `/app` and the host card, `/privacy` in `SITE_ROUTES`/router.
- `src/platform-admin.tsx` — owner desk sets its own `noindex` title/meta (kept local to avoid a
  deeper `site.tsx`↔`platform-admin.tsx` import cycle).
- `index.html` — OG/Twitter/canonical/robots metadata.
- `src/landing.css`, `src/style.css` — map disclosure, allowlist table, lead emphasis, field
  error/hint styles.
- `tests/site-public.test.ts` (new), `tests/site-preview.test.ts`, `tests/landing-design.test.ts` —
  updated pins for the focused showcase and new guarantees.
- `public/assets/*.png` — optimized in place.
- Docs: `README.md`, `docs/SURFACES.md`, `docs/BETA.md`, this report.

## 4. Implementation notes

- **Surface detection** uses the existing `GET /api/surface` (no API change): `BetaStatusView.host`
  is a machine hostname on both surfaces and could not distinguish them — recorded here because the
  host-only gating depends on the surface answer, not on the hostname.
- The map showcase change deliberately revises the old test’s “nine tiles, one strip” design pin —
  INSTRUCTIONS §3.1 explicitly requires the focused selection; the pool of nine is unchanged and
  still fully reachable and asserted against disk.

## 5. Tests — commands executed

```sh
npx tsc --noEmit          # pass
npm test                  # 333/333 pass (was 327; +6 Phase 1 tests)
npm run build             # pass (same known framer-motion / >500 kB chunk warnings as baseline)
```

New/updated coverage: metadata map completeness and `noindex` on private routes; hero message and
CTA honesty; `validateApplication` parity with the server; apply-form a11y wiring; no `/app` link in
website markup; privacy page + allowlist guarantees; `index.html` social metadata; focused map
showcase with the reveal control (all nine maps still on disk and in `MAP_POOL`).

Live smoke (site surface, `PORT=8125 SCOUT_SURFACE=site npm start`): 200 on
`/welcome /apply /login /download /profile /privacy /admin /healthz`, OG/robots tags present in the
shell, `/app /game /api/status` still 404. Beta application error paths (duplicate `already-applied`,
`bad-email`, `bad-name`, 429 `throttled`) are covered green in `tests/beta.test.ts` and
`tests/account-service.test.ts`, and the form now maps them to distinct actionable messages.

## 6. Compatibility

- Zero API-contract changes; all `/api/beta/*` behavior untouched (Rule A: nothing contracted).
- Host/panel/GSI/OBS surfaces and desktop flows untouched: no file under `server/` or `src-tauri/`
  changed, and the full pre-existing suite (327 tests) stayed green alongside the new ones.
- `SITE_ROUTES` gained `/privacy` (additive); `isSiteRoute('/admin')` etc. unchanged.

## 7. Security

- New page is static content; no new endpoints, no client-side secrets.
- `noindex` on all account-state pages; canonical/OG URLs are same-origin only.
- Privacy page documents log/secret hygiene that already holds (tokens excluded from logs).
- No third-party scripts — the analytics allowlist is enforced as “not collected” until a backend
  exists, keeping Rule F (incomplete features disabled).

## 8. Documentation

Updated `README.md` (routes, run order already fixed in Phase 0, verification counts),
`docs/SURFACES.md`, `docs/BETA.md` (page table), `docs/PHASE-1-WEBSITE.md` (this file).

## 9. Remaining work (deferred to later phases)

- First-party analytics *collection* behind the allowlist (needs backend + consent model — Phase 2/3).
- Password recovery and email delivery (Phase 3); real Open Graph image (1200×630 card) when brand
  art is commissioned; visual browser checks (no browser binary in this environment — contrast and
  pixel rendering remain on the manual checklist); `docs/BETA.md`'s terms/legal page if the owner
  wants one.
- Backend/database/API work (Phase 2+) as scheduled — deliberately untouched here.

## 10. Results vs exit criteria

| Exit criterion | Status |
| --- | --- |
| Landing page and existing public routes work | ✅ tests + live smoke |
| Beta applications can be submitted and errors handled correctly | ✅ suite + distinct form states |
| Responsive and accessibility checks pass | ✅ pinned suites + new a11y assertions |
| Existing desktop functionality unchanged | ✅ no `server/`/`src-tauri/` diff; full suite green |
