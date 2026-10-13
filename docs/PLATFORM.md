# Hosted multi-tenancy, the SCOUT owner admin, and platform metrics

## Model
- **Whitelisting** is unchanged: an account is usable when the SCOUT owner approves its
  application (`server/beta.ts` locally, `server/account-service.ts` hosted).
- **Every approved account owns independent workspaces.** From `/dashboard` → *My tournaments*
  a whitelisted user creates their own tournaments: name + a normalized `ScoutConfig` (teams,
  rosters, maps, bracket). They live in `config/platform/store.json` (gitignored, mode 0600).
  Browser tournament routes resolve the account from its session and enforce ownership.
- **Activating** loads the tournament into this host's live workspace (`config/teams.json` +
  broadcast). Each account also retains its own active selection, so activating another
  account's workspace does not change what the first account's linked venues pull.
- **One live match per host remains the rule.** GSI and WebSockets are not tenant-scoped.
  The hosted topology is a central platform plus a launcher/host per venue, each with its own
  feed and output, not simultaneous live tournaments on one central box.
- **Limit:** `maxTournamentsPerUser` defaults to **3 during beta**; the owner can set it to
  **1 for release** in `/admin`.

## /admin — only the SCOUT owner
Set `SCOUT_OWNER_EMAIL` to your account email. `/admin`, `GET /api/platform/admin` and
`PUT /api/platform/admin/settings` require an approved account session with exactly that
email; panel owner tokens do not substitute. When configured, whitelist decisions also
require the owner account. Unset, `/admin` stays closed and the panel retains its legacy
local-owner behaviour.

The desk shows whitelist review, user/tournament totals, recent match logs and platform
settings. Settings (`maxTournamentsPerUser`, `applicationsOpen`, `reviewNote`,
`publicStatsEnabled`) carry a monotonically increasing version. Owner saves broadcast them
in `platform.settings`; connected central panels receive them immediately or on the next
~1-second WebSocket heartbeat.

### One settings desk
In hosted account mode the **account service's persisted `/settings` row is authoritative**.
The host reads it with its service key and forwards owner writes with the owner's account
cookie. Set the same `SCOUT_OWNER_EMAIL` on both processes. A service key alone cannot change
settings. The platform JSON store is the host's cached copy; in standalone mode it remains
the authority.

`/api/beta/status` and `/api/beta/apply` consult these settings on the next request. Closing
applications in `/admin` therefore closes the real application flow immediately, without
restarting either process, and the review note is the same everywhere. Account service
`SCOUT_ACCOUNT_APPLICATIONS` and `SCOUT_ACCOUNT_REVIEW_NOTE` are **initial seed only**, not
ongoing overrides. See [ACCOUNT-SERVICE.md](ACCOUNT-SERVICE.md).

## Launcher sync
Sync is **opt-in on the venue host**: set `SCOUT_PLATFORM_URL` to the **central SCOUT host**.
It is **not `SCOUT_BETA_API_URL`**: that URL points to the account service, which has account,
device-code and licence routes but **no `/api/platform/*` routes**. Leave the platform URL
unset and there is no sync timer, sync state or metric outbox; ordinary local operation is
unchanged.

The launcher uses its existing installation token from `config/beta/installation.json`
(mode 0600). The account/device store retains only the token digest after the one-time
handover. No additional password or browser cookie is needed for sync. The central host
validates it through `installationStatus()` and resolves the account internally. That
identity extension is service-key protected in hosted mode and never exposed by the
browser proxy or a licence view. Never ship the central service key to venue PCs merely
to enable sync.

A small agent (`server/platform-sync.ts`, started by `server/index.ts`) polls every **15
seconds**, with one request cycle in flight and bounded network timeouts. It uses outbound
HTTP, not push or inbound venue ports: launcher PCs behind venue NATs need no port forwarding.
Use HTTPS outside a trusted LAN; the body contains the installation credential.

### Device API on the central host
`POST /api/platform/device/sync`:

```json
{
  "deviceId": "linked-device-id",
  "installationId": "installation-id",
  "token": "installation-token",
  "knownConfigHash": "",
  "knownConfigVersion": 0,
  "knownTournamentId": null,
  "knownSettingsVersion": 0,
  "appVersion": "0.1.0"
}
```

An active reply is `{status:"active"}` plus only changed settings/tournament data.
`tournament`, when present, contains `{id,name,configHash,configVersion,updatedAt,pack?}`.
`pack` is the existing validated SCOUT event pack, rather than a raw config with unusable
upload references. It carries match config and referenced logos, player photos and map
artwork; the trusted `createEventPack()` / `restoreEventPack()` validation and **50 MB
unpacked asset cap** still apply. Metadata-only updates need no pack. `tournament:null`
means there is no active configured workspace; it never clears the on-air config.

`configHash` is SHA-256 of the schema-normalized config. The agent tracks **both** the
central hash and the restored local hash, because event-pack restoration safely remaps
artwork paths. Unchanged hashes do not rewrite `config/teams.json` or trigger config
broadcasts. Saved inactive workspaces keep their referenced uploads for future packs.

**Scope:** only match config syncs. Radars, radar calibration, layout and Overlay Studio
remain machine-local. The sync pack uses empty machine-local sections and the agent commits
only the restored match config. An operator's explicit full event-pack import still imports
all sections locally, as before.

### Conflicts, revocation and offline grace
Each tournament config has a `configVersion` counter (existing records start at 1).
If the live local hash differs from the last synced local hash when a newer central revision
arrives, the agent keeps the producer's roster and shows **UPDATE AVAILABLE — a newer version
exists on the platform** in the Launcher Link card. **Apply platform config** is an explicit,
confirmed click and authenticates/fetches again; it cannot apply a cached update after a
known revocation. The commit rechecks the live hash under the same lock as panel saves,
imports and activations, protecting edits made during slow artwork restoration too.

The card reports **synced**, **update-available**, **revoked**, **offline-grace**, or **offline**,
plus queued event count. A revoked device or de-approved account receives only
`{status:"revoked"}` and stops receiving/applying new configs or uploading events. A known
revocation cannot turn into grace merely because the next request fails.

Last-good sync state is persisted in `config/platform/sync.json` (0600). Unreachable platforms
carry a **7-day grace**, matching `LicenceMonitor`; after that the card reports offline.
**Neither revocation nor grace expiry deletes local config or gates the running broadcast.**
An old platform returning 404/405 or an account service without internal identity support
reports sync unavailable and backs off for five minutes rather than entering an error loop.
Unknown fields are ignored and missing version fields are defaulted.

### Metrics outbox and config save-back
GSI-derived kills, headshots, disappearing grenades and round ends still record locally.
On a synced launcher each also appends to `config/platform/outbox.json` (0600) with a
persistent `deviceId:sequence` ID. The agent flushes FIFO batches to
`POST /api/platform/device/metrics` with the same device credentials and:

```json
{"events":[{"id":"device-id:1","tournamentId":"cup-id","kind":"kill","count":1,"map":"de_mirage","detail":"killer > victim","at":1800000000000}]}
```

The response acknowledges individual IDs. The queue retains events until acknowledged,
including when a response is lost after the server committed. The central store persists
its deduplication ledger atomically with totals: **at-least-once delivery, exactly-once
counting**, including after restart and bounded-log eviction. Device sequence ranges are
compressed rather than forgotten with old logs. Batches contain at most 100 events and
one config pack; each wakeup flushes at most ten batches. The outbox is capped at **10,000
events / 100 MB serialized**, dropping oldest events with a console warning when full.
Do not delete its sequence ledger during an outage or an upgrade. Events from a previous
link are never sent under a different device's credential.

`PUT /api/config` and full event-pack import also save the match config back into the active
owned tournament, incrementing its version and refreshing its hash. This fixes reactivation
reverting panel edits on standalone hosts. On synced launchers they additionally enqueue
an idempotent `config-push` with a match-only pack and the base config version/hash. Queued
local saves chain through their preceding push's receipt; the central store compares
versions before committing and refuses stale writes instead of silently using
last-writer-wins. Accepting the platform revision discards stale queued config pushes for
that workspace, not metric events.

## Metrics & match logs
Local and device-ingested events aggregate into `/admin` and (when enabled) the `/welcome`
"Live on SCOUT so far" strip, which refreshes every 15 seconds. Each tournament retains 300 log entries, the global log 1,000,
plus running totals. Headshots increment headshots separately from kills.

Other account-authenticated tooling can still post to
`POST /api/platform/tournaments/:id/metrics`
(`{events:[{kind:'kill'|'headshot'|'grenade'|'round'|'map'|'match',count,map,detail}]}`).
`GET /api/platform/stats` serves public aggregate totals only when the owner enables them.

## Run the hosted shape
Configure the account service with a service key and `SCOUT_OWNER_EMAIL` (see its guide),
then the **central host**:

```sh
SCOUT_BETA_API_URL=https://accounts.example.com SCOUT_BETA_API_KEY=… \
SCOUT_OWNER_EMAIL=you@example.com npm start
# /apply -> owner approval -> sign in -> /dashboard -> create and activate a tournament
```

On **each venue host**, using the same account service but the platform URL separately:

```sh
SCOUT_BETA_API_URL=https://accounts.example.com \
SCOUT_PLATFORM_URL=https://scout.example.com npm start
# Launcher Link -> approve its device code in your central dashboard
# GSI and OBS/overlay URLs still point at this venue's own host
```

Upgrade the account service and central host first; add the platform URL to launchers only
when ready. Back up the existing platform store, installation identity and outbox together.
`tests/platform-sync.test.ts` covers no-ops, asset portability, conflicts, mid-sync revocation,
replay after outage/lost acknowledgement/restart, version skew and the real two-host GSI
pipeline; `tests/platform.test.ts` pins versioning, migration and persistent deduplication.
