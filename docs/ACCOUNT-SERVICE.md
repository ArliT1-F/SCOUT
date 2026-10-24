# Running the hosted account service

`server/account-service.ts` is the service `docs/BETA.md` describes: one process, one SQLite file,
no external database server or SQLite driver (it uses Node's own `node:sqlite`). It answers the same
REST contract the local store does, so the host, the website, the app's dashboard and the launcher do
not know — or care — which of the two they are talking to.

You need it when the accounts should outlive one observer's machine, when several operators share an
event, or when the beta should keep working while the machine that runs the broadcast is off. You do
**not** need it to broadcast: nothing about match data, layouts or output goes through it. A match
runs with the account service down; sign-in, linking and authenticated platform sync pause, while
the venue host keeps its local config/output and queues metrics for later delivery.

## Start it

```sh
SCOUT_BETA_API_KEY=$(openssl rand -hex 24) \
SCOUT_ACCOUNT_BASE_URL=https://accounts.example.com \
SCOUT_OWNER_EMAIL=you@example.com \
npm run account-service
# [accounts] account service listening on http://127.0.0.1:8790 (SQLite: config/account-service/accounts.sqlite, 0 account(s))
# [accounts] point the SCOUT host here: SCOUT_BETA_API_URL=http://<this machine>:8790 ...
```

Then put the same key on the host and point it at the service:

```sh
SCOUT_BETA_API_URL=https://accounts.example.com \
SCOUT_BETA_API_KEY=<the same key> \
SCOUT_OWNER_EMAIL=you@example.com \
npm start
```

Both commands also read a `.env` file from the working directory, so the same block can be written
once instead: `cp .env.example .env` and fill it in. Real environment variables win over the file.
`PORT` is shared by the host and this service — when both run on one machine, give the service its
own port on the command line (`PORT=8790 npm run account-service`) rather than in a shared `.env`.

`SCOUT_OWNER_EMAIL` names the account that may write `/settings`; it is **not** a password. The owner signs in with a password set through the normal one-time invitation email. There is no password setting in the file or the environment.

The host proxies the browser's `/api/beta/*` calls to the service, cookies included, so there is no
CORS configuration anywhere and the pages keep talking to their own origin. `SCOUT_BETA_API_KEY` is
sent as `Authorization: Bearer …` on the calls the *host* makes (listing and deciding applications),
which is what lets an operator keep reviewing applications from the panel — and it is why the service
refuses those routes outright when no key is configured.

| Environment variable | Default | What it does |
| --- | --- | --- |
| `SCOUT_ACCOUNT_DB` | `config/account-service/accounts.sqlite` | The whole state. Back it up like a database, because that is what it is. |
| `PORT`, `HOST` | `8790`, `0.0.0.0` | Where it listens. Put TLS (nginx, Caddy, a load balancer) in front of it; it speaks plain HTTP. |
| `SCOUT_BETA_API_KEY` | — | Service key for `/applications*`, `GET /settings`, and the internal identity extension of `/license/check`. Unset closes service-only routes with `503 service-key-required`. It cannot substitute for an owner session on `PUT /settings`. |
| `SCOUT_OWNER_EMAIL` | — | The approved account allowed to write `/settings`. Set the same email on the central SCOUT host. Unset leaves settings writes closed. |
| `SCOUT_DOWNLOAD_URL` / `SCOUT_DOWNLOAD_VERSION` / `SCOUT_DOWNLOAD_NOTES` | the repository's GitHub releases | What `/status` offers to an approved account. A release published on the host (Operations tab) overrides it. |
| `SCOUT_ACCOUNT_APPLICATIONS` | open | **Initial seed only:** `closed` seeds `applicationsOpen:false`. After first start, change applications-open in `/admin` or `PUT /settings`, not this variable. Existing accounts keep working. |
| `SCOUT_ACCOUNT_REVIEW_NOTE` | empty | **Initial seed only:** the review note shown to applicants and in the app's dashboard. Subsequent edits come from the persisted settings desk. |
| `SCOUT_ACCOUNT_NAME` | `SCOUT account service` | The name `/status` reports as the host behind the beta. |
| `SCOUT_ACCOUNT_BASE_URL` | — | Public HTTPS origin used to construct invitation and password-recovery links. Required for delivery. |
| `SCOUT_EMAIL_API_KEY` | — | Resend API key (or key accepted by a compatible configured endpoint). |
| `SCOUT_EMAIL_FROM` | — | Verified sender address, optionally `SCOUT <mail@example.com>`. |
| `SCOUT_EMAIL_ENCRYPTION_KEY` | — | 32 random bytes, base64 or 64 hex chars. Protect separately from the SQLite backup; required to decrypt queued messages. |
| `SCOUT_EMAIL_API_URL` | `https://api.resend.com/emails` | Provider endpoint; HTTPS in production, loopback HTTP allowed for development/tests. |

## Persisted platform settings

The service owns one `platform_settings` SQLite row. On first start (including the first
upgrade with this table), applications-open and review-note are seeded from the existing
variables above; other platform settings use SCOUT's defaults. Restarts and later environment
changes **do not overwrite** the row. Configure any custom tournament limit/public-stats choice
from `/admin` when moving an existing central JSON settings desk to the hosted desk.

- **`GET /settings`** → `{settings:{maxTournamentsPerUser,applicationsOpen,reviewNote,
  publicStatsEnabled,version,updatedAt,updatedBy}}`. Requires
  `Authorization: Bearer <SCOUT_BETA_API_KEY>`; this is a host-to-service read, not a public
  browser route.
- **`PUT /settings`**, body: partial settings object. Requires the approved **owner account
  session cookie**, matched to `SCOUT_OWNER_EMAIL`; a service key alone is refused. Known
  fields are sanitized, unknown fields ignored, and each save bumps the version and records
  the owner's email/time. Cross-site requests are refused.

The central host reads this row for its platform desk and application flow, and forwards
`PUT /api/platform/admin/settings` with the owner's cookie. The owner's `betaReviewers` list is normalized and synchronized transactionally to `account_roles`; new activations receive the configured role too. Only the owner may edit the list; reviewers may access the application review routes, not platform settings. `/status` and `/apply` on this
service also read it directly: closing applications refuses the **very next** application,
without a restart, including callers that bypass the host. The browser's generic account
proxy does not expose `/settings` or the internal device identity lookup.

`POST /license/check` still returns the ordinary licence view for installation-token callers.
Only a service-key-authenticated call with `resolveAccount:true` may additionally resolve
`accountId`, and only after validating an active device on an approved account. The central
platform uses that identity for `POST /api/platform/device/sync` and `/metrics`; no match data
or event packs are sent to the account service. See [PLATFORM.md](PLATFORM.md#launcher-sync).

Behind a reverse proxy, forward `X-Forwarded-Proto` — the account cookie is marked `Secure` when the
request arrives over https, and the same header is what the service trusts for that decision.

### A systemd unit, roughly

```ini
[Unit]
Description=SCOUT account service
After=network-online.target

[Service]
WorkingDirectory=/srv/scout
EnvironmentFile=/etc/scout/accounts.env
ExecStart=/usr/bin/npm run account-service
Restart=always
User=scout

[Install]
WantedBy=multi-user.target
```

`/etc/scout/accounts.env` holds the variables above (`SCOUT_BETA_API_KEY=…`,
`SCOUT_ACCOUNT_BASE_URL=https://accounts.example.com`, `SCOUT_ACCOUNT_DB=/var/lib/scout/accounts.sqlite`).
Back up the SQLite file with `sqlite3 accounts.sqlite ".backup /var/backups/scout-accounts.db"`, which
is safe while the service runs.

## Working on it without a browser

The service has a small CLI for a deployment nobody is watching:

```sh
npm run account-service -- --list                 # status, address, date and organisation per application
npm run account-service -- --approve ada@example.com  # queues and attempts invitation delivery
npm run account-service -- --revoke ada@example.com shared credentials  # cuts access at once; the trailing words are the recorded reason
```

Approval requires complete email configuration and fails without changing the pending application if any required setting is absent. The encrypted outbox retries transient delivery failures with bounded backoff. The command reports that delivery was attempted, not that the recipient has read the message; use the admin delivery status and `/healthz` to monitor retries. Invite URLs and tokens are never printed.

`GET /healthz` answers `{ok,accounts,pending,devices,emailDeliveryConfigured,emailOutboxPending,emailOutboxRejected,emailLastFailure}` for a supervisor or an uptime check. `emailLastFailure` carries the newest failing outbox row's error code, provider HTTP status, provider error name, operator guidance and next retry time — no addresses, bodies or tokens.

### When email delivery fails

A log line like `[accounts] email delivery <id> deferred (provider-rejected)` means the mail
provider refused the message and the outbox will retry it on the bounded backoff schedule. The
service never logs the refusal payload (it can embed recipient addresses), so diagnose by code:

1. Read the review desk: a failing invitation says **Delivery needs attention**, names the provider
   error (e.g. `HTTP 403 · validation_error`), and prints the recommended fix.
2. `provider-rejected` with HTTP 401 (`missing_api_key`, `restricted_api_key`): the
   `SCOUT_EMAIL_API_KEY` is absent, wrong or IP-restricted. Recreate it in Resend and update the
   service's environment.
3. `provider-rejected` with HTTP 403: the sender identity is not usable — verify the sending
   domain at resend.com/domains; `onboarding@resend.dev` only delivers to the account's own
   address, so test deliveries to other addresses fail this way.
4. `provider-rejected` with HTTP 400/422: the sender/recipient payload is malformed (check
   `SCOUT_EMAIL_FROM` and the queue payload shape) — retrying alone will not fix it.
5. `transient` with HTTP 429: the provider asked to slow down; the outbox backs off and retries
   by itself.
6. `transient` with HTTP 0 or 5xx: the provider had an outage, or the service never reached it —
   check network egress and `SCOUT_EMAIL_API_URL`.

Fixing the underlying cause is enough: the queued message retries automatically, or a reviewer can
resend the invitation from the desk.

## What it stores, and what it will never store

The digest table is `docs/BETA.md`'s: passwords as salted scrypt digests, sessions, invites, device
codes and installation tokens as SHA-256 digests. The only plaintext secrets that exist at all are

- the invitation or recovery email while queued, encrypted using AES-256-GCM and erased after successful delivery,
- the invite token, between the approval and the moment the applicant sets a password (24-hour default expiry),
- the installation token, between the approval and the launcher's **first** poll — after that the row
  holds nothing but its digest, and a launcher that missed the pickup starts a new link.

`tests/account-service.test.ts` drives the flow over a socket and inspects the database file to verify that password, invite, recovery token, device code, installation token and queued-email plaintext are not stored as usable values.

Legacy events (applications, sign-ins, activations, launcher link/revoke) continue to be appended to the existing `events` table for compatibility. Phase 2 also records actor/action/target/request ID in the dedicated indexed `audit_logs` table; each new audit row and its legacy `events` counterpart commit together. Audit metadata excludes the legacy free-form details, email addresses, user codes, tokens and request bodies. No broadcast state is sent here. HTTP logs use generated request IDs and safe error classes rather than exception/request text.

## Revoking an account

**When:** a tester abuses the beta — exploit, offence, leaked credentials — and must lose access
immediately. Revocation keeps the account row for audit while cutting off everything the account
could do.

**How:** on the owner `/admin` desk (or the panel review desk), an approved account gets a
**Revoke access** button. Confirming it optionally records a short reason (280 characters, shown
only to reviewers) with the decision.

Revoking does, in one store transaction:

- sets the account to `revoked` and stamps reviewer + reason,
- deletes every session (signed out everywhere, immediately),
- revokes every linked launcher (the launcher loses entitlement on its next licence check),
- clears the invitation and recovery tokens,
- deletes queued mail for the address, including the invitation row.

After that the address gets `403 revoked` from `/login` and `/apply`, cannot link a launcher, and
cannot see the download. Linked launchers report `revoked` from `/license/check`, and the decision
is written to the audit log as `beta.account.revoked` with the reviewer and the reason.

**Rejected is not revoked.** `reject` is the answer to an application that was never approved
(rejecting an already-approved account still cuts access, as before). `revoked` is the answer to an
account that *was* approved and lost it. Both statuses are terminal — the desk offers no further
action for them.

**Undo:** revocation keeps the password digest, precisely so a mistaken revocation is recoverable.
There is deliberately no desk button for this; an operator with database access restores the status
directly:

```sql
UPDATE accounts SET status='approved', revoked_reason=NULL WHERE normalized_email='name@example.com';
```

Then resend an invitation from the desk if one is needed — the account signs in with its existing
password.

## What is still missing

- **Account deletion.** `DELETE /account` and the paperwork around it (`docs/BETA.md` lists the terms
  and privacy gap). Until then, a rejected applicant's row can be removed by hand:
  `sqlite3 accounts.sqlite "DELETE FROM accounts WHERE email = '…';"`.
- **Migration from the local JSON store.** There is none, deliberately: the local store is meant for
  one machine. Approve the same addresses again here and send them a fresh invite — the launcher's
  `config/beta/installation.json` is unchanged by the move, but the installation is *unlinked* on the
  service's side until somebody approves a new code in the app's dashboard (or at the website's `/login?link=`).

## Upgrading and recovery

At startup, `server/account-migrations.ts` applies forward-only SQLite migrations in an immediate
transaction and records the version in `PRAGMA user_version`. There is no separate CLI migration
command: take a verified SQLite backup first, deploy the compatible server binary, and let startup
apply any pending migration. A failed migration rolls back and prevents the service from listening;
restore the backup or correct the reported precondition before retrying.

Version 1 adopts the previous schema with idempotent `CREATE TABLE IF NOT EXISTS`; it does not rebuild
or delete existing tables. Version 2 adds case-insensitive unique email enforcement, query indexes and
the dedicated `audit_logs` table while preserving the legacy `events` table. Version 3 adds role
columns to SQLite, and version 4 adds the revocation reason plus the outbox failure detail columns
(provider HTTP status and provider error name). If V2 reports duplicate emails after trimming and case normalization, back up the database, resolve those duplicates with the account owner, then restart.
No rows are automatically merged or deleted. Migrations are forward-only; recovery is restore-from-
backup, not an automatic down migration.

To inspect the current version:

```sh
sqlite3 config/account-service/accounts.sqlite 'PRAGMA user_version;'
```

A representative migration-and-restart path is covered by `tests/account-service.test.ts` using a
pre-migration database file and an existing account row. The backup/restore command above is the
operational recovery path; production restoration should be rehearsed before launch.
