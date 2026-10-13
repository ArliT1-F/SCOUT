# API route audit: authentication and authorization

Scope: every HTTP route registered in `server/index.ts`, checked against the panel gate in `server/auth.ts`.
Date: 2026-10-13. Method: each route read against the gate, then the gate and the one real bypass exercised
against a running host (`PORT=… npx tsx server/index.ts`) with a forged `Host` header and no token.

## How the gate works

1. **Mutations are gated by path and method, not by a route list.** Any `POST`, `PUT`, `PATCH` or `DELETE` under
   `/api/` needs a panel principal (token header, session cookie, or a trusted local request), *and* a same-origin
   `Origin` when the browser sends one. The exemptions are `POST`/`DELETE /api/session` (unlock and logout) and the
   closed-beta paths listed in `PUBLIC_BETA_PATHS`, which carry an account credential or are the applicant's own
   door, each with its own same-origin check and throttle.
2. **Each mutation then checks a capability** (`permit`) and, where it changes the live show, a lease (`requireControl`).
3. **Reads are open by default**, except where a route calls `privateRead` (capability), `ownerOnly`, or the new
   `signedInRead`.

Roles (`server/auth.ts`): owner = every capability; producer = `control`, `match-edit`; designer = `design`;
viewer = none (read-only). A request from the host machine with a trusted `Host` is the local owner.

## Finding 1: case-varied paths bypassed the gate (fixed)

Express matches routes case-insensitively by default, but the gate tested `req.path.startsWith('/api/')` in a
case-sensitive way. Reproduced on the unfixed host:

```text
PUT /API/controls   Host: evil.example   (no token)  → 400 "Invalid controls"  (handler reached)
PUT /API/controls   same, with a valid body          → 200, scene changed, audit entry written
PUT /api/controls   same                              → 403 untrusted-host
```

The unauthenticated caller changed the live scene, and `GET /api/status` (public) showed the change.

Fix: `app.set('case sensitive routing', true)` so `/API/…` is simply not a route, and the gate compares a
lower-cased path as a second guard. Regression tests in `tests/panel-live.test.ts`
(*route matching is exact…*) fail on the old code and pass on the new.

## Finding 2: operator data was readable without a session (fixed)

`GET /api/recordings`, `GET /api/recordings/:name` (the raw GSI stream), `GET /api/archive`,
`GET /api/archive/:id` (match event log) and `GET /api/obs` (OBS host and scene mapping) returned data to any
caller. They now require a same-origin, signed-in panel session (`signedInRead`, any role, viewers included,
since reading is their job). The panel's own pages already send the cookie, so nothing there changes.
Regression test: *operator data reads need a signed-in panel session*.

## Route inventory

### Mutations (gated)

| Route | Gate | Notes |
| --- | --- | --- |
| `PUT /api/controls` | `control` + lease | Scene and overlay toggles |
| `POST /api/remote/action` | `control` + lease | Remote-console actions |
| `POST /api/lease`, `DELETE /api/lease` | `control`; takeover/force-release owner only | |
| `POST /api/recordings` | `control` + lease | Start/stop GSI recording |
| `POST /api/archive/start`, `POST /api/archive/finish` | `control` + lease | |
| `POST /api/obs/switch`, `POST /api/obs/refresh-overlay` | `control` + lease | |
| `PUT /api/config` | `match-edit` | Teams, players, maps, format |
| `PUT /api/radars`, `PUT /api/layout`, `PUT /api/overlay` | `design` | |
| `POST /api/upload` | `design`, same-origin | Image type, size and content validated |
| `POST /api/pack/import` | `design`, same-origin | Schema-validated event pack |
| `PUT /api/obs`, `POST /api/obs/reconnect` | owner | OBS settings never echo the password |
| `POST /api/operators`, `DELETE /api/operators/:id` | `manage-operators` | Issue and revoke tokens |
| `POST /api/beta/link/start`, `POST /api/beta/link/unlink` | owner | |
| `POST /api/beta/applications/:id` | owner | Approve/reject applicants |
| `POST /api/ops/releases`, `DELETE /api/ops/releases/:version` | owner | |
| `POST /api/beta/*` (hosted proxy, non-public paths) | gate, then upstream | |

### Mutations exempt from the panel gate (by design)

| Route | Why | Own protection |
| --- | --- | --- |
| `POST /api/session` | Unlock with the token | same-origin, per-address lockout (5 wrong in 10 min) |
| `DELETE /api/session` | Logout | same-origin |
| `POST /gsi` | CS2's feed | GSI token in the body, checked before anything else |
| `POST /api/beta/apply`, `login`, `logout`, `activate` | Applicant and account sign-in | same-origin; per-address throttles in `server/beta.ts` |
| `POST /api/beta/device/start`, `poll` | Launcher link flow | same-origin; pending-code limits |
| `POST /api/beta/device/approve`, `deny`, `devices/revoke` | Account owner approves a launcher | account session cookie (checked in `local.deviceDecide` / `revokeDevice`) |

### Reads

| Route | Access | Classification |
| --- | --- | --- |
| `GET /api/session` | Anyone; describes the caller, never a secret | Intentional |
| `GET /api/status`, `GET /api/config`, `GET /api/overlay`, `GET /api/lease` | Public | Intentional: the overlay and the WebSocket snapshot already carry this data |
| `GET /healthz` | Public | No match data, no secrets |
| `GET /api/beta/license` | Same-origin, no session | The launcher asks before drawing; sees only the installation's own state |
| `GET /api/beta/status` | Account cookie | Account's own status |
| `GET /api/beta/link` | Any panel session | Link state |
| `GET /api/beta/applications` | `view-audit` | |
| `GET /api/ops/health`, `GET /api/ops/requests` | `view-audit` | |
| `GET /api/operators` | `manage-operators` | Includes active sessions |
| `GET /api/audit` | `view-audit` | |
| `GET /api/remote/state` | `control` | |
| `GET /api/pack/export` | `design` | |
| `GET /api/recordings`, `GET /api/recordings/:name` | Signed-in session (**fixed**) | Filenames validated by a strict regex |
| `GET /api/archive`, `GET /api/archive/:id` | Signed-in session (**fixed**) | |
| `GET /api/obs` | Signed-in session (**fixed**) | |
| `WS /ws` | Public read; cross-site handshakes refused | Snapshot only |
| `/obs`, `/game`, `/uploads`, `/radars`, `/thumbs`, `/download` | Public static | Output pages and published artwork and installer |

## Residual risks (not code defects, but operator-facing)

- **GSI token default.** With `GSI_TOKEN` unset, the built-in `CHANGE_ME` token is accepted and the host logs it on
  start. Anyone on the venue network who knows that default can push fake game states into the scoreboard. The
  installer sets a token; a development checkout does not. Set `GSI_TOKEN` before any real event.
- **Plain HTTP.** No TLS is added (documented in the README). The token is only as private as the network.
- **Public snapshot.** `GET /api/status` and the WebSocket carry the match state, which is what the overlay shows by
  design. Anything that should not be on the public screen must not be entered in the match config.

## Re-running the audit

`tests/panel-live.test.ts` drives the real host over HTTP from a second address and forged `Host` and `Origin`
headers, and covers the findings above. When a route is added, put it under `/api/` in a lower-case path and let
the gate apply; if it must be public, add it to `PUBLIC_BETA_PATHS` or document it here.
