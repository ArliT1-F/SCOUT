# Bitfocus Companion / Stream Deck integration

SCOUT exposes a small, authenticated HTTP control surface that works with Bitfocus Companion's generic HTTP request actions (and other button controllers). Companion talks to the SCOUT host directly; no browser, plugin, websocket bridge, or cloud service is required.

## 1. Create a dedicated producer token

1. Sign in to SCOUT as the owner and open **Operators & audit**.
2. Issue a token with the **Producer** role and a clear label such as `Companion · Main desk`.
3. Copy the token when it is shown. It is displayed once; SCOUT stores only a salted SHA-256 digest.
4. Keep the token in Companion's private credential/variable storage. Do not place it in a button label, URL, shared preset, screenshot, or exported configuration.

Producer access can change scenes and on-air controls but cannot edit themes, artwork, operator credentials, or OBS passwords. For network transport, keep Companion and SCOUT on the trusted venue LAN or use a VPN/TLS reverse proxy. Do not forward the host's HTTP port to the public internet. Remote access can be disabled with `SCOUT_REMOTE=off`.

## 2. Set up an HTTP request

Base URL: `http://<SCOUT-host>:8080` (replace the host and port with the address SCOUT prints at startup).

For every request, set:

```text
X-Scout-Token: <dedicated producer token>
Content-Type: application/json
```

`Authorization: Bearer <token>` is also accepted. Never put a token in a query string. SCOUT checks the role and the control lease on every action.

### Live feedback / variables

Poll this endpoint every 1–2 seconds from a Companion feedback or variable action:

```http
GET /api/remote/state
```

It returns only operator-safe status (never credentials):

```json
{
  "controls": { "scene": "live", "radar": true, "killfeed": true },
  "lease": { "holder": "Companion · Main desk", "expiresAt": 1791300000000 },
  "canControl": true,
  "recording": { "enabled": false, "file": null, "bytes": 0 },
  "archive": null,
  "scenes": ["live", "matchup", "lineups", "veto", "bracket", "winner", "break", "recap", "stats"],
  "serverTime": 1791300000000
}
```

Use `controls.scene` as the active-scene label, `lease.holder` / `lease.expiresAt` as the handoff feedback, `canControl` to disable or warn on buttons, and `recording.enabled` / `archive` for recorder status. An expired lease is released automatically after 45 seconds without an operator action. An action renews the lease.

### Send a button action

```http
POST /api/remote/action
```

Scene selection:

```json
{ "action": "scene:recap" }
```

Supported scene IDs: `live`, `matchup`, `lineups`, `veto`, `bracket`, `winner`, `break`, `recap`, `stats`.

Toggle a graphic or match control:

```json
{ "action": "toggle:killfeed" }
```

Supported toggles: `radar`, `killfeed`, `lowerThird`, `economy`, `techPause`, `swapped`.

Start a timed break or clear it:

```json
{ "action": "break.start", "minutes": 5 }
{ "action": "break.stop" }
```

Each action returns the updated `controls` and `lease`; the next state poll also reflects the change. A `423` response means another producer holds the lease. The button controller should show the returned error and wait for a release/expiry, or the owner can take over in SCOUT. `403` means the token role is insufficient; `401` means the token is invalid or revoked.

## 3. Suggested Stream Deck page

- Scene buttons: Live, Matchup, Lineups, Map series, Bracket, Winner, Break, Round recap, Player stats.
- Toggle buttons: Radar, Killfeed, Player lower-third, Economy, Technical pause, Swap sides.
- Feedback: active scene, lease owner, GSI recording, active archive, and an error/lease-conflict indicator.
- Add a dedicated **Release control** button in the SCOUT Touch Remote or operator panel before another producer takes over. Owners can use the explicit takeover control when an operator is unavailable.

SCOUT writes operator actions, scene changes, token issue/revocation, lease claims/takeovers, recording and archive actions to the owner-visible audit trail. Credentials and OBS passwords are never included in feedback or audit records.
