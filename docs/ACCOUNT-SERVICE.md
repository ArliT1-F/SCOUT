# Running the hosted account service

`server/account-service.ts` is the service `docs/BETA.md` describes: one process, one SQLite file,
no dependencies beyond Node's own `node:http`, `node:crypto` and `node:sqlite`. It answers the same
REST contract the local store does, so the host, the landing page, the dashboard and the launcher do
not know — or care — which of the two they are talking to.

You need it when the accounts should outlive one observer's machine, when several operators share an
event, or when the beta should keep working while the machine that runs the broadcast is off. You do
**not** need it to broadcast: nothing about match data, layouts or output goes through it. A match
runs perfectly with the account service down; only sign-in and the launcher link stop working.

## Start it

```sh
SCOUT_BETA_API_KEY=$(openssl rand -hex 24) \
SCOUT_ACCOUNT_BASE_URL=https://accounts.example.com \
npm run account-service
# [accounts] account service listening on http://127.0.0.1:8790 (SQLite: config/account-service/accounts.sqlite, 0 account(s))
# [accounts] point the SCOUT host here: SCOUT_BETA_API_URL=http://<this machine>:8790 ...
```

Then put the same key on the host and point it at the service:

```sh
SCOUT_BETA_API_URL=https://accounts.example.com \
SCOUT_BETA_API_KEY=<the same key> \
npm start
```

The host proxies the browser's `/api/beta/*` calls to the service, cookies included, so there is no
CORS configuration anywhere and the pages keep talking to their own origin. `SCOUT_BETA_API_KEY` is
sent as `Authorization: Bearer …` on the calls the *host* makes (listing and deciding applications),
which is what lets an operator keep reviewing applications from the panel — and it is why the service
refuses those routes outright when no key is configured.

| Environment variable | Default | What it does |
| --- | --- | --- |
| `SCOUT_ACCOUNT_DB` | `config/account-service/accounts.sqlite` | The whole state. Back it up like a database, because that is what it is. |
| `PORT`, `HOST` | `8790`, `0.0.0.0` | Where it listens. Put TLS (nginx, Caddy, a load balancer) in front of it; it speaks plain HTTP. |
| `SCOUT_BETA_API_KEY` | — | The service key for `/applications*`. Unset means those routes answer `503 service-key-required` — closed, not open. |
| `SCOUT_DOWNLOAD_URL` / `SCOUT_DOWNLOAD_VERSION` / `SCOUT_DOWNLOAD_NOTES` | the repository's GitHub releases | What `/status` offers to an approved account. A release published on the host (Operations tab) overrides it. |
| `SCOUT_ACCOUNT_APPLICATIONS` | open | `closed` stops taking applications; the accounts that exist keep working. |
| `SCOUT_ACCOUNT_REVIEW_NOTE` | empty | A sentence shown on the dashboard (used by request, e.g. "wave 2 opens in March"). |
| `SCOUT_ACCOUNT_NAME` | `SCOUT account service` | The name `/status` reports as the host behind the beta. |
| `SCOUT_ACCOUNT_BASE_URL` | — | Only for the CLI: the address used to print a full invite link. |

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
  service's side until somebody approves a new code from the new dashboard.

## Upgrading

The schema is created with `CREATE TABLE IF NOT EXISTS` on every start, and adding a column is a
one-line migration to apply before the new build starts. There is no separate migration step and no
version table yet; if the schema grows, that is the first thing to add (and it belongs in this
document, not in a commit message).
