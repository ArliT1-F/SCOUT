# Five features to launch SCOUT

A launch plan written against this codebase, not against a generic SaaS roadmap. Every feature below
starts from something the repository already does well, names the exact module it extends, and keeps
the invariants the project has already paid for: the broadcast is local, the website is never a
broadcast host, and nothing on air is gated by a network call.

"Launch" here means **closed beta → public general availability**: a stranger finds SCOUT, tries it
without waiting for a human, broadcasts a real match, tells their community, and can pay for it.

## The package at a glance

| # | Feature | Surface | Launch job | Effort | Risk |
|---|---|---|---|---|---|
| 1 | **Tournament Hub** — public, shareable tournament pages + a live embed | website, public API | Reach: today nothing SCOUT produces can be linked to | 3–4 wk | Privacy / moderation |
| 2 | **Run of Show** — schedule, bracket generation, match-day view | `/app` dashboard + panel | Activation: the product has no time dimension | 2.5–3 wk | Config-hash migration |
| 3 | **Auto-pilot** — rule-based scene automation | host + panel | Retention & differentiation: every transition is manual today | 2–3 wk | Automation on air |
| 4 | **Recap Kit** — post-match report, share card, delivery | dashboard + host + website | Word of mouth: a finished match currently produces nothing | 3 wk | Stats fidelity |
| 5 | **Launch gate** — self-serve trial, plans, entitlements | website + owner desk | Revenue & scale: every account is hand-approved | 4–6 wk | Billing vs. live show |

Order of work and dependencies are in [The launch sequence](#the-launch-sequence); the rules every
one of these must obey are in [Guardrails](#guardrails-these-features-must-respect).

---

## What the code says today

The product is far more complete than a beta usually is. The gaps are specific, and each proposed
feature fills one.

| Building block | Where | What it already gives us |
|---|---|---|
| Broadcast config (teams, rosters, map series, bracket, break copy) | `server/config.ts`, `config/teams.json` | Zod-validated, normalized, hashed for sync conflict detection, packed in event packages |
| Nine scenes, fixed ids | `server/controls.ts`, `src/stage.tsx`, `src/hud.tsx` | Typed `SceneId`, compile error if undescribed (`SCENE_DETAILS`) |
| Derived match events | `server/events.ts` | Kills and round ends by differencing snapshots, reset-safe |
| Session archive | `server/recordings.ts` | Up to 40 matches, 10,000 events each, JSON export |
| Multi-tenant platform | `server/platform.ts`, `server/platform-sync.ts` | Per-account tournaments, versioned config, metrics, conflict handling, offline cache |
| Accounts, licensing | `server/beta.ts`, `server/licensing.ts` | Invite-only approval, device link, licence states that never gate a broadcast |
| Public website | `src/site.tsx`, `server/surface.ts` | Six marketing/account routes, deny-by-default surface allowlist, per-route SEO metadata |
| Operator panel | `src/main.tsx`, `src/panel-catalog.ts` | 13 sections, one catalogue shared with `/welcome` so the site cannot advertise a section that does not exist |
| Owner desk | `src/platform-admin.tsx` | Applications, users, activity, settings, CSV exports |

What is missing is equally specific: **no date or time anywhere**, **no public artifact**, **no
automation**, **no post-match output**, **no way to try or pay without a human**.

---

## 1. Tournament Hub — a public page for every event

### The gap

The website is a funnel, not a product surface: `/welcome`, `/apply`, `/login`, `/download`,
`/profile`, `/privacy` (`src/site.tsx`). The platform store knows each tournament's teams, maps,
bracket and totals, but the only thing that can ever be public is one aggregate strip — and only when
the owner flips `publicStatsEnabled` (`server/platform.ts`). An organiser's players, their Discord,
their sponsors have **nothing to link to**. Every view SCOUT creates is locked inside the broadcast.

### What ships

- `GET /t/<slug>` — a public tournament page: next match and time (once #2 lands), live/idle state,
  bracket, per-map results, team rosters, and a "Watch" link to the organiser's stream.
- `GET /embed/<slug>` — a compact, iframe-friendly scoreboard/next-match widget for the organiser's
  own site or a sponsor page.
- Real social metadata per tournament: title, description, and a generated OG image, so a shared link
  looks like an event instead of a generic logo.
- Opt-in publication, field by field, plus an **unlisted** mode (link works, page is `noindex` and not
  listed in the sitemap).
- `/sitemap.xml` built from published hubs only.

### How it fits this codebase

- **Projection, not a second store.** A new `server/public-hub.ts` turns a `Tournament` +
  `PlatformSettings` into a whitelisted read model. Public pages read that and never `config` directly:

  ```ts
  type PublicTournament = {
    slug: string; name: string; event: string; stage: string;
    teams: {name: string; tag: string; logo: string | null}[];   // no steamid, no real name
    bracket: PublicRound[]; maps: PublicMapResult[]; schedule?: PublicSlot[];
    live: {scene: string; updatedAt: number} | null;
    links: {stream?: string};
  };
  ```

- **Additive data.** `Tournament` gains `publication?: {slug, visibility, sections, updatedAt}`.
  `PlatformStore.adoptSnapshot()` already normalizes every stored tournament on load (rewriting
  `configVersion` and `configHash`), so a defaulted field is adopted without a file migration — old
  stores load unchanged. Supabase mirroring gets migration `004_public_hubs.sql` alongside `001`–`003`.
- **The surface allowlist stays deny-by-default.** `websitePathAllowed()` in `server/surface.ts` gains
  exactly one namespace: `/api/public/` — read-only `GET`, rate-limited, cacheable, no auth, no
  session, no host data. Everything else about the website boundary is unchanged.
- **Routing.** `isSiteRoute()` becomes `siteRouteFor()`, keeping `PAGE_META` intact for the six static
  routes (a test asserts the map covers the router exactly) and adding a `/t/:slug` branch with its
  own metadata. For crawlers, the production catch-all in `server/index.ts` already serves
  `dist/index.html`; it gains a small, escaped rewrite of the `<title>`/OG block for `/t/:slug` —
  no framework, no SSR pipeline, no new dependency.
- **Framing policy.** The host sets no CSP today (only `Referrer-Policy`). Embeds need an explicit
  `Content-Security-Policy: frame-ancestors *` on `/embed/*` and `frame-ancestors 'none'` everywhere
  else, so "public embed" is a decision written down rather than a default.

### v1 / not v1

**v1:** one page per published tournament, embed widget, OG image, unlisted mode, sitemap.
**Not v1:** custom domains, team pages, comments, video hosting, third-party score submission.

### Risks

- **Publishing people.** Rosters hold real names, aliases, photos and Steam IDs (`playerSchema`).
  Default public output is gamer name + tag + logo only; real name and Steam ID require an explicit
  per-tournament opt-in. A projection test asserts that `steamid`, `nickname`, `email`, logs and
  operator data can never appear in a public payload — the same "pin the rule" style as
  `tests/scenes-ssr.test.ts`.
- **Staleness.** A hub must say "last updated" and must never show sample data (the repo already pins
  this for output routes). A dead host shows the last known result and an honest idle state.
- **Moderation.** Publishing is a privilege of an approved account (and, once #5 lands, of a plan that
  includes it); the owner desk gets "unpublish" and "block slug", both audited.

**Done when:** a real tournament publishes, unlisted links work, unpublished slugs 404, the
projection test fails if a private field is added, a social crawler sees the right card, and
`PLATFORM.md` / `SURFACES.md` describe the new public namespace.

---

## 2. Run of Show — schedule, brackets and the match-day view

### The gap

`configSchema` describes exactly one series: event, stage, format, MR, two teams, up to nine maps, a
single-elimination bracket, break copy. There is **no date, no time, no "next"**. The only clock in
the product is `controls.breakEndsAt`, set by hand. Organisers therefore run their day in a
spreadsheet and retype teams into the panel when the previous match ends.

### What ships

- **Schedule in the tournament config:** slots with `at` (epoch ms), two teams (bound to config team
  ids or free-text seeds), stage, format, optional map pool and stream link.
- **Bracket generation** from the schedule: pick round count and seeding order, get a populated
  `bracket` that still propagates through the existing `propagateBracket()`.
- **Match day** on `/app`: now / next / later, each with one click to "load into overlay" — teams,
  format, stage and map pool land in the live config; the operator still confirms.
- **Break countdown helper:** point the break scene at the next slot ("Vertex vs Parallax · 19:30")
  and set `breakEndsAt` in one action.
- **ICS export** (`GET /api/schedule.ics`, and a public feed for published hubs) so the fixture list
  lives in the organiser's calendar.
- **Running-late offset:** a single "+15 minutes" control that shifts remaining slots and is shown on
  the hub, instead of silently rewriting times.

### How it fits this codebase

- `server/config.ts` gains a bounded, defaulted `schedule` array and `seriesId` on bracket matches.
  Because it lives in the config, it is already covered by event packs (`server/packs.ts`), platform
  sync (`server/platform-sync.ts`) and the offline cache — no new storage layer.
- **The config-hash trap, handled up front.** `configHash()` hashes `normalizeConfig()`, and hosts and
  the platform compare those hashes to decide who owns the newest config. A new defaulted key changes
  the hash of *every* existing config, so an upgraded and a not-yet-upgraded machine would read each
  other as diverged. Ship a compatibility shim rather than a surprise: keep the previous normalizer
  exported as `legacyConfigHash()`, and on first comparison accept either hash once and rewrite the
  receipt (a `schemaVersion` marker), never surface `config-conflict`. A test pins the upgrade as
  exactly once, and a second run must not re-hash.
- `src/admin.tsx` (`MatchEditor`) gains the schedule table; `src/launcher-gui.tsx` (`AppHome`) gains
  the match-day card; no new panel section — the day belongs on the dashboard, the details in Match
  setup.

### v1 / not v1

**v1:** manual schedule, bracket generation, ICS, match-day view, countdown helper, late offset.
**Not v1:** start.gg/Challonge sync, per-event timezones beyond local rendering (store epoch ms, render
in the operator's locale, publish UTC), automatic rescheduling.

### Risks

- **Timezones.** Epoch ms in storage, `DTSTART` in UTC for ICS, local rendering in the UI. No stored
  local times, ever.
- **Conflict semantics.** The migration above; plus a test that an old host and a new host converge
  without duplicating tournaments.
- **Scope creep into a tournament platform.** SCOUT schedules *a broadcast*, not a league. No
  registration, no check-in, no brackets beyond what the overlay can show.

**Done when:** a 16-team single-elimination schedule generates a bracket whose winners propagate; the
ICS opens correctly in Google/Outlook; the match-day view works with the host offline (cached config);
tests cover generation, byes, the late offset and the one-time hash upgrade.

---

## 3. Auto-pilot — the board drives itself between rounds

### The gap

Scene changes are 100 % manual. `controlsSchema` holds the scene; every transition is a click, a
Companion button, or a keypress. Meanwhile `EventTracker` already derives every round end, bomb
outcome and kill from the GSI stream, and the panel receives those events over `/ws`. The product
knows what just happened and still asks a human to react to it — the same human who is supposed to be
watching the match.

### What ships

A rules panel (**Automation**, a new panel section) with a small, readable grammar:

```jsonc
{ "when": { "type": "round-end" },
  "unless": { "seriesOver": true },
  "do": [{ "scene": "recap" }, { "after": 8, "scene": "live" }],
  "enabled": true }
```

Defaults offered (all opt-in):

- round ends → recap for 8 s → live
- series ends → winner
- break countdown reaches zero → live
- next scheduled match is 5 minutes away → break with the countdown set
- feed silent > 10 s → do nothing (the HUD already shows SIGNAL LOST; automation must not flap)

Any manual scene click suspends automation for 60 s, so taking the wheel is always immediate and
obvious.

### How it fits this codebase

- `server/automation.ts`: a pure `step(rules, event, now, state) → actions[]` plus one runner. No
  wall-clock sleeps beyond a single delayed queue, so the whole engine is deterministic and testable
  by replaying `tests/fixtures/observer-mirage-nuke.jsonl` and asserting an exact scene timeline.
- Actions write through the same control-update path the panel uses, so the **lease, the audit trail
  and the WebSocket broadcast behave exactly as for a human**. A second producer cannot be surprised
  by an unrecorded change, and the audit entry names the rule that acted.
- Stored in `config/automation.json` (Zod, versioned, gitignored like `config/operator.json`), included
  in event packs so a league can ship its own run-of-show automation with its overlay theme.
- UI in `src/main.tsx` + one entry in `PANEL_SECTIONS` (`src/panel-catalog.ts`). Because `/welcome`
  renders that catalogue (and `site.tsx` prints the count), the marketing page stays truthful with no
  extra edit — one of the small design wins already in the repo.

### v1 / not v1

**v1:** scene changes and countdowns on round/series/schedule events, with delays and an override.
**Not v1:** free-form scripting, OBS scene scripting (the bridge stays operator-driven), any action
that edits scores or config.

### Risks

- **Wrong scene on air.** Disabled by default; a simulation mode in the panel runs rules against the
  demo feed with outputs untouched; rules can only change scene and countdown, never scores; the
  running rule is visible while active.
- **Races.** Automation respects the control lease exactly like a person: it will not act while
  another operator holds it.
- **Feed resets.** `observe(reset = true)` already clears watch state on map/provider change. Rules
  must be **edge-triggered on round transitions**, never levels, and the fixture suite must include a
  mid-series reset.

**Done when:** the fixture replay produces the documented timeline; a manual click suspends
automation and the panel says so; a held lease blocks automated actions; the audit trail names the
rule; a real observer capture (not only the synthetic fixture) is verified before release notes claim
it.

---

## 4. Recap Kit — the match ends, something happens

### The gap

The session archive records kills and rounds for up to 40 matches and can export one as JSON. That is
the end of the story. No report, no shareable graphic, no message to the community — every organiser
rebuilds the same results post by hand, badly, at 1 a.m.

### What ships

At the end of a series:

- **A report page** — per-map scoreline, round timeline, K/D/HS %, multi-kills and opening kills, MVP —
  linked from the published hub when the hub exists, and always available locally.
- **Share cards** in the product's own visual language at 1200 × 630 and 1080 × 1350 (feed + story),
  generated from real numbers.
- **Delivery:** one click to a Discord channel, email to the organiser, and embed on the hub.
- **Export:** the JSON export stays; CSV is added for spreadsheets.

### How it fits this codebase

- **Honest stats need one schema addition.** `KillEvent` has no assister, and damage lives only in
  the live snapshot. Archive schema v2 adds a round-end player snapshot (kills, deaths, assists,
  damage, headshots). Old archives still load and render "not captured" where the data does not
  exist — never a guessed number. This is the same additive-and-versioned approach already used in
  `server/recordings.ts` and `server/config.ts`.
- `server/recap.ts` derives the report purely from the archive; a test pins K/D/HS totals against the
  shipped fixture.
- **Cards without a new dependency.** `react-dom/server`'s `renderToStaticMarkup` is already used in
  the test suite; a `<RecapCard>` built from the HUD's tokens renders to SVG, and the browser turns it
  into a PNG via canvas — the same client-side download trick as `downloadCsv` in `src/admin-model.ts`.
  The fonts are already bundled in `public/fonts/`.
- **Delivery reuses the outbox discipline.** `server/email.ts` already encrypts, retries, keys
  idempotently and records a visible last error. A new `server/webhooks.ts` adds Discord plus a
  generic HMAC-signed webhook with the same rules: bounded retries, 429/`retry-after` respected,
  capped response size, no redirects, no secret in logs.

### v1 / not v1

**v1:** series recap, two card sizes, Discord + email delivery, hub embed, CSV.
**Not v1:** per-round clips, video highlights, auto-posting to X/Instagram, cross-tournament
leaderboards.

### Risks

- **Wrong numbers in public.** Every published figure comes from the archive and carries the match id;
  totals are pinned by tests; anything not captured is labelled, not inferred.
- **Webhook abuse (SSRF).** Only `https`, no redirects, resolved host checked against private ranges,
  timeout, size cap.
- **Discord rate limits.** Per-channel queue, backoff, and a visible "last delivery" state in the panel.

**Done when:** an archived fixture produces a report that matches the archive totals; both card sizes
render without clipped text at the longest team names; a Discord message arrives in a test channel; a
failed delivery is visible with a retry; nothing is posted without the operator pressing the button.

---

## 5. Launch gate — trial, plans and entitlements

### The gap

Every account is hand-approved (`pending → approved` in `server/beta.ts`, reviewed in `/admin`), and
the only commercial lever is a single global `maxTournamentsPerUser` (default 3, bounded 1–25). There
is no way to try SCOUT on the day you find it and no way to pay for it. Launching on that rail is
launching a queue.

### What ships

- **Free trial:** verified email → instant entitlement (one active tournament, one linked host, all
  scenes), time-boxed, upgradeable in place. Apply/approve stays for "talk to us", venues and
  custom work, so the owner desk keeps the tooling it has.
- **Plans:** Organiser (tournaments, hubs, automation), Venue/League (more hosts, recap delivery,
  priority support), and a **Founder** plan that keeps every existing beta account at its current
  access and price. Prices live in `platform_settings` (owner-editable), not in code.
- **Entitlements** computed server-side from plan + trial state, returned by `/api/beta/license` and
  `/api/platform/status`, and enforced **only at boundaries**: creating a tournament, linking a host,
  turning on a premium feature. Never mid-broadcast.
- **Billing** behind `SCOUT_BILLING_PROVIDER=none|stripe`: checkout, signed webhooks with replay
  protection, idempotent subscription state, invoices/receipts in `/profile`.
- **Owner desk → Commercial:** trials, conversion, MRR, churn, failed payments, manual plan override
  with a reason that lands in the audit trail, CSV export in the existing style.
- `/pricing`, terms, refund policy, and the privacy page updated for billing data.

### How it fits this codebase

- Account records gain `plan`, `trialEndsAt`, `billingCustomerId` (opaque). The account service
  already has forward-only migrations (`server/account-migrations.ts`, `PRAGMA user_version`) and
  Supabase has `001`–`003`; billing is `004` in both places. Secrets stay server-side, as everywhere
  else in this repo.
- **`server/licensing.ts` keeps its rule.** `RUNNABLE_STATES` is untouched: a failed payment changes
  *entitlements*, never `active → revoked` in the middle of a show. A separate `billingState` lets the
  dashboard say "payment failed — update card" without a scare banner during a broadcast. A test
  asserts a delinquent account can still finish a live series.
- `sanitizeSettings()` validates plan/price configuration; the desk's existing `SettingToggle`,
  `Pager`, `downloadCsv` and dirty-state handling are reused rather than reinvented.
- **Trial abuse controls:** verified email, one trial per person, domain rate limits, no card up front,
  and a discreet "Powered by SCOUT — trial" line on published hubs, which doubles as marketing.

### v1 / not v1

**v1:** trial + three plans + Stripe subscriptions + entitlements + owner commercial view + manual
invoicing for venues.
**Not v1:** usage-based billing, seat management inside one venue, reseller programme, tax handling
beyond the provider's.

### Risks

- **Billing taking a broadcast down.** The boundary rule above, plus the delinquent-account test.
- **Tax and legal lead time.** VAT, refunds and terms take longer than the code; start them first.
- **Existing beta accounts feeling downgraded.** Map them to Founder before launch and say so by
  email — the cohort is small and the goodwill is worth more than the revenue.

**Done when:** a stranger can start a trial and go on air the same day with no owner in the loop; a
trial expiry blocks only a *new* tournament; a replayed Stripe webhook cannot double-charge or
double-provision; a failed payment never changes licence state mid-series; the desk shows the numbers.

---

## Alternatives considered (and why they are not in the five)

| Idea | Why not now |
|---|---|
| **Multi-language UI** | Every string, layout, email and doc; no launch-loop payoff. Revisit when hub traffic shows where organisers actually are. |
| **Clip / highlight export** | Needs video tooling and storage; the archive stores events, not frames. Recap Kit captures most of the social value for a fraction of the work. |
| **start.gg / Challonge sync** | Attractive, but an external API dependency, keys and support. The reversible first step is ICS out plus CSV import into the schedule. |
| **Overlay/theme marketplace** | Packs already import/export. A marketplace needs moderation, payouts and a licence model, and nobody can discover it before the hub exists. |
| **Native mobile app** | `/` is already a touch-first remote console. A store app adds release overhead without a new capability. |
| **Public API for third parties** | A support and security commitment. Publish the hub's read-only namespace first; a documented API can grow out of it once there is demand. |

---

## The launch sequence

Assumes ~2–4 engineers and an 8-week runway.

| Wave | Weeks | Work | Depends on |
|---|---|---|---|
| 0 — decisions & plumbing | 0–1 | Pricing, terms, refund policy, billing account; hub privacy model; config-hash migration design | — |
| 1 — product depth | 1–4 | **Run of Show** then **Auto-pilot** | Wave 0 migration |
| 2 — public surface | 4–7 | **Tournament Hub**, then **Recap Kit** (recap pages land on the hub) | Run of Show (fixtures), word on privacy |
| 3 — commercial | 5–8 (parallel) | **Launch gate**: trial, plans, entitlements, Stripe, desk view | Wave 0 legal/tax, hub for trial branding |
| Launch | 8 | `/pricing` live, first three hubs published, announcement | All |

Why this order: Run of Show and Auto-pilot make the product *worth launching* for a solo operator;
the hub makes it *findable*; the recap turns one event into next month's applicants; the launch gate
turns interest into revenue. The landing page's `#community` section is explicitly waiting for real
customer stories — the first published hubs are that story, told with the product itself.

## Guardrails these features must respect

1. **The broadcast is local and never gated** by network, licence or billing (`docs/BETA.md`,
   `server/licensing.ts`). A feature that can take a live show off air is wrong, however tidy.
2. **No sample data on output routes.** Previews say they are previews, on every surface.
3. **The website never becomes a broadcast host.** `/api/public/*` is a new read-only, rate-limited
   namespace; `websitePathAllowed()` stays deny-by-default.
4. **Public means public.** No emails, Steam IDs, real names, logs or host addresses without explicit
   opt-in, enforced by a projection test rather than by review.
5. **New surfaces register themselves.** New pages get `PAGE_META` and robots rules; new panel
   sections go in `PANEL_SECTIONS`; new scenes are a compile error until described in `SCENE_DETAILS`.
6. **No new runtime dependencies** unless a feature cannot ship without one. Today the host is
   `express`, `ws` and `zod`; keep it that way.
7. **Offline-first.** Schedule, rules, archive and config live on the venue machine. Every feature
   degrades to local data when the internet at the venue does not exist.

## Metrics that tell us it worked

| Feature | Metric | Target by launch + 60 days |
|---|---|---|
| Tournament Hub | Active tournaments with a published hub | ≥ 50 % |
| | Referrals from hubs to `/welcome` | The largest single source |
| Run of Show | Tournaments with a schedule + generated bracket | ≥ 60 % of new tournaments |
| Auto-pilot | Live series using ≥ 1 rule | ≥ 40 %, with < 1 manual override per series |
| Recap Kit | Series ending with a delivered recap | ≥ 50 %; median delivery < 60 s after series end |
| Launch gate | Trial → paid conversion | 8–12 % |
| | Time from sign-up to first broadcast | < 30 minutes |
| All | Licence/feed incidents that stopped a show | 0 |

## Implementation status

All five features are implemented in this checkout, with tests. The table below is the map from the
plan to the code; the README section "Tournament Hub, Run of Show, Auto-pilot, Recap Kit and the
Launch gate" is the operator-facing description.

| Feature | Server | Client | Tests |
| --- | --- | --- | --- |
| 1. Tournament Hub | `server/hub.ts` (projection, `injectHubMeta`), `server/platform.ts` (`setPublication`, `bySlug`, `hubs`, `publicTournament`), `/api/public/*`, `/sitemap.xml`, `/t/`, `/embed/` | `src/site-hub.tsx` (page + embed), `src/hub-ui.tsx` (publish card) | `tests/hub.test.ts` |
| 2. Run of Show | `server/schedule.ts`, `config.schedule` (schema v2), `legacyConfigHash`, `/api/schedule.ics`, `/api/schedule/apply` | `src/schedule-ui.tsx` (editor, match-day card), `MatchDayCard` on Overview | `tests/schedule.test.ts` |
| 3. Auto-pilot | `server/automation.ts`, `config/automation.json`, `AutomationEngine`, `/api/automation*`, `round-end`/`series-end`/`break-over`/`slot-soon` triggers | `src/automation-ui.tsx` | `tests/automation.test.ts` |
| 4. Recap Kit | `server/recordings.ts` (archive v2 snapshots + delivery), `server/recap.ts`, `server/recap-card.ts`, `server/webhooks.ts`, `/api/archive/:id/recap*` | `src/recap-ui.tsx` | `tests/recap.test.ts`, `tests/webhooks.test.ts` |
| 5. Launch gate | `server/plans.ts`, `server/billing.ts`, migration v5, `supabase/migrations/004_plans_and_public_hubs.sql`, `/trial`, `/accounts/:id/plan`, `/api/billing/*` | `src/site-hub.tsx` (`/pricing`), `PlanCard` on profile, `/admin` plan desk | `tests/plans.test.ts`, `tests/billing.test.ts`, `tests/account-service.test.ts` |

The guardrails in §"Guardrails" were treated as acceptance criteria, in particular: hubs never carry a
SteamID, real name, email or log; auto-pilot only writes `scene` and `breakEndsAt` and yields to the
control lease and to any human change; a delivery error or a failed payment never stops a broadcast;
and every archive change is additive, so a v1 archive still loads.

**Still unverified in this checkout:** a real Stripe test-mode round trip (the code is tested against
signed fixtures and a mocked `fetch`, not against Stripe), a real Discord webhook, and a visual pass on
the hub/pricing pages in a browser. `src-tauri` is untouched by these features.

---

# Follow-up wave — the next five

Same rules as the launch wave: every feature is scoped so stopping after it leaves the product
coherent, and none of them adds a runtime dependency. Verified in this checkout with
`npx tsc --noEmit`, `npm test` (478 passing) and `npm run build`.

| Feature | v1 | Not v1 | Done when | Files |
| --- | --- | --- | --- | --- |
| 6. Sponsor rotation & proof-of-play | static uploads + weights, 20 s rotation, sampled ledger, 30-day report + CSV | an ad server, click tracking, per-sponsor contracts | a three-sponsor rotation is auditable per scene | `server/sponsor-rotation.ts`, `server/sponsors.ts`, `src/sponsor-studio.tsx`, `tests/sponsors.test.ts` |
| 7. GSI-loss watchdog | one "technical difficulties" scene change + one alert through the existing webhook | retries beyond the existing reconnect, an alerting service | a killed feed produces exactly one scene change and one alert, both audited | `server/watchdog.ts`, `server/automation.ts` (`feed-lost`/`feed-restored`), `tests/watchdog.test.ts` |
| 8. Team portal | signed expiring links, rate-limited submissions, approval queue, apply-to-team | accounts, passwords, captain dashboards, file uploads | a captain submits a roster and an organiser approves it without either having an account | `server/portal.ts`, `src/portal.tsx`, `tests/portal.test.ts` |
| 9. Highlight clip markers | markers on an archive, CSV timecodes, Replay Studio deep link | video encoding, ffmpeg, clip files | a marked round exports as timestamps an editor can cut | `server/recordings.ts` (`markers`), `/api/archive/:id/markers*`, `src/recap-ui.tsx`, `tests/markers.test.ts` |
| 10. Season & multi-stage hubs | one group stage → playoffs on the series page, computed table | Swiss, double elimination, cross-event seasons | a group table and a bracket appear on one page from the same config | `server/stages.ts`, `server/hub.ts`, `src/site-hub.tsx`, `tests/stages.test.ts`, `tests/hub-stages.test.ts` |

## 6. Sponsor rotation and proof-of-play

A sponsor layer is an ordinary overlay widget, so it can be dropped into any scene and it inherits the
existing arrange/publish rules. Rotation is deterministic — `cycle[floor(now/rotateMs) % cycle.length]`
with the cycle built from enabled slots repeated by weight — which means the host, `/obs`, `/game`, the
studio preview and the report all agree without a socket message. Proof-of-play is sampled by the host
every five seconds and deduped on `(sponsor, scene, rotation step)`, so a page refresh or a second OBS
source cannot inflate the number. The report is 30 days by default, the CSV is formula-neutralised, and
the file is `config/sponsors/impressions.json` (mode 0600, capped at 5 000 rows).

Sponsor graphics are restricted to `uploads/overlays/*.{png,jpg,jpeg,webp,gif}` — no SVG, because an
uploaded SVG is a document rather than a picture, and the layer is there to be seen, not executed.

## 7. GSI-loss watchdog

The host already knows when the last packet arrived. Twenty seconds of silence *during a live map* is
the point where a frozen scoreboard is worse than a holding slide, so the watchdog arms only after it
has seen a live map, fires once per gap, and disarms when the map ends. The scene change is an
ordinary auto-pilot rule (`feed-lost`, `feed-restored`), which means it obeys the control lease, the
manual-override suspension and the audit trail exactly like every other rule — and the operator can
leave both rules off and still get the panel banner and the alert.

The alert is a single webhook message to the operator's own endpoint (Discord-compatible), with
`allowed_mentions` cleared so a webhook cannot ping a role. A failed delivery is logged and swallowed:
an alert must never be able to affect the broadcast.

## 8. Team portal

The link is the credential: 24 random bytes, 14-day expiry, revocable and rotatable, scoped to one team
in one event, rate-limited to one submission per 30 seconds and five per hour. Submissions land in an
approval queue — approve decides, apply writes the roster into the tournament — because an organiser
who approved a roster should not also lose the names they corrected by hand. Captains never get an
account, and nothing they type reaches the broadcast without a decision.

Only `http(s)` links survive normalisation; a handle stays text. A logo link is stored as submitted and
only applied when it already points at a shipped asset, since uploaded files on the venue host are not
reachable from the website.

## 9. Highlight clip markers

A marker is a wall-clock instant with a label, a kind, a map and a round. It exports as a timecode CSV
(`00:01:05.000`) that an editor can cut against, and the panel opens the recording that covers that
instant and seeks the playhead to it. Nothing is encoded, uploaded or re-encoded: the product ships the
timestamps, the editor ships the clips.

## 10. Season and multi-stage hubs

A stage is a bracket round, and the table is computed from the results already in the config — nothing
is stored twice, so a corrected score updates the table on the next request. v1 is one group stage plus
a bracket; several group-labelled stages collapse into one table (events often write "Group A" and
"Group B"), and a "Swiss" stage renders its matches without a table rather than inventing pairing rules
it cannot model.


---

## Open decisions for the owner

1. **Invite-only with trial, or open sign-up?** Trial-first is recommended; it keeps the review desk
   for venues and custom work without queueing hobby organisers.
2. **Real names and Steam IDs on hubs?** Recommended: off by default, per-tournament opt-in.
3. **A permanent free tier, or a 14-day trial?** A free tier grows the hub network; a trial converts
   better. The hub argues for a limited free tier with trial branding.
4. **Founder pricing** for the existing beta cohort — decided before launch, communicated by email.
5. **Discord first, or a generic webhook first?** Discord is where the CS2 community lives; the
   generic webhook is the quieter, cheaper v1.

---

## What this document is not

It is not a commitment to all five at once, and it does not replace the existing verification rules:
`npm test`, `npm run build`, the Windows installer checks in `docs/SURFACES.md`, and an honest manual
run on real CS2 observer data before anything is claimed in release notes. Every feature above is
scoped so that stopping after it leaves the product coherent — none of them depends on the next one to
make sense today.
