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

`SCOUT_OWNER_EMAIL` names the account that may write `/settings`; it is **not** a password. The owner
signs in with a password set through the normal one-time invite link (`--approve` prints it). There is
no password setting in the file or the environment.

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
| `SCOUT_ACCOUNT_BASE_URL` | — | Only for the CLI: the address used to print a full invite link. |

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
`PUT /api/platform/admin/settings` with the owner's cookie. `/status` and `/apply` on this
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
npm run account-service -- --approve ada@example.com
# [accounts] approved ada@example.com
# [accounts] send them this one-time invite link:
# [accounts]   https://accounts.example.com/login?invite=…
```

Approving prints the invite link because this service deliberately does not send email. The operator
who ran the command sends it — the same division of labour the local flow uses when it prints the link
to the panel console. Wiring an SMTP sender in is the deployment's business; the invite value is the
only thing it needs.

`GET /healthz` answers `{ok,accounts,pending,devices}` for a supervisor or an uptime check.

## What it stores, and what it will never store

The digest table is `docs/BETA.md`'s: passwords as salted scrypt digests, sessions, invites, device
codes and installation tokens as SHA-256 digests. The only plaintext secrets that exist at all are

- the invite token, between the approval and the moment the applicant sets a password (14-day expiry),
- the installation token, between the approval and the launcher's **first** poll — after that the row
  holds nothing but its digest, and a launcher that missed the pickup starts a new link.

`tests/account-service.test.ts` drives the whole flow over a socket and then reads the database file
to assert that the password, the invite, the device code and the installation token do not appear in
it.

Events (applications, sign-ins, activations, launcher link/revoke) are appended to an `events` table;
nothing else is logged about an account, and nothing about a broadcast is ever sent here.

## What is still missing

- **Email** for invite links and password resets. `--approve` prints the link; a real deployment mails
  it.
- **Account deletion.** `DELETE /account` and the paperwork around it (`docs/BETA.md` lists the terms
  and privacy gap). Until then, a rejected applicant's row can be removed by hand:
  `sqlite3 accounts.sqlite "DELETE FROM accounts WHERE email = '…';"`.
- **Migration from the local JSON store.** There is none, deliberately: the local store is meant for
  one machine. Approve the same addresses again here and send them a fresh invite — the launcher's
  `config/beta/installation.json` is unchanged by the move, but the installation is *unlinked* on the
  service's side until somebody approves a new code in the app's dashboard (or at the website's `/login?link=`).

## Upgrading

The schema (including the settings row's table) is created with `CREATE TABLE IF NOT EXISTS` on every start, and adding a column is a
one-line migration to apply before the new build starts. There is no separate migration step and no
version table yet; if the schema grows, that is the first thing to add (and it belongs in this
document, not in a commit message).
