# Supabase — managed PostgreSQL for the SCOUT account service

SCOUT's account plane (applications, sign-in, invitations, password recovery, launcher links) is
the only part of SCOUT that needs a server-side database. Everything else — CS2 GSI processing,
tournament state, overlay rendering, OBS integration, recordings — stays on the venue machine and
never touches Supabase.

This document describes provisioning Supabase PostgreSQL for the account service, applying the
version-controlled migrations, and migrating data from the existing SQLite store. It does **not**
replace authentication: accounts, sessions, scrypt passwords and invite tokens keep the existing
contract (docs/BETA.md); only the storage backend changes.

## Compatibility status

The Node.js account service (`server/account-service.ts`) uses Node's `node:sqlite` and the local
file system, so it **cannot run on Cloudflare Workers**. It keeps running on Node (the same machine
as the broadcast host, or a small VM/container), and this migration does **not** rewrite its storage
layer. Supabase is provisioned and the migrations are version-controlled and ready to apply; the
account service continues to use SQLite by default. Switching the account service's store to Supabase
PostgreSQL is a deliberate cutover the operator performs after testing (see "Cutover" below). This
is by design: per the migration plan, an incompatible backend is preserved and documented rather than
rewritten unnecessarily.

## 1. Provision (free tier)

1. Create a project in Supabase (free tier includes a managed PostgreSQL database, PgBouncer
   pooling, and the `anon` / `service_role` keys).
2. Note the project's connection strings under Settings → Database:
   - Direct connection (port 5432): for one-off administration/psql.
   - Pooled connection (port 6543, PgBouncer, transaction mode): **use this for the account
     service** — serverless/long-running Node processes share a small pool instead of opening a
     connection per request.
3. Never put the database password (or the service-role key) in the frontend or in `VITE_*`
   variables. The account service reads them server-side only.

## 2. Apply the migrations

Version-controlled migration: `supabase/migrations/001_initial_account_schema.sql`

It replicates the SQLite account schema (`accounts`, `sessions`, `devices`, `grants`,
`platform_settings`, `events`, `audit_logs`, `account_roles`, `password_recovery_tokens`,
`email_outbox`) with the same digest-only security model, plus indexes, foreign keys and row
level security.

Apply once to a fresh (empty) Supabase project:

```sh
# Log in to the Supabase CLI and link the project
supabase login
supabase link --project-ref <project-ref>

# Push the migration
supabase db push
```

Or paste `supabase/migrations/001_initial_account_schema.sql` into the Supabase SQL Editor and run
it. Track which migration has been applied in your deployment notes; migrations are forward-only
(recover by restore from backup, not automatic down migrations), matching the SQLite runner's
behavior.

## 3. Row Level Security

RLS is enabled on every table with no permissive policies for the `anon` role: a browser-based
Supabase client (or a leaked anon key) can neither read nor write account data — default deny,
explicit `USING (false)` policies in the migration.

The account service connects with `SUPABASE_SERVICE_ROLE_KEY` (server-side only) and performs its
own authorization — sessions, service key, ownership — exactly as the SQLite build does. If you
ever expose a Supabase client to the frontend, it must use the `anon` key and rely on these
policies; test them by attempting reads/writes as `anon` and asserting denial.

## 4. Environment variables (server-side only)

Add to the account service's environment (never commit real values):

| Variable | Meaning | Example |
|---|---|---|
| `SUPABASE_URL` | Supabase project REST origin | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (bypasses RLS) — **secret** | `eyJ...` |
| `SUPABASE_ANON_KEY` | Anon key — reserved; unused by this migration | `eyJ...` |
| `DATABASE_URL` | Pooled PostgreSQL connection string (PgBouncer, port 6543) | `postgresql://postgres:<pw>@db.<project>.supabase.co:6543/postgres` |

`DATABASE_URL` contains a password: keep it out of git, in provider-managed secrets or the
operator's environment file (`chmod 600`). The service fails to start with a clear diagnostic if
the configured store cannot be reached — it never prints the connection string.

## 5. Migrating existing SQLite data (do not drop anything)

The existing SQLite account service (`config/account-service/accounts.sqlite` by default) is the
source of truth until cutover. Do not reset or drop it.

```sh
# 1. Back up the SQLite database while the service is stopped
sqlite3 config/account-service/accounts.sqlite ".backup /var/backups/scout-accounts-pre-supabase.sqlite"

# 2. Export accounts (and related rows) — every column is portable as-is
sqlite3 config/account-service/accounts.sqlite ".mode insert accounts" "SELECT * FROM accounts;" > accounts.sql
# repeat for sessions, devices, grants, platform_settings, events, audit_logs, account_roles,
# password_recovery_tokens, email_outbox

# 3. Load into Supabase (psql against the direct connection, or the SQL editor)
psql "$DATABASE_URL_DIRECT" -f accounts.sql   # etc., table by table, in dependency order

# 4. Verify before cutover
sqlite3 ... "SELECT count(*) FROM accounts;"   # compare with Supabase row counts
psql "$DATABASE_URL" -c "SELECT count(*) FROM accounts;"
# spot-check a few rows and relationships (sessions.account_id -> accounts.id, etc.)
```

Row counts and foreign-key relationships must match before switching the application to Supabase.
The local SQLite file is kept untouched during the test period so rollback is just re-pointing the
service at it.

## 6. Seeding and development commands

- New project, fresh start: apply `supabase/migrations/001_initial_account_schema.sql`, then create
  the owner account through the normal flow (`/apply` → approval → invite → set password) and set
  `SCOUT_OWNER_EMAIL` to that address on the host and account service.
- Owner bootstrap (hosted mode CLI):
  ```sh
  npm run account-service -- --list
  npm run account-service -- --approve owner@example.com
  ```
- Development-only auto-approve (never on public deployments): `SCOUT_BETA_AUTO_APPROVE=1`.

## 7. Render Free Tier + Supabase Cutover (`qtfbtfkthtvfpjvghyop` / `SCOUT DB`)

When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set (as in `render.yaml`), SCOUT automatically connects to Supabase PostgreSQL (`server/supabase-store.ts`):

- [x] Supabase project created on the free tier (`qtfbtfkthtvfpjvghyop` / `SCOUT DB`).
- [x] Schema updated in `supabase/migrations/001_initial_account_schema.sql` and `supabase/migrations/002_render_supabase_cutover.sql` (`BIGINT` epoch-ms columns, `GENERATED BY DEFAULT AS IDENTITY`, and `public.platform_store` with default-deny RLS).
- [x] RLS verified: `anon` role denied by default on all tables.
- [x] Account service (`server/account-service.ts`) hydrates from and flushes all 10 tables to Supabase when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are configured, passing the full account flow: apply, approve, invitation, activate, sign in, password recovery, device link, licence check.
- [x] Platform store (`server/platform.ts`) hydrates from and persists settings, tournaments, logs, and config receipts to Supabase (`public.platform_store` with fallback in `public.platform_settings`).
- [x] Single-service Render deployment (`render.yaml` / `npm start` / `server/website.ts`) embeds the account service on loopback (`SCOUT_EMBED_ACCOUNT_SERVICE=1`) so one free Render Web Service serves the website, `/api/beta/*`, `/api/platform/*`, `/admin`, and the bare account-service endpoints (`/status`, `/settings`, `/license/check`, `/applications*`).

### Deploying on Render Free Tier (100% Free)

1. Apply the schema in the Supabase SQL Editor (`qtfbtfkthtvfpjvghyop` / **SCOUT DB**):
   - If the database is empty, paste and run `supabase/migrations/001_initial_account_schema.sql`.
   - If an earlier version of `001_initial_account_schema.sql` was already applied, paste and run `supabase/migrations/002_render_supabase_cutover.sql`.
2. In Render, create a **New Web Service** (or **New Blueprint Instance** using `render.yaml`) connected to `ArliT1-F/SCOUT` on the **Free** plan:
   - **Build Command:** `npm install --include=dev && npm run build`
   - **Start Command:** `npm start`
   - **Environment Variables:**
     - `SUPABASE_URL=https://qtfbtfkthtvfpjvghyop.supabase.co`
     - `SUPABASE_SERVICE_ROLE_KEY=<service_role secret from Supabase -> Project Settings -> API>`
     - `SCOUT_OWNER_EMAIL=<your owner email address for /admin>`
     - `SCOUT_EMAIL_API_KEY=<Resend API key>`
     - `SCOUT_EMAIL_FROM=<verified sender address>`
     - `SCOUT_EMAIL_ENCRYPTION_KEY=<base64 32-byte key: openssl rand -base64 32>`
3. (Optional) If you also keep the Cloudflare Worker front-end active (`scout.arliturka2.workers.dev`), set its secret to point at the Render service so `GET /api/beta/status` no longer returns `503`:
   ```sh
   npx wrangler secret put SCOUT_ACCOUNT_SERVICE_URL
   # enter: https://<your-render-service>.onrender.com
   npx wrangler secret put SCOUT_BETA_API_KEY
   # enter the same SCOUT_BETA_API_KEY configured on Render
   ```

## 8. What stays unchanged

- `server/account-migrations.ts` and `PRAGMA user_version` govern the SQLite build; Supabase has
  its own migration tracking (Supabase CLI/schema_migrations). They evolve independently.
- Local-first operation is unchanged: a venue host with no Supabase configured works exactly as
  today (`SCOUT_DATABASE_URL` unset → SQLite file).
- CS2 GSI, overlays, OBS, recordings and the desktop app never use Supabase.
