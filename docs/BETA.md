# The closed beta: accounts, downloads and the launcher link

SCOUT is a local-first program. The host runs on the observer's machine, the overlay is a public
artifact, and nothing about a match ever leaves the venue. The only part that genuinely belongs on a
server is **distribution and identity**: who may download the launcher, and which installation
belongs to which account. That is all this document is about.

Two shapes, one set of pages:

| | local (default) | hosted |
| --- | --- | --- |
| Accounts live in | `config/beta/store.json` on the host | your service (database, email, backups) |
| Who serves `/api/beta/*` | the host itself | your service; the host **proxies** the browser's calls to it, cookies included |
| Launcher device flow | between the panel and the dashboard on this machine | the launcher talks to your service through the same host endpoints |
| Enabled by | nothing (default) | `SCOUT_BETA_API_URL` (+ optional `SCOUT_BETA_API_KEY`) |

Local mode is not a mock. It is the whole flow — apply, review, invite, password, download, device
code, revoke — with a JSON store, so an organiser can run the beta from their own broadcast machine
and moving to a hosted service later changes no page and no route.

## What the pages are

| Route | Purpose | Needs an account? |
| --- | --- | --- |
| `/welcome` | Product page, closed-beta story, how access works, FAQ | no |
| `/apply` | The whitelist application | no |
| `/login` | Account sign-in, invite activation, launcher-code approval, panel-token unlock | no |
| `/dashboard` | Beta status, launcher download (approved only), launcher link, linked devices | yes |
| `/`, `/admin` | Operator panel | panel token / local machine |
| `/obs`, `/game` | Public broadcast output | no |

The pages never talk to a cloud host directly: every call is same-origin `/api/beta/*`, and the host
decides whether that is itself or a service it proxies to. That is why a hosted deployment needs no
CORS configuration anywhere.

## The flow, end to end

1. **Apply** — `POST /api/beta/apply` with name, email, organisation, country, use case and cadence.
   Rate limited per address (3/hour). A duplicate address is refused with `already-applied`
   (`already-approved` once it is approved), and the answer never confirms whether an address is
   known beyond telling the applicant to sign in.
2. **Review** — the panel's **Beta applications** tab (owner only) lists them. Approving mints a
   one-time invite; the host prints the link:
   `[beta] approved ada@example.com — send them this one-time invite link: http://…/login?invite=…`.
   In hosted mode this is where an email would be sent instead.
3. **Set a password** — the applicant opens `/login?invite=…`, chooses a password (≥10 characters) and
   is signed in. The invite is stored as a digest, expires after 14 days, and stops working on first use.
4. **Download** — `/dashboard` shows the installer only while the account is `approved`. The URL comes
   from `SCOUT_DOWNLOAD_URL` (default: this repository's GitHub releases) so it can move to a CDN
   without a code change.
5. **Link a launcher** — the panel's *Launcher link* card calls `POST /api/beta/link/start`; the host
   asks the account service for a device grant and shows the code. The operator approves it at
   `/dashboard?link=CODE` (or on `/login` when a link code is in the URL and they are not signed in
   yet). The launcher polls, receives its installation token **once**, and writes
   `config/beta/installation.json` (mode 0600) next to the operator data.
6. **Revoke** — `/dashboard` lists linked launchers with a last-seen time and an **Unlink** button.

### Why a device code and not an email code

The launcher runs on a machine that may be behind a venue NAT with no inbound access and no mail
client. A code the operator reads off the launcher window and approves in a browser session they
already hold (RFC 8628's pattern, as GitHub and Google use it) needs no inbound connection, no SMTP,
and no password typed into a desktop app. A stolen code is useless on its own: approval requires the
account's session cookie.

## What is stored, and how

`config/beta/store.json` (gitignored, mode 0600, written atomically):

| Field | Stored as |
| --- | --- |
| account password | scrypt digest + salt (never the password) |
| account session | SHA-256 digest of the cookie value, plus address/UA/timestamps |
| invite token | SHA-256 digest + 14-day expiry |
| device code | SHA-256 digest, 10-minute expiry |
| installation token | SHA-256 digest after it has been collected once; handed to the launcher exactly once |
| user code | plain (`ABCD-EFGH`): it is the half a human reads and types, and it is worthless without the session that approves it |

`config/beta/installation.json` (gitignored, mode 0600) holds the installation's own identity: the
device id, the account it was linked to and the token it presents. It lives under the operator data
directory, so an installer update never loses it and an uninstall can remove it deliberately.

Rate limits: 3 applications per address per hour, 8 failed sign-ins per address per 15 minutes, and at
most 20 pending launcher codes at a time. They live in memory and reset with the host.

## The REST contract a hosted service has to implement

Everything is JSON, errors are `{error, code}` with a meaningful HTTP status, and success is the raw
value. The host proxies `GET|POST /api/beta/<path>` to `${SCOUT_BETA_API_URL}/<path>` and passes the
`Set-Cookie` headers back untouched, so a service only has to be reachable over HTTPS.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/status` | — | `BetaStatusView` |
| POST | `/apply` | `ApplicationInput` + `address` | `{account, invite}` |
| POST | `/login` | `{email, password, address, userAgent}` | `{account}` + `Set-Cookie: scout_account=…` |
| POST | `/logout` | — (cookie) | `{ok:true}` + cleared cookie |
| POST | `/activate` | `{invite, password, address}` | `{account}` + cookie |
| GET | `/applications` | — (service key) | `{applications: AccountView[]}` |
| POST | `/applications/:id` | `{decision, decidedBy}` | `{account, invite}` — `invite` is the one-time value |
| POST | `/device/start` | `{label, platform, origin}` | `DeviceGrantView` |
| POST | `/device/poll` | `{deviceCode}` | `DevicePollView` |
| POST | `/device/approve` \| `/device/deny` | `{userCode}` + cookie | `{account}` |
| POST | `/devices/revoke` | `{deviceId}` + cookie | `{account}` |

Types are exported from [`server/beta.ts`](../server/beta.ts) (`BetaStatusView`, `AccountView`,
`ApplicationInput`, `DeviceGrantView`, `DevicePollView`, `InstallationView`) and are imported by the
pages, so the contract cannot drift from the UI without a type error. The host's own two endpoints —
`/api/beta/link` (read the installation's link state) and `/api/beta/link/start|unlink` (owner only) —
are never proxied: they are about *this* installation.

`SCOUT_BETA_API_KEY` is sent as `Authorization: Bearer …` on the calls the host makes itself
(listing and deciding applications in hosted mode).

### What a hosted service still has to add

- **Email.** Invite links and password resets. The beta hands the link to the operator because a host
  with no mail server must still work; a real deployment sends it.
- **Password reset.** The local flow deliberately has none beyond "ask for a new invite".
- **Enforcement in the launcher.** Today the link is identity, not a licence: the panel keeps running
  offline, as a broadcast tool must. Gating features on a valid, unrevoked token is the next step
  (`installation.json` already holds the token, and `tokenDigest` on the account side makes
  verification a digest comparison).
- **Terms, privacy and a deletion path.** The application form collects a name, an address and a use
  case; a public deployment needs the paperwork and a `DELETE /account` behind it.

## Verified here

`tests/beta.test.ts` pins the behaviour rather than the prose: a stranger can apply and nothing else,
applications are rate limited, only an approval mints an invite, an invite works once, sign-in is
throttled, a launcher code needs the account session, the installation token is handed over exactly
once, an expired code stops working, the store survives a restart with sessions intact, the on-disk
file contains no plaintext password/invite/device-code/installation-token, and the page components
render the states they claim (visitor vs. signed in, pending vs. approved download). The whole flow was
also driven over HTTP against a running host, with the resulting store inspected by hand.
