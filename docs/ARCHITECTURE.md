# SCOUT architecture: Render website + Supabase + Resend

## Overview

SCOUT is a CS2 broadcast tool: a local broadcast host (observer PC), a desktop shell (Tauri v2,
Windows), and a public website for the closed beta. The public website is served by this
repository's own Node host on Render (free tier), with Supabase (managed PostgreSQL) for account
persistence and Resend for transactional email. There is no separate static host and no edge
proxy: one Render web service serves the SPA, `/api/beta/*`, `/api/platform/*`, `/admin` and the
account-service endpoints.

```
   Public internet                        Render (single Node web service, HTTPS)
   ┌─────────────┐      SPA + APIs        ┌─────────────────────────────┐
   │  Browser    │◄───────────────────────│  dist/  (Vite build)        │
   │             │  /api/beta/* + cookies  │  server/website.ts          │
   └──────┬──────┘  (HttpOnly)             │  SCOUT_SURFACE=site         │
          │                               │  - /admin · /api/healthz    │
          │  HTTPS (operator origins)     │  - /api/platform/*          │
          │                               └──────────────┬──────────────┘
 ┌────────▼────────┐                                     │ loopback, embedded
 │   Venue hosts   │                                     ▼
 │  (SCOUT_SURFACE  │    REST (docs/BETA.md)        account service
 │  = host)        │◄───────────────────────────── server/account-service.ts
 │  Node.js +      │    poll / metrics / settings  SQLite file / Supabase
 │  Express + ws   │                                   PostgreSQL (mirror)
 │  GSI / panel    │                                   supabase/migrations/
 │  /obs /game /ws │                                       Resend transport
 └────────┬────────┘                                       (email outbox, retries)
          │
          │ local-only: GSI, OBS, overlay, recordings, league state
          │ never leave the venue machine
 ┌────────▼────────┐
 │  Venue machine  │
 │  Tauri shell    │
 │  + local host   │
 │  (host mode)    │
 └─────────────────┘
```

## What runs where

### Render (website)

- `render.yaml` defines one Node web service: `npm install --include=dev && npm run build`,
  then `npm start` (`server/website.ts` with `SCOUT_SURFACE=site`), health check `/api/healthz`.
- The same process embeds the account service on loopback (`SCOUT_EMBED_ACCOUNT_SERVICE=1`),
  so one free-tier service answers the SPA, `/api/beta/*`, `/api/platform/*`, `/admin` and the
  bare account-service endpoints — no separate static host and no edge proxy.
- Persistence survives free-tier spin-downs through the Supabase mirror
  (`server/supabase-store.ts`, `supabase/migrations/`); secrets live on the Render service,
  never in the client bundle.
- Health checks: `/api/healthz`, `/api/surface`.
- Local development needs no credentials: `npm run website` (site surface, local JSON beta
  store) or `PORT=8790 npm run account-service` for the standalone service.

### Backend (Node, one codebase)

The broadcast host and account service are plain Node (`node:sqlite`, `node:fs`, `ws`). The host
keeps both surfaces (`site` for the website, `host` for the broadcast) and every existing route,
cookie, session and lease contract. Local tournament state, GSI processing, overlay rendering,
OBS integration and recordings never leave the venue machine; only the account plane is mirrored
to Supabase.

### Supabase (database mirror)

- `supabase/migrations/001/002/003`: version-controlled PostgreSQL schema for the account plane
  (accounts, sessions, devices, grants, platform_settings, events, audit_logs, account_roles,
  password_recovery_tokens, email_outbox), with indexes, foreign keys, digest-only secrets and
  RLS enabled (default deny for `anon`).
- Connection via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, server-side only.
- When configured, the account service hydrates from and flushes to Supabase
  (`server/supabase-store.ts`), so Render free-tier restarts lose nothing; without them it runs
  on the local SQLite file.
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
GSI config, shortcuts and update flow are untouched. Desktop releases are published to GitHub
releases (`SCOUT_DOWNLOAD_URL`); no unsigned artifacts and no automatic production updates.

## Environment and secrets

`.env.example` documents every required variable, split by surface (host, website, account
service). Real credentials are never committed: `.env`, `config/account-service/` and the other
operator-data directories are gitignored. Required-but-missing configuration fails with a clear
diagnostic that never prints secret values.

## Data flow summary

1. Applicant applies on the website → the host proxies to the (embedded) account service →
   account stored with `pending` status.
2. Owner approves (service-key route via proxy) → invite token minted, stored as digest,
   encrypted outbox entry queued → Resend delivers the single-use invite link.
3. Applicant opens `/login?invite=...`, sets a password → token consumed (single use), session
   cookie set → `/download` available.
4. Launcher links via device code → installation token handed over once, then stored as digest.

## Owner actions

The Supabase project, the schema (migrations 001–003) and the Render cutover are done — see
docs/SUPABASE.md §7. What remains for the owner:

| # | Item | Notes |
|---|---|---|
| 1 | **Verify a Resend sender domain** and set `SCOUT_EMAIL_FROM` / `SCOUT_EMAIL_API_KEY` (live key) on the Render service. | Test mode (`re_test_*`) does not deliver; without a verified sender, invitations stay queued with `provider-rejected` diagnostics. |
| 2 | **Confirm the Render service environment** (`SCOUT_OWNER_EMAIL`, `SCOUT_BETA_API_KEY`, `SUPABASE_*`, `SCOUT_EMAIL_*`, `SCOUT_ACCOUNT_BASE_URL`) per `render.yaml`, and that `/api/healthz` answers 200 after each deploy. | `render.yaml` is the source of truth for the variable list. |
