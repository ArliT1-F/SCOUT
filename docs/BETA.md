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
| Launcher device flow | between the launcher and the app's dashboard on this machine | the launcher talks to your service through the same host endpoints |
| Enabled by | nothing (default) | `SCOUT_BETA_API_URL` (+ optional `SCOUT_BETA_API_KEY`) |

Local mode is not a mock. It is the whole flow — apply, review, invite, password, download, device
code, revoke — with a JSON store, so an organiser can run the beta from their own broadcast machine
and moving to a hosted service later changes no page and no route.

## What the pages are

The website carries the public pages and an owner/reviewer-only application desk; the dashboard and every overlay setting are
part of the installed app.

| Route | Where | Purpose | Needs an account? |
| --- | --- | --- | --- |
| `/welcome` | website | Product page, closed-beta story, how access works, FAQ | no |
| `/apply` | website | The whitelist application | no |
| `/login` | website | Account sign-in, invite activation, launcher-code approval, panel-token unlock | no |
| `/download` | website | The installer, approved accounts only | yes |
| `/privacy` | website | What is collected, retention, deletion, analytics allowlist | no |
| `/admin` | website | The SCOUT owner's desk — **Beta applications**, **Operations** (health, releases, requests), platform settings | owner account; configured reviewers see applications only |
| `/app` | app | Dashboard: beta status, tournaments, launcher link, linked devices | no (the account cards need one) |
| `/`, `/panel` | app | Control panel — teams, players, maps, scenes and every overlay setting | panel token / local machine |
| `/obs`, `/game` | app | Public broadcast output | no |

The pages never talk to a cloud host directly: every call is same-origin `/api/beta/*`, and the host
decides whether that is itself or a service it proxies to. That is why a hosted deployment needs no
CORS configuration anywhere.

## The flow, end to end

1. **Apply** — `POST /api/beta/apply` with name, email, organisation, country, use case and cadence.
   Rate limited per address (3/hour). A duplicate address is refused with `already-applied`
   (`already-approved` once it is approved), and the answer never confirms whether an address is
   known beyond telling the applicant to sign in.
2. **Review** — the website's **Beta applications** desk is available to the configured owner and explicitly configured beta reviewers; on a local host, the panel owner remains supported. Approving mints a one-time invite and queues an email. The browser receives delivery status only, never the invite URL or token. If outbound email is not configured, approval fails visibly with an actionable setup error and remains pending.
3. **Set a password** — the applicant opens the emailed `/login?invite=…` link, chooses a password (≥10 characters) and is signed in. The token is stored as a digest, expires after 24 hours by default, and stops working on first use. Reviewers may resend a fresh invitation to approved, not-yet-activated accounts; previous tokens are invalidated.
4. **Download** — `/download` shows the installer only while the account is `approved`. The URL comes
   from `SCOUT_DOWNLOAD_URL` (default: this repository's GitHub releases) so it can move to a CDN
   without a code change.
5. **Link a launcher** — the panel's *Launcher link* card calls `POST /api/beta/link/start`; the host
   asks the account service for a device grant and shows the code. The operator approves it in the
   app's dashboard, on the **Launcher link** card. If they are on the website instead,
   `/login?link=CODE` does the same thing once they sign in. The launcher polls, receives its
   installation token **once**, and writes `config/beta/installation.json` (mode 0600) next to the
   operator data.
6. **Revoke** — the app's dashboard lists linked launchers with a last-seen time and an **Unlink** button.
   Revoking takes effect on the launcher's next licence check (within 15 minutes; immediately on a
   restart), and the launcher says so rather than dying quietly.
7. **Run** — the launcher asks about itself every 15 minutes and caches the answer. The states it can
   report are `active`, `pending`, `unlinked`, `revoked`, `unknown` (the service does not know this
   installation — link it again) and `offline` (nobody answered; the last verified answer stays in
   force for a seven-day grace window). Only an explicit refusal stops the overlay, and only when
   enforcement is switched on.

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
| invite token | SHA-256 digest + 24-hour default expiry; single use |
| outbound email | AES-256-GCM encrypted outbox payload, cleared after successful delivery |
| password recovery token | SHA-256 digest, one-hour default expiry, single use |
| device code | SHA-256 digest, 10-minute expiry |
| installation token | SHA-256 digest after it has been collected once; handed to the launcher exactly once |
| user code | plain (`ABCD-EFGH`): it is the half a human reads and types, and it is worthless without the session that approves it |

`config/beta/installation.json` (gitignored, mode 0600) holds the installation's own identity: the
device id, the account it was linked to and the token it presents. It lives under the operator data
directory, so an installer update never loses it and an uninstall can remove it deliberately.

Rate limits: 3 applications per address per hour, 8 failed sign-ins per address per 15 minutes, 5 password-recovery requests per address per hour and 5 per normalized account address per hour, and at most 20 pending launcher codes at a time. They live in memory and reset with the service.

## The REST contract a hosted service has to implement

Everything is JSON, errors are `{error, code}` with a meaningful HTTP status, and success is the raw
value. The host proxies `GET|POST /api/beta/<path>` to `${SCOUT_BETA_API_URL}/<path>` and passes the
`Set-Cookie` headers back untouched, so a service only has to be reachable over HTTPS.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/status` | — | `BetaStatusView` |
| POST | `/apply` | `ApplicationInput` + `address` | `{account, invite:null}`; invitation is never returned to browser |
| POST | `/login` | `{email, password, address, userAgent}` | `{account}` + `Set-Cookie: scout_account=…` |
| POST | `/logout` | — (cookie) | `{ok:true}` + cleared cookie |
| POST | `/activate` | `{invite, password, address}` | `{account}` + cookie |
| GET | `/applications` | — (service key) | `{applications, invitations}` delivery metadata |
| POST | `/applications/:id` | `{decision, decidedBy}` | `{account, invite, invitationDelivery}`; service-key-only backend response, not exposed to browser |
| POST | `/applications/:id/resend-invitation` | `{requestedBy}` | account and invitation delivery metadata |
| POST | `/password-recovery` | `{email}` | generic non-enumerating acknowledgement |
| POST | `/password-recovery/complete` | `{token, password}` | `{ok:true}`; revokes existing sessions |
| PUT | `/settings` | partial settings + owner cookie | persisted platform settings and reviewer roles |
| POST | `/device/start` | `{label, platform, origin}` | `DeviceGrantView` |
| POST | `/device/poll` | `{deviceCode}` | `DevicePollView` |
| POST | `/device/approve` \| `/device/deny` | `{userCode}` + cookie | `{account}` |
| POST | `/devices/revoke` | `{deviceId}` + cookie | `{account}` |
| POST | `/license/check` | `{deviceId, installationId, token}` | `{status: active\|revoked\|unknown, email?, displayName?}` |
| GET | `/healthz` | — | `{ok, accounts, pending, devices}` |

`/license/check` is what the launcher's licence check asks (`server/licensing.ts`, and the shell's own
parser in `src-tauri/core/src/licence.rs`). It answers `200` with `unknown` for a device the service
has never heard of and `revoked` for a wrong token, a revoked device or a non-approved account —
never an error status, because the launcher has to be able to tell *"you are not entitled"* from
*"nobody answered"*: the first hides the overlay when enforcement is on, the second must not.

**A reference implementation ships in this repository.** `server/account-service.ts` is the whole
contract behind one HTTP listener and one SQLite file, with no dependencies beyond Node's own. Run it
with `npm run account-service`; `docs/ACCOUNT-SERVICE.md` covers deployment, backups, the CLI and what
it deliberately leaves out.

Types are exported from [`server/beta.ts`](../server/beta.ts) (`BetaStatusView`, `AccountView`,
`ApplicationInput`, `DeviceGrantView`, `DevicePollView`, `InstallationView`) and are imported by the
pages, so the contract cannot drift from the UI without a type error. The host's own two endpoints —
`/api/beta/link` (read the installation's link state) and `/api/beta/link/start|unlink` (owner only) —
are never proxied: they are about *this* installation.

`SCOUT_BETA_API_KEY` is sent as `Authorization: Bearer …` on the calls the host makes itself
(listing and deciding applications in hosted mode).

### Remaining operational work

- **Terms, privacy and a deletion path.** The application form collects a name, an address and a use
  case; a public deployment needs the paperwork and a `DELETE /account` behind it.
- **Enforcement in the launcher.** The link is now also a licence — `GET /api/beta/license` on the
  host, `/license/check` on the account service, and the shell refuses to draw the overlay when the
  answer is an explicit refusal *and* the deployment asked for enforcement
  (`SCOUT_REQUIRE_LICENCE=1` on the host, `SCOUT_SHELL_REQUIRE_LINK=1` on the launcher). It is off by
  default on purpose: a broadcast tool that stops working because a licence server is unreachable
  would be a worse failure than a licence that is not enforced. The broadcast itself — panel, output,
  GSI, recording — is never gated, in any mode.

## Verified here

`tests/beta.test.ts` pins the local state machine and legacy workflows; `tests/account-service.test.ts` drives the hosted service over HTTP, including encrypted-email delivery, missing mail configuration, expiry/replacement, concurrent single-use activation, recovery expiry/reuse/session revocation and stored-secret checks. `tests/surface.test.ts` exercises the real website's owner/reviewer access, denial for anonymous and ordinary accounts, invite-secret non-disclosure, and activation from delivered mail. `tests/platform-sync.test.ts` and `tests/licensing.test.ts` retain the hosted/local broadcast and entitlement regression coverage.
