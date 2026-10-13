# Hosted multi-tenancy, the SCOUT owner admin, and platform metrics

## Model
- **Whitelisting** is unchanged: an account is usable when the SCOUT owner approves its
  application (`server/beta.ts` locally, `server/account-service.ts` hosted).
- **Every approved account hosts independently.** From `/dashboard` → *My tournaments* a
  whitelisted user creates their own tournaments: name + a full `ScoutConfig` (teams, rosters,
  maps, bracket). Tournaments are stored per account in `config/platform/store.json`
  (gitignored, mode 0600) and no account can read, edit, activate or delete another's —
  every `/api/platform/tournaments*` route resolves the account from its own session cookie
  and checks ownership server-side.
- **Activating** a tournament loads that user's config into the live workspace atomically
  (`config/teams.json` + broadcast), so their overlay shows their tournament. One tournament
  is live on a host at a time; the saved workspaces are independent and can be switched.
- **Limit:** `maxTournamentsPerUser` — **3 during the beta, set it to 1 for release** — is a
  platform setting the owner changes in `/admin`; it is enforced on creation for everyone.

## /admin — only the SCOUT owner
Set `SCOUT_OWNER_EMAIL` to your own account email. `/admin` (and
`GET /api/platform/admin`, `PUT /api/platform/admin/settings`) then require a signed-in
account session with exactly that email; panel owner tokens do not substitute. When
`SCOUT_OWNER_EMAIL` is set, whitelist decisions (`/api/beta/applications*`) also require the
owner account, and the panel's owner-only tabs (Operators & audit, Beta applications,
Operations) are hidden from everyone else. Unset, everything stays closed at `/admin` and
the panel keeps its legacy local-owner behaviour.

`/admin` shows: whitelist approve/reject, every whitelisted user with their tournament
count and metric totals, every tournament, the recent match log, platform totals, and the
settings desk.

## Settings, pushed in real time
Settings (`maxTournamentsPerUser`, `applicationsOpen`, `reviewNote`, `publicStatsEnabled`)
carry a version. Saving in `/admin` bumps it, persists it, and calls the host broadcast:
the settings ride every WebSocket snapshot (`platform.settings`), so open operator panels
see a change within a heartbeat (~1 s) and the dashboard/admin poll on the same cadence.

## Metrics & match logs — everything, for future public stats
While a tournament is active, the GSI pipeline records derived events against it
(`server/index.ts`): kills (with killer > victim detail), headshots, grenades that disappear
from the GSI `grenades` block (exploded/thrown utility), and round ends. They are kept as a
bounded match log (300/tournament, 1000 global) plus running totals, and can also be posted
by other tooling to `POST /api/platform/tournaments/:id/metrics`
(`{events:[{kind:'kill'|'headshot'|'grenade'|'round'|'map'|'match',count,map,detail}]}`).
`GET /api/platform/stats` serves the global totals (kills, headshots, grenades, rounds,
maps, matches) once the owner enables **Public stats**; `/welcome` then renders the
"Live on SCOUT so far" strip. That is the data source for real-time public numbers later.

## Run the hosted shape
```sh
SCOUT_BETA_API_URL=https://accounts.example.com SCOUT_BETA_API_KEY=… \
SCOUT_OWNER_EMAIL=you@example.com npm start
# users: /apply -> you approve in /admin -> they sign in -> /dashboard -> My tournaments
```
