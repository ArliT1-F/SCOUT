#!/usr/bin/env python3
"""Builds tests/fixtures/observer-mirage-nuke.jsonl — a sanitized CS2 observer capture.

Structure and cadence mirror a real 20 Hz recording (partial blocks, `previously` metadata, bomb
countdowns), but every name and SteamID is invented. Re-run from the repo root:
    python3 tests/fixtures/generate.py
"""
import json, pathlib

CT_TEAM, T_TEAM = "Nordwind", "Solaris"
NAMES = ["arvo", "kettu", "loki", "miska", "paavi", "noki", "susi", "tapio", "ukko", "veko"]
STEAM = {name: f"7656119000000{i:04d}" for i, name in enumerate(NAMES, start=1)}
ROSTER = {"CT": NAMES[:5], "T": NAMES[5:]}
SWAPPED = {"CT": NAMES[5:], "T": NAMES[:5]}
SLOT = {name: i + 1 for i, name in enumerate(NAMES)}
lines, clock = [], [0]


def packet(payload, gap=50):
    clock[0] += gap
    lines.append({"receivedAt": 1750000000000 + clock[0], "payload": payload})


def roster(teams, money=None, health=None):
    out = {}
    for side, names in teams.items():
        for name in names:
            out[STEAM[name]] = {
                "name": name, "clan": "NW" if side == "CT" else "SOL", "observer_slot": SLOT[name], "team": side,
                "state": {"health": (health or {}).get(name, 100), "armor": 100, "helmet": True,
                          "money": (money or {}).get(name, 800), "round_kills": 0, "round_killhs": 0,
                          "flashed": 0, "burning": 0, "defusekit": name in names[:2]},
                "weapons": {"weapon_0": {"name": "weapon_m4a1" if side == "CT" else "weapon_ak47", "type": "Rifle",
                                         "state": "active", "ammo_clip": 30, "ammo_reserve": 90}},
                "match_stats": {"kills": 0, "assists": 0, "deaths": 0, "mvps": 0, "score": 0},
                "position": f"{-1000 + SLOT[name] * 120}.00, {400 - SLOT[name] * 60}.00, 0.00",
                "forward": "90.00, 0.00, 0.00"}
    return out


def mutate(ap, name, **fields):
    ap[STEAM[name]]["state"].update(fields)
    if "round_kills" in fields:
        ap[STEAM[name]]["match_stats"]["kills"] += fields["round_kills"]
    return ap


def base(round_no, ct_score, t_score, phase, ct_name=CT_TEAM, t_name=T_TEAM, map_name="de_mirage", round_wins=None, warmup=False, map_phase=None):
    return {
        "provider": {"name": "Counter-Strike: Global Offensive", "appid": 730, "version": 14060, "steamid": STEAM["arvo"], "timestamp": 1750000000 + clock[0] // 1000},
        "map": {"name": map_name, "mode": "competitive", "phase": map_phase or ("warmup" if warmup else "live"), "round": round_no,
                "team_ct": {"name": ct_name, "score": ct_score, "consecutive_round_losses": 0, "timeouts_remaining": 2, "matches_won_this_series": 0},
                "team_t": {"name": t_name, "score": t_score, "consecutive_round_losses": 0, "timeouts_remaining": 2, "matches_won_this_series": 0},
                "warmup": warmup, "num_matches": 1, **({"round_wins": round_wins} if round_wins else {})},
        "round": {"phase": phase},
        "player": {"steamid": STEAM["arvo"], "name": "observer", "team": "CT", "observer_slot": 1, "activity": "playing",
                   "state": {"health": 100, "armor": 100, "helmet": True, "money": 800, "round_kills": 0, "round_killhs": 0, "flashed": 0, "burning": 0, "defusekit": False},
                   "weapons": {"weapon_0": {"name": "weapon_deagle", "type": "Pistol", "state": "active", "ammo_clip": 7, "ammo_reserve": 35}},
                   "match_stats": {"kills": 0, "assists": 0, "deaths": 0, "mvps": 0, "score": 0},
                   "position": "-1400.00, 900.00, 0.00", "forward": "90.00, 0.00, 0.00", "spectarget": STEAM["arvo"]}}


def delta(**blocks):
    payload = {"provider": {"timestamp": 1750000000 + clock[0] // 1000}}
    payload.update(blocks)
    return payload


# --- warmup ---------------------------------------------------------------
ap = roster(ROSTER)
packet({**base(0, 0, 0, "freezetime", warmup=True), "allplayers": ap, "phase_countdowns": {"phase": "warmup", "phase_ends_in": "45.0"}})
ap = roster(ROSTER, health={"susi": 62, "ukko": 18})
packet({**delta(allplayers=ap), "previously": {"provider": {"timestamp": 1749999999}}, "auth": {"token": "sanitized"}})

# --- round 1: pistol round, two Solaris players die -----------------------
ap = roster(ROSTER)
packet({**base(0, 0, 0, "freezetime"), "allplayers": ap, "phase_countdowns": {"phase": "freezetime", "phase_ends_in": "15.2"}}, gap=200)
for ends in ["13.0", "11.0", "9.4"]:
    packet({**delta(round={"phase": "freezetime"}), "phase_countdowns": {"phase": "freezetime", "phase_ends_in": ends}})
packet({**base(1, 0, 0, "live"), "allplayers": ap, "phase_countdowns": {"phase": "live", "phase_ends_in": "115.0"}})
ap = roster(ROSTER)
mutate(ap, "susi", health=74, armor=88)
packet(delta(allplayers=ap))                                        # Loki opens the round
ap = roster(ROSTER)
mutate(ap, "susi", health=0, armor=88)
mutate(ap, "ukko", health=38, armor=0, helmet=False, flashed=60)
mutate(ap, "loki", round_kills=1, round_killhs=1, money=1100)
packet(delta(allplayers=ap))                                        # Loki finishes the kill
round_wins = {"1": "ct"}
ap = roster(ROSTER, health={"susi": 0, "ukko": 0, "veko": 0})
packet({**base(1, 1, 0, "over", round_wins=round_wins), "round": {"phase": "over", "win_team": "CT"}, "allplayers": ap,
        "phase_countdowns": {"phase": "over", "phase_ends_in": "4.4"}})

# --- round 2: Solaris plant, bomb explodes for the T side -----------------
packet({**base(2, 1, 0, "freezetime", round_wins=round_wins), "allplayers": roster(ROSTER), "phase_countdowns": {"phase": "freezetime", "phase_ends_in": "14.9"}})
packet({**base(2, 1, 0, "live", round_wins=round_wins), "allplayers": roster(ROSTER, money={n: 2600 for n in NAMES}), "phase_countdowns": {"phase": "live", "phase_ends_in": "110.0"}})
packet(delta(bomb={"state": "carried", "player": STEAM["susi"], "position": "-800.00, 300.00, 10.00"}))
for ends in ["36.4", "33.2", "29.9"]:
    packet(delta(round={"phase": "live", "bomb": "planted"}, phase_countdowns={"phase": "bomb", "phase_ends_in": ends},
                 bomb={"state": "planted", "countdown": ends, "player": STEAM["susi"], "position": "-800.00, 300.00, 10.00"}))
round_wins["2"] = "t"
packet({**base(2, 1, 1, "over", round_wins=round_wins), "round": {"phase": "over", "win_team": "T", "bomb": "exploded"},
        "bomb": {"state": "exploded", "countdown": "0.0", "position": "-800.00, 300.00, 10.00"},
        "allplayers": roster(ROSTER, health={"arvo": 0, "miska": 0}), "phase_countdowns": {"phase": "over", "phase_ends_in": "6.1"}})

# --- round 3: Solaris plant, Nordwind defuses -----------------------------
packet({**base(3, 1, 1, "freezetime", round_wins=round_wins), "allplayers": roster(ROSTER), "phase_countdowns": {"phase": "freezetime", "phase_ends_in": "15.0"}})
packet({**base(3, 1, 1, "live", round_wins=round_wins), "allplayers": roster(ROSTER, money={n: 4200 for n in NAMES}), "phase_countdowns": {"phase": "live", "phase_ends_in": "108.0"}})
packet(delta(round={"phase": "live", "bomb": "planted"}, phase_countdowns={"phase": "bomb", "phase_ends_in": "38.0"},
             bomb={"state": "planted", "countdown": "38.0", "player": STEAM["noki"], "position": "700.00, -400.00, 5.00"}))
ap = roster(ROSTER)
mutate(ap, "loki", health=88)
packet(delta(bomb={"state": "defusing", "countdown": "33.0", "player": STEAM["loki"], "position": "700.00, -400.00, 5.00"},
             phase_countdowns={"phase": "bomb", "phase_ends_in": "33.0"}, allplayers=ap))
round_wins["3"] = "ct"
packet({**base(3, 2, 1, "over", round_wins=round_wins), "round": {"phase": "over", "win_team": "CT", "bomb": "defused"},
        "bomb": {"state": "defused", "countdown": "28.4", "player": STEAM["loki"], "position": "700.00, -400.00, 5.00"},
        "phase_countdowns": {"phase": "over", "phase_ends_in": "5.8"}})

# --- round 4: opening kill, grenade, round over ---------------------------
packet({**base(4, 2, 1, "live", round_wins=round_wins), "allplayers": roster(ROSTER, money={n: 1500 for n in NAMES}), "phase_countdowns": {"phase": "live", "phase_ends_in": "112.0"}})
ap = roster(ROSTER)
mutate(ap, "ukko", health=0, armor=0, helmet=False, money=1500)
mutate(ap, "kettu", health=91, round_kills=1, round_killhs=1)
packet(delta(allplayers=ap, grenades={"he_1": {"type": "hegrenade", "owner": STEAM["kettu"], "lifetime": "0.4", "position": "120.00, -80.00, 40.00"}}))
round_wins["4"] = "ct"
packet({**base(4, 3, 1, "over", round_wins=round_wins), "round": {"phase": "over", "win_team": "CT"},
        "allplayers": roster(ROSTER, health={"veko": 0, "noki": 0, "susi": 0}), "phase_countdowns": {"phase": "over", "phase_ends_in": "6.0"}})

# --- halftime side swap, then the second map ------------------------------
wins = {str(r): ("ct" if r < 5 else "t") for r in range(1, 9)}
packet({**base(4, 4, 8, "over", ct_name=T_TEAM, t_name=CT_TEAM, round_wins=wins), "round": {"phase": "over", "win_team": "T"}, "allplayers": roster(SWAPPED, money={n: 2400 for n in NAMES}), "phase_countdowns": {"phase": "over", "phase_ends_in": "14.7"}})
packet({**delta(map={"phase": "intermission",
                     "team_ct": {"name": T_TEAM, "score": 4, "matches_won_this_series": 0},
                     "team_t": {"name": CT_TEAM, "score": 8, "matches_won_this_series": 0}}),
        "round": {"phase": "over", "win_team": "T"}, "phase_countdowns": {"phase": "over", "phase_ends_in": "9.2"}})
packet({**base(0, 0, 0, "freezetime", ct_name=T_TEAM, t_name=CT_TEAM, map_name="de_nuke", warmup=True),
        "allplayers": roster(SWAPPED, money={n: 800 for n in NAMES}), "phase_countdowns": {"phase": "freezetime", "phase_ends_in": "14.0"}})
packet({**delta(map={"name": "de_nuke", "mode": "competitive", "phase": "live", "round": 1, "warmup": False, "num_matches": 1,
                     "team_ct": {"name": T_TEAM, "score": 0, "matches_won_this_series": 0},
                     "team_t": {"name": CT_TEAM, "score": 0, "matches_won_this_series": 0}}),
        "allplayers": roster(SWAPPED, money={n: 800 for n in NAMES}), "phase_countdowns": {"phase": "live", "phase_ends_in": "115.0"}})
packet({**delta(map={"phase": "gameover", "team_ct": {"name": T_TEAM, "score": 1, "matches_won_this_series": 1},
                     "team_t": {"name": CT_TEAM, "score": 0, "matches_won_this_series": 0}}),
        "round": {"phase": "over", "win_team": "CT"}, "allplayers": roster(SWAPPED, health={n: 0 for n in SWAPPED["T"]})})

out = pathlib.Path(__file__).with_name("observer-mirage-nuke.jsonl")
out.write_text("".join(json.dumps(line, separators=(",", ":")) + "\n" for line in lines))
print(f"{out.name}: {len(lines)} packets, {out.stat().st_size} bytes, {clock[0] / 1000:.1f}s of recorded spacing")
