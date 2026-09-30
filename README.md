# SCOUT — CS2 broadcast overlay

External Node GSI host, React/TypeScript operator dashboard, a transparent scoreboard HUD for an OBS Browser Source, config-driven full-canvas broadcast scenes, an optional OBS WebSocket bridge and an optional Windows overlay shell. No memory reading, injection, game hooks, or chroma key.

## Run

Node 20+ required.

```sh
npm install
npm run dev                 # http://127.0.0.1:8080/admin
npm test
npm run build
npm start                   # serves production build
npm run shell:test          # Rust: the overlay shell's decision logic (needs only a Rust toolchain)
```

Routes: `/` and `/admin` operator panel; `/obs` transparent 1920×1080 design canvas; `/game` shared letterboxed renderer (also what the [Windows overlay shell](#windows-overlay-shell-tauri-v2-optional) displays). Both outputs scale uniformly into the available viewport. The admin's illustrative backdrop and sample players are **preview only**. Output routes never use sample match data. No active GSI for 5 seconds shows SIGNAL LOST and clears displayed game data.

### Operator access from another machine

The host listens on every interface, so the panel already opens on a second laptop. What it will not do is let randoms on the venue network change the broadcast: every **mutation** (`/api/controls`, `/api/config`, `/api/layout`, `/api/radars`, `/api/upload`, `/api/obs*`) needs either a request from the host's own machine or the panel token. Every **read** stays open — an OBS browser source or a wall display on another PC has to load `/obs`, its assets, its WebSocket feed and `/api/status` with no credentials at all, and the output routes contain nothing the stream does not show anyway.

The host prints where the panel is reachable when it starts, and the token is in that link:

```text
[panel] Remote control is ON — open one of these from the other machine. The link carries the token, once:
[panel]   http://192.168.1.50:8080/?token=…
```

Opening that link (or typing the token into the panel's unlock screen) trades it for an HttpOnly session cookie and a redirect that drops the token from the address bar and the history. The header then reads **REMOTE · <address>** with a **Sign out** button, and the panel behaves exactly as it does on the host machine. A browser that refuses the cookie can keep the token in `sessionStorage` and send it as `X-Scout-Token: <token>` (or `Authorization: Bearer <token>`) instead — same for `curl` and scripts. `GET /api/session` reports what the current request is (`authenticated`, `local`, `via`, `address`, `startedAt`, `expiresAt`) and never carries the token.

| Variable | What it does |
| --- | --- |
| `SCOUT_PANEL_TOKEN` | The panel token. Without it one is generated per run and printed on the console — the only place the token is ever shown. It is never written to `config/`, never returned by an API and never logged, and it is compared in constant time. |
| `SCOUT_REMOTE=off` | Remote control is refused everywhere; only the host machine can operate the panel. The overlay keeps working for every viewer. |
| `SCOUT_REQUIRE_TOKEN=1` | Even the host machine has to unlock the panel. |
| `SCOUT_ALLOWED_HOSTS` | Comma-separated names to accept as the operator's own — for a reverse proxy or tunnel that keeps its public name in the URL while rewriting `Host` (see below). |

- A session lasts 12 hours of *use* (each request refreshes it), lives in memory only — restarting the host signs everyone out — and the least recently used one is dropped once 32 are open.
- Five wrong tokens from one address lock that address out for ten minutes, and the panel reports how many attempts are left. The token is 24 random bytes, so guessing was already hopeless; this only stops a LAN brute force from getting a try rate.
- A request that *looks* local but names a public host is refused. Two things look like that: a proxy or tunnel next to the host (it connects from `127.0.0.1` while carrying the visitor's public name), and a page on `evil.com` whose DNS record points at the host's LAN address. Both are refused with `untrusted-host` unless the name is in `SCOUT_ALLOWED_HOSTS`. Mutations additionally require the `Origin` to match the host they were sent to, and a WebSocket handshake whose `Origin` names another site is rejected.
- No TLS is added. On a plain-HTTP LAN the token is as private as the network it crosses — the same network that already carries the GSI feed. Keep the panel on a trusted LAN or put `nginx`/`caddy`/a tunnel in front of it with the name listed in `SCOUT_ALLOWED_HOSTS`; do not forward port 8080 to the internet.
- **Verified here**: the live host is driven over HTTP from a second address in `tests/panel-live.test.ts` (refusals, the token link, the cookie and header sessions, sign-out, the lockout, the rebound-host case and the WebSocket handshakes), and the policy itself in `tests/auth.test.ts`. Not verified: a real second laptop on a real venue network, and a real reverse proxy.

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

- URL: `http://127.0.0.1:8080/obs` (OBS and host on same PC),
  or `http://<host-ip>:8080/obs` when OBS runs on a second machine — the overlay needs no token, so a browser source can always load it. The Setup guide's **Copy OBS source URL** copies the address you opened the panel on, which is the right one for both cases.
- Width 1920; height 1080
- Disable “Shutdown source when not visible”
- Leave **Custom CSS** empty; no chroma key; **do not use Window Capture for the overlay**

`/obs` and `/game` keep `<html>` and `<body>` fully transparent — the dark app background belongs to the operator panel only. This matters because a background on the root element is propagated to the whole document canvas, so OBS would composite an opaque frame over the game capture instead of only the HUD panels. The output classes are applied at module scope, before the first paint, so there is no opaque flash while the source loads.

Use `http://127.0.0.1:8080/obs?checker=1` in a normal browser to verify transparency: it draws a checkerboard behind the canvas, and only the HUD panels should be filled. Never use the `?checker=1` URL as the OBS source.

If the overlay still covers the game: confirm the source URL is `/obs` (not `/` or `/admin`), that Custom CSS is empty, and that the active scene is **Live game** — matchup, lineups, series, tree, winner and break are full-canvas graphics with their own background, and cover the game capture by design.

Use browser preview URLs only for remotely inspecting this workspace. Local OBS uses the localhost URL above. Frontend API and WS connections are same-origin, and the operator panel from another machine is covered in [Operator access from another machine](#operator-access-from-another-machine).

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

### Weapon and utility icons

`src/weapons.ts` classifies every slot in `allplayers[].weapons` from its GSI `type` (rifle, sniper, SMG, pistol, shotgun, MG, knife, grenade, taser, C4) and reads the active one from `state: "active"` (or `"reloading"`), so the roster strip and the killfeed agree on what a player is holding. Utility is counted per player (HE, flashes, smoke, molotov/incendiary, decoy, Zeus, defuse kit) and summed per side for the economy banner.

`src/icons.tsx` uses the Counter-Strike 2 equipment SVGs in `public/icons/equipment/` for the killfeed, player roster, lower-third and utility indicators. The icons are served locally (no runtime download), use each weapon's original proportions, and are mapped from the GSI weapon name; unrecognized items fall back to a matching class icon when possible. Knife variants and the standard weapons/utilities are included.

**Asset attribution:** the SVGs are sourced from [Juknum/counter-strike-icons](https://github.com/Juknum/counter-strike-icons/tree/main/cs2/panorama/images/icons/equipment) (snapshot `d21042432beb189c855fc0857680416401795ac5`). The upstream repository identifies the Counter-Strike assets as Valve Corporation property and notes they are not licensed for commercial use without Valve's permission. See `public/icons/equipment/ATTRIBUTION.txt` and Valve's [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/).

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
- The radar renders live dots, the observed player with a heading arrow and the bomb marker once it is planted. The **map image is optional**: `image` in `config/radars.json` points at a file and defaults to `public/radars/<map>.png` — drop any square 1:1 overview there (the nine active-duty maps ship pre-filled from the [cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons) radar pack) or upload one from the panel. Without an image the panel draws a grid so positions and calibration can still be checked. Radar overviews are the radar's imagery only — the Matchup and Map series scenes show the thumbnails from `public/thumbs/` instead.
- **Custom radars in the panel** — *Overlay settings → Custom radars* edits the whole file: upload or replace the image per map (stored under `public/uploads/radars/`, pruned when replaced), tune `posX`/`posY`/`scale`/`size`, and add maps outside the default pool. **Save radars** sends `PUT /api/radars`, which validates (zod, `server/radars.ts`), writes `config/radars.json` atomically and broadcasts it to every output view. The preview picks up uploaded images and calibration edits before saving, so dots can be tuned against the image live. The same pack's scene pictures — `images/thumbs` — ship resized in `public/thumbs/` as the default pictures for the Matchup and Map series scenes (see [Broadcast scenes](#broadcast-scenes)), while `images/<map>.png` (map badges) stay ordinary images you can upload per map in **Match setup**.
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

### Teams, rosters, map series and tournament tree

The admin panel fully owns `config/teams.json`: **Teams & players**, **Match setup** and **Tournament tree** edit a draft, and **Save configuration** PUTs it to `/api/config`, which normalizes it (zod, `server/config.ts`), writes the file atomically and broadcasts it to every output view — no restart, no hand-editing. The same schema is applied on load, so a hand-edited file is normalized identically.

- **Teams** — name, tag, colour and an uploaded logo (PNG, JPEG, GIF, WEBP or SVG) per side. The logo renders on the scoreboard, the matchup graphics and the panel; without one the two-bar placeholder mark is used. [Team sides](#team-sides) still resolve from GSI, but the resolved side picks up whatever the panel currently says.
- **Rosters** — up to ten players per team with nickname, alias, real name, optional SteamID, role and a portrait (see [Player photos and aliases](#player-photos-and-aliases)). SteamIDs feed the roster-based side binding; without them sides resolve from the GSI names as before.
- **Map series** — event name, stage, best-of format, MR and OT length, plus the map list (name, pick, status, score) with an uploaded picture per map shown on the Map series scene and the series panel; a map without an upload uses the shipped thumbnail (`public/thumbs/`) on the scene. These are operator series cards; live round scores still come from GSI.
- **Tournament tree** — an editable single-elimination bracket (rounds → matches → seeds with team bindings, map scores, status). Setting a match winner writes the winner forward positionally (match *i* of round *r* feeds match ⌊i/2⌋ of round *r+1*) both in the panel and in the host's normalization, so the tree can never disagree with its own results. The same tree renders as the **Tournament tree** broadcast scene.

Uploads go through `POST /api/upload` as base64 data URLs (≤ 5 MB, image MIME whitelist) and are stored under `public/uploads/logos/`, `maps/`, `players/` and `radars/` — gitignored, served at `/uploads/...` in dev and production, and pruned automatically when a saved configuration no longer references them. A file uploaded in the last 15 minutes is never pruned, so a portrait that is waiting for its **Save** click survives someone else's save. Config keeps only the asset path.

### Player photos and aliases

Every roster row has a portrait and an **alias**:

- **Alias** replaces the name CS2 reports on the killfeed, both roster columns, the lower third and the radar dots. Empty means "show what CS2 says": the overlay never invents or "corrects" a name on its own.
- **Photo** (PNG, JPEG, GIF, WEBP or SVG, ≤ 5 MB) appears on the lower third and on the Lineups and Winner scenes. With the real name and role it turns the lower third into a player card. Photos are cropped to fill their slot from the top, so faces stay in frame.
- **Who is who.** A live player is matched to a roster entry by **SteamID** first (exact). Only when that finds nobody is the in-game name compared, case-insensitively, with the roster's nickname or alias. Two rostered players with the same name are never guessed between: the side they are on breaks the tie, otherwise nobody matches.
- SteamIDs can be typed as SteamID64, `STEAM_0:1:1234`, `[U:1:2468]` or a `steamcommunity.com/profiles/…` URL and are stored as SteamID64, which is what GSI reports. Vanity URLs cannot be resolved offline and are kept as typed.
- The preview applies aliases as you type, before you save.

CS2 keys `allplayers` by SteamID and does not repeat the id inside each entry; the host now fills it in when a packet is validated, so the observed player (lower third, highlighted roster row) and SteamID matching work on real GSI data.

### Broadcast scenes

Matchup, lineups, map series, tournament tree, winner and break are full-canvas 1920 × 1080 graphics with animated entrances, drawn from `config/teams.json` — so they are correct before CS2 is even running. A scene on air owns the canvas: the live scoreboard, footer and SIGNAL LOST banner step aside. While **Arrange** is on, the live layout is always shown so the drag handles sit on real elements.

| Scene | Shows | Comes from |
| --- | --- | --- |
| Matchup | both teams (logo, or a team-colour monogram without one), VS, the series score, the format, each map with its thumbnail, pick and result | teams, maps |
| Lineups | five player cards per team — portrait, alias, real name, role — and coaches/subs on a bench line | rosters; live GSI players stand in only for a team with no roster |
| Map series | series score and a card per map: thumbnail or uploaded picture, pick, LIVE / PLAYED / UP NEXT, score with the winner highlighted | maps |
| Tournament tree | the bracket with connector lines, team logos, winners highlighted, a LIVE tab on the running match | bracket |
| Winner | the champion, final score, per-map results, the starting five | see below |
| Break | your wording, a countdown, and the next map | `config.break`, `controls.breakEndsAt` |

- **Series score**: the operator's recorded map results win; before any are entered the live GSI series score is used, credited through the resolved sides (a stand-in side has no team to credit).
- **Winner**: the live GSI series winner, then recorded results, then the tree's final, then a finished map. With nothing decided it says so rather than guessing.
- **Map pictures**: the uploaded picture, else the shipped map thumbnail (`public/thumbs/`, resized from the same pack's `images/thumbs`), else a striped placeholder. The radar overviews in `public/radars/` belong to the [Radar](#radar) only and are never shown on a scene.
- **Break**: *Broadcast scenes → Break screen* holds the title and message (saved with the configuration) and the countdown (3, 5, 10, 15 minutes or your own). The timer is stored as an absolute host-clock time, so every output counts down to the same instant; each browser corrects for its own clock from `serverTime` in the snapshot.
- Teams and colours come from the configuration, so **Swap team sides** also mirrors the scenes.

### OBS WebSocket (optional)

SCOUT can talk to OBS Studio's built-in WebSocket server (obs-websocket 5.x, OBS 28 or newer) to show OBS's status in the panel and switch OBS's scene along with yours. It is **off by default**, outbound-only, and can never affect GSI intake or the overlay: with it off, unreachable or misconfigured the host behaves exactly as before.

1. In OBS: *Tools → WebSocket Server Settings*, enable the server (default port 4455). If you set a password, start the host with `OBS_WS_PASSWORD=<password>`. The password is read from the environment **only** — it is never typed into the panel, saved to disk, returned by the API or included in a snapshot (the same treatment as `GSI_TOKEN`).
2. *Broadcast scenes → OBS Studio*: switch on **Connect to OBS** (or start the host with `OBS_WS_URL=ws://host:4455`, which enables it by default), check the address, map each SCOUT scene to an OBS scene — leave a row blank to leave OBS alone — and **Save OBS settings**. **Test** switches OBS immediately.
3. **Scene sync** — *Status only*; *SCOUT to OBS* (putting a scene on air switches the mapped OBS scene); or *Both ways* (switching to a mapped scene inside OBS — a hotkey, a Stream Deck — puts the matching SCOUT scene on air). SCOUT recognises the echo of its own switch and never answers it, so two-way sync cannot loop.

Behaviour worth knowing:

- Connecting never changes OBS's scene; only a scene *change* does. An unmapped scene, a scene OBS does not have, or the scene OBS is already on are left alone, and the panel says why a switch did not happen.
- **Refresh overlay in OBS** presses the browser source's reload button. The source is found by its `/obs` or `/game` address, or by the name entered under *Overlay browser source*.
- An OBS that is not running yet is retried with backoff. A wrong password, an OBS that is too old, or a session kicked from OBS's session list are **not** retried (that would only fill OBS's log); the panel says so — fix it and press **Reconnect**.
- The address must be `ws://` or `wss://` and must not contain credentials. Settings live in ignored `config/obs.json`. API: `GET`/`PUT /api/obs` and `POST /api/obs/reconnect`, `/api/obs/switch`, `/api/obs/refresh-overlay` (same-origin only, like the rest of the operator API).
- **Verification**: the bridge is tested over real WebSockets against a mock OBS written from the protocol document, including the document's worked authentication example, wrong and missing passwords, a kicked session, a refused connection, a dead socket and hostile frames. It has **not** been run against a real OBS Studio.

### Windows overlay shell (Tauri v2, optional)

`src-tauri/` is a small Windows app that shows `/game` in a transparent, click-through, always-on-top window laid exactly over the CS2 window — an alternative to the OBS Browser Source for when the overlay should appear on the observer's own screen.

- It polls (250 ms) for the window titled exactly `Counter-Strike 2` with class `SDL_app`, and for its client area, foreground and minimised state. Nothing else: no memory reading, no injection, no hooks.
- The overlay is visible only while CS2 is in the foreground (it hides about 400 ms after CS2 leaves, so a passing notification does not make it blink), follows a moved or resized window, and is built not to take keyboard focus (non-focusable window). Mouse input passes through to the game.
- **F8** switches the overlay on and off; **Ctrl+Shift+F8** quits it (a hidden, click-through window has no other way out). Both are configurable.
- CS2 must run in *Fullscreen Windowed* (borderless): a window cannot be drawn over exclusive fullscreen.
- It loads the overlay once the SCOUT host answers, so a host that is not running yet draws nothing over the game.
- Build and run: install Rust and `cargo install tauri-cli --version "^2"`, then `npm run shell:build` (or `npm run shell:dev`). Options, environment variables and limits are in [`src-tauri/README.md`](src-tauri/README.md).
- **Verification**: the shell's decisions (`src-tauri/core`) have unit tests, and the Win32 layer is executed against a fake `user32` (`npm run shell:test:win32`). The Tauri glue was type-checked against the documented Tauri 2.12 API. The shell has **not** been compiled against Tauri or run on Windows hardware — that has to happen on the observer machine.

### Operator controls

Scene selection (live, matchup, lineups, map series, tournament tree, winner, break), killfeed, lower-third, economy, technical pause, team display swap and the break countdown are saved to ignored `config/operator.json` and broadcast to all connected views. The panel header names the session driving the broadcast — **LOCAL SESSION** on the host machine, **REMOTE · <address>** for one unlocked from another machine, with **Sign out** — so an operator can always see whether someone else is holding the panel (see [Operator access from another machine](#operator-access-from-another-machine)). Radar images are optional: see [Radar](#radar). Teams, rosters, maps and the bracket live in `config/teams.json`, edited from the panel as described above. Demo preview is local to the operator and never modifies server state.

### Repositioning the overlay

*Overlay settings → Arrange* (the move icon on the preview) turns the preview into a drag surface: the event header, scoreboard, radar, killfeed, both rosters, player lower-third, economy bar and footer each get a dashed handle. Drag them where you want them, then **Save layout**:

- Positions are top-left coordinates on the 1920 × 1080 canvas, stored in ignored `config/layout.json` and pushed by `PUT /api/layout` to every connected view — the preview and both output routes follow, no restart. An entry with no stored position keeps its CSS default.
- **Reset positions** restores the shipped defaults (an empty `elements` map), **Discard** drops unsaved moves. Nothing moves on air until **Save layout**.
- Dragging measures against the scaled `.hud` box, so the scaled preview and the full-size output agree to the pixel, and every element is clamped to keep a visible strip on-canvas so a panel can never be dragged out of reach behind the overflow clip.
- Transient centred graphics (SIGNAL LOST, phase banners and cards, round results, the full-screen broadcast scenes) are not movable by design — they anchor to the centre of the frame.

## Scope / remaining work

Every stage the specification listed now exists: player photos and alias overrides, rich broadcast scenes, the optional OBS WebSocket bridge and the Windows Tauri v2 shell. `/game` is still a plain browser renderer; the shell is what makes it a native window.

This is **not yet tournament-production verified**.

- **Verified here**: synthetic-state, configuration, scene-derivation, OBS-protocol (against a protocol-faithful mock) and shell-decision tests; `tsc` and the production build; and the rendered HUD, scenes and panel, checked as headless-Chromium screenshots against the real host driven through its HTTP API and the recorded-feed replay.
- **Not verifiable here**: a real CS2 observer, a real OBS Studio and Windows hardware were unavailable. Actual 20 Hz GSI compatibility, transparent OBS compositing, the OBS bridge against a real obs-websocket, and the shell's behaviour on Windows (a transparent, click-through, non-activating WebView2 window; F8; following CS2) must be verified on the observer machine. The shell could not be compiled against Tauri in this environment.

Security: binds `0.0.0.0` so the panel can be driven from another machine, and every mutation then needs either a request from the host machine or the panel token (see [Operator access from another machine](#operator-access-from-another-machine)). Run it on a trusted LAN and restrict firewall ingress; don't expose the service to the public internet, and put TLS in front of it if you do. The token and the OBS password are never part of the configuration, the API or a log line — the OBS password only ever comes from `OBS_WS_PASSWORD`. Not verified here: TLS termination in front of the host, and a real second machine on a real venue network.
