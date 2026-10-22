# SCOUT architecture after the Cloudflare + Supabase + Resend migration

## Overview

SCOUT is a CS2 broadcast tool: a local broadcast host (observer PC), a desktop shell (Tauri v2,
Windows), and a public website for the closed beta. This migration moves **hosting and backend
infrastructure** to Cloudflare (website edge), Supabase (managed PostgreSQL, ready to use) and
Resend (transactional email). No product features were added and no existing API contracts were
changed.

```
   Public internet                        Cloudflare Workers (edge, HTTPS)
   ┌─────────────┐      SPA + static assets   ┌─────────────────────────────┐
   │  Browser    │◄───────────────────────────│  dist/  (Vite build)        │
   │             │  /api/beta/* proxy          │  functions/worker.ts        │
   └──────┬──────┘  cookies (HttpOnly)        │  - api/beta/[[path]]  ─────┐
          │                                   │  - api/platform/[[path]]   │
          │  HTTPS (operator-listed origins)  │  - api/surface · api/healthz│
          │                                   └─────────────────────────────┘
 ┌────────▼────────┐                                  │ SCOUT_ACCOUNT_SERVICE_URL (secret)
 │   Central host  │──────────────────────────────────┤
 │ (SCOUT_SURFACE  │                                  ▼
 │  = site|host)   │    REST (docs/BETA.md)        Node.js account service
 │  Node.js +      │─────────────────────────────►  server/account-service.ts
 │  Express + ws   │    SQLite (default)           SQLite file  /  Supabase
 │  GSI / panel    │                                    PostgreSQL (ready)
 │  /obs /game /ws │                                   supabase/migrations/
 └─────────────────┘                                       Resend transport
                                                             (email outbox, retries)
         ▲
         │ local-only: GSI, OBS, overlay, recordings, league state
         │ never leave the venue machine
 ┌────────▼────────┐
 │  Venue machine  │
 │  Tauri shell    │
 │  + local host   │
 │  (host mode)    │
 └─────────────────┘
```

## What changed and what did not

### Cloudflare (website)

- `wrangler.toml` builds `dist/` via `npm run build` and deploys worker `scout` to Cloudflare
  Workers (`npx wrangler deploy`), serving `dist/` as static assets.
- The worker (`functions/worker.ts`) answers `/api/*`: it proxies browser-safe `/api/beta/*`
  routes to the Node account service; the service URL and owner service key are Worker secrets,
  never in the client bundle.
- `public/_headers`: `nosniff`, `DENY` framing, `no-referrer`, HSTS, CSP.
- SPA fallback to `index.html` via `not_found_handling` in `wrangler.toml`.
- Health checks: `/api/healthz`, `/api/surface`.
- Local development works with `wrangler dev` (secrets in `.dev.vars`) against a local account
  service — no production credentials (verified).

### Backend (preserved on Node)

The broadcast host and account service use `node:sqlite`, `node:fs` and `ws`, which do not run
on Cloudflare Workers. They are **not** moved to Workers. The host keeps both surfaces
(`site` for the website, `host` for the broadcast) and every existing route, cookie, session and
lease contract. Local tournament state, GSI processing, overlay rendering, OBS integration and
recordings are untouched and never go to Cloudflare or Supabase.

### Supabase (database, ready; SQLite default kept)

- `supabase/migrations/001_initial_account_schema.sql`: version-controlled PostgreSQL migration
  replicating the account schema (accounts, sessions, devices, grants, platform_settings,
  events, audit_logs, account_roles, password_recovery_tokens, email_outbox), with indexes,
  foreign keys, digest-only secrets and RLS enabled (default deny for `anon`).
- Connection via pooled `DATABASE_URL` (PgBouncer, port 6543) for serverless runtimes;
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` server-side only.
- The account service still boots against SQLite by default; the Supabase cutover is an explicit
  operator step with backup, import, count verification and rollback (docs/SUPABASE.md).
- Existing authentication is unchanged: no Supabase Auth, no public registration, invitation-only
  accounts preserved.

### Resend (email)

- Already integrated in `server/email.ts` (`resendTransport` POSTs to
  `https://api.resend.com/emails` with `Authorization: Bearer` and `Idempotency-Key`).
- Configuration: `SCOUT_EMAIL_API_KEY` (Resend key; `re_test_*` in dev delivers nothing),
  `SCOUT_EMAIL_FROM` (verified sender), `SCOUT_ACCOUNT_BASE_URL` (link origin), plus
  `SCOUT_EMAIL_API_URL` and `SCOUT_EMAIL_ENCRYPTION_KEY`. All server-side; none logged.
- Flows: closed-beta invitations (single-use, 24h TTL), invitation resends (previous pending
  outbox deleted first — no duplicate valid invites), password recovery (single-use, 1h TTL,
  non-enumerating), all queued in an encrypted outbox with bounded retries and `last_error_code`.
- Dev/testing: `re_test_*` keys or a loopback `SCOUT_EMAIL_API_URL` avoid emailing real users.

### Desktop (unchanged)

Tauri v2 Windows shell, installer (`scripts/build-installer.mjs`, Inno Setup), local host, CS2
GSI config, shortcuts and update flow are untouched. R2 for release artifacts is documented as
optional and is **not** enabled by default; no unsigned artifacts and no automatic production
updates.

## Environment and secrets

`.env.example` documents every required variable, split by surface (host, website, account
service). Real credentials are never committed: `.env`, `config/account-service/` and `.wrangler/`
are gitignored. Required-but-missing configuration fails with a clear diagnostic that never
prints secret values.

## Data flow summary

1. Applicant applies on the website → the edge worker proxies to the account service → account
   stored with `pending` status.
2. Owner approves (service-key route via proxy) → invite token minted, stored as digest,
   encrypted outbox entry queued → Resend delivers the single-use invite link.
3. Applicant opens `/login?invite=...`, sets a password → token consumed (single use), session
   cookie set → `/download` available.
4. Launcher links via device code → installation token handed over once, then stored as digest.

## Unresolved issues / provider-account actions required from the owner

| # | Item | Why it is blocked / pending |
|---|---|---|
| 1 | **Create the Supabase project** (free tier) and note the pooled connection string (port 6543). | Required before the account service can store data in Supabase. |
| 2 | **Apply `supabase/migrations/001_initial_account_schema.sql`** to a staging project and verify row counts against a SQLite backup. | Cannot be done without a Supabase project; not tested against live Supabase in this sandbox. |
| 3 | **Cut the account service over to Supabase** (PostgreSQL build) after staging validation; keep the SQLite file as rollback artifact. | The runtime storage adapter for Supabase is not part of this migration (SQLite `node:sqlite` layer preserved); the operator performs the cutover. |
| 4 | **Verify RLS as `anon`** (default deny) on all account tables in the staging project. | Requires a live Supabase project. |
| 5 | **Verify a Resend sender domain** and set `SCOUT_EMAIL_FROM` / `SCOUT_EMAIL_API_KEY` (live key) for production. Test mode (`re_test_*`) does not deliver. | Resend requires a verified domain for real delivery. |
| 6 | **Connect the repo to Cloudflare Workers Builds** (build `npm run build`, deploy `npx wrangler deploy`) and set Worker secrets `SCOUT_ACCOUNT_SERVICE_URL` and `SCOUT_BETA_API_KEY`. | Requires a Cloudflare account; local `wrangler dev` was verified, production deployment was not. |
| 7 | **Optionally configure R2** for desktop release artifacts and `SCOUT_DOWNLOAD_URL`. | Optional; release signing remains a build-machine step. |
| 8 | **Windows installer / Rust toolchain** not present in this sandbox, so `cargo test` and the Tauri build were not executed here; CI runs them on Windows/macOS runners. | No desktop code changed; host regression tests passed. |
