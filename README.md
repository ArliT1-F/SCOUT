# SCOUT — CS2 broadcast overlay

Initial phases 1–3 implementation: external Node GSI host, React/TypeScript operator dashboard, shared transparent scoreboard HUD and OBS Browser Source page. No memory reading, injection, game hooks, or chroma key.

## Run

Node 20+ required.

```sh
npm install
npm run dev                 # http://127.0.0.1:8080/admin
npm test
npm run build
npm start                   # serves production build
```

Routes: `/` and `/admin` operator panel; `/obs` transparent 1920×1080 design canvas; `/game` shared letterboxed renderer. Both outputs scale uniformly into the available viewport. The admin's illustrative backdrop and sample players are **preview only**. Output routes never use sample match data. No active GSI for 5 seconds shows SIGNAL LOST and clears displayed game data.

### CS2 connection

1. Copy `config/gamestate_integration_overlay.cfg` to `Counter-Strike Global Offensive/game/csgo/cfg/`.
2. Replace `CHANGE_ME` with your own local token, and start the host with matching `GSI_TOKEN`. Default token exists only for initial local setup.
3. Restart CS2. Use Fullscreen Windowed (borderless) and observer/GOTV mode for all-player blocks.
4. Configure native HUD visibility for your observer environment. Console permissions vary; validate your cvars before going on air.
5. Confirm the dashboard says Receiving live data, check the **CS2 feed** panel for accepted packets and an `allplayers` chip, then switch the preview from Demo feed to GSI feed. If it stays on "Waiting for CS2", work through [Why is nothing showing?](#why-is-nothing-showing-cs2-feed-panel).

### Why is nothing showing? (CS2 feed panel)

The dashboard shows a **CS2 feed** panel on the Overview and Setup guide tabs. It is the one place that separates the four ways a GSI feed goes quiet, because the previous code could not tell them apart:

| What the panel shows | What it means | What to do |
| --- | --- | --- |
| `ACCEPTED 0`, `TOKEN-REJECTED 0` | Nothing has reached the host. CS2 never sent a packet, or sent it elsewhere. | Check the cfg is in `Counter-Strike Global Offensive/game/csgo/cfg/` and is **not** saved as `…cfg.txt` (Notepad does this). CS2 loads GSI configs at launch, so fully restart CS2. Confirm the cfg `uri` port matches the panel's `PORT`, and that CS2 runs on the same machine as the host. |
| `TOKEN-REJECTED` climbing | Packets arrive and every one is refused with `401`. The cfg `auth token` and the host's `GSI_TOKEN` differ. | Make them match and restart the host. The panel shows whether the host is using the built-in default or the `GSI_TOKEN` environment token — it never shows the token itself. |
| `SHAPE-REJECTED` climbing | A packet arrived without a `provider` block, so it was not a GSI payload. | Usually the same `.cfg.txt` or "CS2 not restarted" mistake; the panel names the last reason. |
| `ACCEPTED` climbing, `allplayers` chip missing | CS2 is **playing, not spectating**. It only sends `allplayers` in observer/GOTV mode, so the scoreboard and clock work while rosters and the killfeed stay empty. | Join the match as observer or GOTV. |
| `ACCEPTED` climbing, blocks listed, `LAST PACKET` seconds ago | The feed is healthy but the dashboard preview is on Demo feed. | Switch the preview to **GSI feed**. |

The host prints the same story in its console: the expected URI and token source at startup, the block list of the first accepted packet, the first `allplayers` block, a warning after 100 accepted packets with no `allplayers`, and rejection reasons rate-limited to one log per 10 seconds (CS2 posts at ~20 Hz, so unthrottled logging floods a terminal). `GET /api/status` exposes the same counters as `gsi`.

`POST /gsi` is authenticated, size-limited, merges nested components, drops metadata/auth and dangerous prototype keys, rejects older provider timestamps, and resets on map/provider change or heartbeat gap. Dynamic inventories (`allplayers`, `weapons`, `grenades`) replace on presence to remove departed players/dropped items; omission preserves the prior block. This policy assumes normal GSI authoritative inventory blocks, not custom per-player delta relays. Verify this policy with real observer captures before tournament use.

Packets are validated per subtree before merging (`server/schema.ts`, zod): every GSI block is optional, numbers that CS2 sends as strings (`"phase_ends_in":"71.4"`, `"health":"100"`) are coerced, empty enums like `round.win_team:""` delete the key instead of failing, and unknown fields/blocks pass through untouched so a CS2 update cannot break a live broadcast. A malformed field is dropped and counted — `gsi.subtreeIssues` on `/api/status`, logged at most once per 10 s — while the rest of the packet still merges. Validation never throws and never rejects a packet; `__proto__`, `constructor`, `prototype`, `auth`, `previously`, `added` and `removed` are stripped at every depth.

### Recording and replaying a real feed

`LOG_GSI=1 npm run dev` writes every accepted payload to ignored `recordings/gsi-<timestamp>.jsonl` — one line per packet as `{"receivedAt":<ms>,"payload":{…}}`, with the token stripped. Logging is opt-in and a session file is not rotated: monitor disk usage or rotate externally. Slow WebSocket consumers are dropped and reconnect automatically.

To capture on the observer machine: start the host with `LOG_GSI=1`, play a match so CS2 pushes (warmup plus one full round is plenty), and keep the file — `recordings/` is gitignored.

```sh
npm run replay -- recordings/gsi-<timestamp>.jsonl              # real time, recorded spacing
npm run replay -- recordings/<file>.jsonl --speed 10            # ten times faster
npm run replay -- recordings/<file>.jsonl --max-gap 2000        # skip long pauses between maps
npm run replay -- recordings/<file>.jsonl --dry                 # print the plan, post nothing
```

Replay posts each recorded payload back to `POST /gsi` with the host token (`--token`, else `GSI_TOKEN`, else `CHANGE_ME`). It stops with an explicit message on a token mismatch, on an unreachable host, or after three consecutive non-200 responses, and finishes by printing the host's revision delta — `0 merged` means the host already holds newer provider timestamps, so restart it before replaying an older recording. **Never replay against a host that is on air**: it injects packets exactly as CS2 does.

A sanitized fixture with the same structure ships in `tests/fixtures/observer-mirage-nuke.jsonl` (invented names and SteamIDs; 30 packets covering warmup, a pistol round, a plant and defuse, halftime side swap and a map change). It drives `tests/fixtures.test.ts`, and `python3 tests/fixtures/generate.py` rebuilds it.

### OBS

In LIVE scene add Game Capture for `cs2.exe`, then Browser Source:

- URL: `http://127.0.0.1:8080/obs` (OBS and host on same PC)
- Width 1920; height 1080
- Disable “Shutdown source when not visible”
- Leave **Custom CSS** empty; no chroma key; **do not use Window Capture for the overlay**

`/obs` and `/game` keep `<html>` and `<body>` fully transparent — the dark app background belongs to the operator panel only. This matters because a background on the root element is propagated to the whole document canvas, so OBS would composite an opaque frame over the game capture instead of only the HUD panels. The output classes are applied at module scope, before the first paint, so there is no opaque flash while the source loads.

Use `http://127.0.0.1:8080/obs?checker=1` in a normal browser to verify transparency: it draws a checkerboard behind the canvas, and only the HUD panels should be filled. Never use the `?checker=1` URL as the OBS source.

If the overlay still covers the game: confirm the source URL is `/obs` (not `/` or `/admin`), that Custom CSS is empty, and that the active scene is **Live game** — matchup, lineups, series, winner and break are near-opaque full-screen graphics by design.

Use browser preview URLs only for remotely inspecting this workspace. Local OBS uses the localhost URL above. Frontend API and WS connections are same-origin.

### Team sides

Which config team is on which side is resolved by `server/sides.ts` and exposed as `sides` on `/api/status` and every WebSocket snapshot, so the HUD, the killfeed and the operator panel always agree. In order of preference:

1. **GSI names** — `map.team_ct.name` / `map.team_t.name` matched against a config team's `name` or `tag`. These flip at halftime and at each overtime swap, and the binding follows them.
2. **Roster SteamIDs** — when the names do not match, a config team whose players are all found on one side in `allplayers` claims that side.
3. **Remembered binding** — a >5 s heartbeat gap or a partial packet cannot flip the teams: the previous binding is kept while the map name is unchanged, and re-derived when the map changes.
4. **The name CS2 reported** — an unknown team name is shown as-is (with a fallback colour) rather than silently replaced by the first config team. `confidence: "guess"` in the snapshot marks this case.
5. **Config order** — only when there is no evidence at all (before the first packet, or an empty payload); `configSides` is what the dashboard shows before GSI arrives.

`config/teams.json`'s `players` array may stay empty: sides are then resolved from the GSI names, which is what the shipped configuration does.

### Series state

`server/series.ts` derives `series` (carried in every snapshot next to `sides`) from GSI plus operator config:

- **Format** — `format` (`bo1`/`bo3`/`bo5`, also accepted as `bestOf`) with a `bo3` default; unknown values fall back instead of leaking into the pips.
- **Score pips** — from `map.team_ct.matches_won_this_series` / `map.team_t...`, clamped to `ceil(bestOf / 2)` pips per side, so the HUD shows real map wins rather than the three decorative dots it used to.
- **Rounds** — `map.round` is already 1-based, so the HUD shows `ROUND n / 24` for MR12 (configurable with `mr`) instead of the old off-by-one `/ 24`.
- **Overtime** — beyond regulation or tied at the MR, `phase: "overtime"` with `otPeriod` and `roundsThisHalf` from the round number (`otMr`, default 3 rounds per OT half), rendered as `OVERTIME 1 · 2/3`.
- **Winner** — `mapWinner` from the final scores on a `gameover` map, and `seriesWinner` once a side reaches `mapsToWin`; the operator's **Winner title** scene renders "`<team>` WINS THE SERIES" from it.

### Clocks

GSI reports the countdown as it was when the packet was sent, so the HUD extrapolates between packets with `src/clock.ts` and resyncs to every packet — the packet value always wins, and the local clock only fills the gap:

- **Bomb timer** while `bomb.state` is `planted` or `defusing` (shown with tenths and a `DEFUSING` marker taken from the game's own state, never inferred), otherwise the **round timer** from `phase_countdowns.phase_ends_in`.
- A paused round, gameover or intermission **freezes** the clock, and once the feed is older than 5 s (the same limit the live indicator uses) the clock freezes at the last reported value and the HUD falls back to `SIGNAL LOST` — it never invents a countdown for a dead feed.
- Whole seconds round up, so the clock never reads `0:00` while time is left; a payload with no usable countdown reports no clock rather than `0:00`.
- The interpolation assumes the operator and host clocks are within a second (the same assumption the live indicator already makes on a trusted LAN).

### Radar

`config/radars.json` holds the per-map calibration and the radar toggle turns on for any map listed there:

```json
{"overviewSize": 1024, "maps": {"de_mirage": {"posX": -3230, "posY": 1713, "scale": 5}}}
```

- `posX` / `posY` / `scale` are the values from the game's own `resource/overviews/<map>.txt` (the top-left corner of the overview in world units, and world units per overview pixel). The shipped file lists the current active-duty pool, dust2, overpass, train and vertigo; add a map by copying its overview values. A map without an entry has **no** radar and the toggle stays disabled with a hint — positions are never drawn against a guess.
- `src/radar.ts` projects the live `allplayers[].position` through that calibration (`u = (x - posX) / scale / size`, `v = (posY - y) / scale / size`) and returns dots with side, alive state, heading and colour. Points outside the overview are dropped rather than clamped to a wrong place (nuke's lower level, players in the air), `forward` is accepted both as a yaw and as a vector, and a player without a usable position simply has no dot.
- The radar renders live dots, the observed player with a heading arrow and the bomb marker once it is planted. The **map image is optional and is not bundled**: drop `public/radars/<map>.png` (any square 1:1 overview, e.g. the ones extracted from the game depot) and it is used; without it the panel draws a grid so positions and calibration can still be checked.
- Unverified without a real observer machine: the calibration values themselves. Verify by watching a player walk a known route with `cl_radar` in game — the dot must follow the same path on the same callouts.

### Phase-based visibility

`src/phases.ts` maps the GSI phase onto what the live scene is allowed to show; it is pure, so `tests/phases.test.ts` covers it without a browser. The scene is *not* hidden while waiting for data beyond what the phase justifies, and output routes still render nothing at all without live state.

| Phase (`map.phase` / `round.phase`) | Scene |
| --- | --- |
| warmup | **WARMUP** card, clock stays, no rosters, no killfeed |
| freezetime | rosters + matchup lower third, **FREEZE TIME** banner |
| live | rosters, lower third, killfeed, clock and bomb timer |
| round over | **ROUND OVER** banner plus `TEAM · BOMB/DEFUSE · score` from the derived round history, lower third hidden |
| intermission | **INTERMISSION** card and series score |
| gameover | `<team> WINS THE MAP` card |
| paused / operator technical pause | **TACTICAL PAUSE** banner, which outranks the round banner |

The operator's **Technical pause** switch and a `round.phase: "paused"` packet both raise the same banner, and the warmup/intermission/final card outranks both — a card is never hidden behind a pause banner.

### Derived events (killfeed and round history)

The host derives kills and round results by differencing successive snapshots (`server/events.ts`) and broadcasts them in the same snapshot as the match state — `events.kills` (ring of the last 8) and `events.rounds` (up to 40, tagged with their map, so a finished map keeps its history).

- **Kills**: a player's health dropping to 0 is the only death trigger, so a repeated packet never double-counts. The killer is credited from a `round_kills` (or `match_stats.kills`) increment in the same packet, with the killer's active weapon and the headshot flag from `round_killhs`. When the increment is not in the packet the killer stays `unknown` — the overlay never invents one.
- **Rounds**: `round.phase: over` (or a gameover/intermission map phase) closes the round once, with the winner from `round.win_team` (falling back to `map.round_wins`) and a reason taken from the bomb transition (`bomb`, `defuse`), a wiped roster (`elimination`) or the clock (`time`).
- The >5 s heartbeat gap, a map change or a provider change clears the kill feed and the per-player watch state; finished rounds are kept because they are history rather than live state.

The killfeed renders on `/obs` and `/game` when the **Killfeed** switch is on: team colours from `config/teams.json`, the weapon's name, headshot marker, newest first, and each entry fades out after ~7 s and disappears at 9 s. The operator preview shows sample kills while it is on Demo feed.

### Operator controls

Scene selection (live, matchup, lineups, series, winner title, break), killfeed, lower-third, economy, technical pause and team display swap are saved to ignored `config/operator.json` and broadcast to all connected views. Radar images are optional: see [Radar](#radar). Teams/maps are read from `config/teams.json` at startup; [team sides](#team-sides) are resolved from GSI names even when the rosters are empty. Player aliases and rich roster editing are not yet implemented. Demo preview is local to the operator and never modifies server state.

## Scope / remaining work

This is **not yet tournament-production verified**. Synthetic state tests and build checks run in this environment. A real CS2 observer, Windows and OBS are unavailable here, so actual 20 Hz GSI compatibility and transparent OBS compositing must be verified on the observer machine.

Remaining specification stages: roster editor/overrides; photos and complete weapon/utility icons; rich broadcast scenes; optional OBS websocket; and the Windows Tauri v2 shell with HWND polling, foreground visibility, click-through and F8. `/game` is currently a browser renderer, **not** a native always-on-top window.

Security: binds `0.0.0.0` for remote operator/preview use. Run only on a trusted LAN and restrict firewall ingress. Operator controls are unauthenticated, with a same-origin mutation check; don't expose the service to the public internet. Remote Google Fonts are optional visual enhancement; system font fallbacks work offline.
