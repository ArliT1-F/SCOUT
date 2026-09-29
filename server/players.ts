import type {PlayerConfig,TeamConfig} from './config.js';
// Roster identity: which configured player a live GSI player is, and what the overlay calls them.
//
// The operator's roster (config/teams.json) carries an optional on-air alias and a portrait per player.
// GSI only knows the in-game name and a SteamID, so this module is the one place that decides whether
// they are the same person. Two rules keep it honest:
//   1. A SteamID is exact. A name is only a fallback, and an ambiguous name (two rostered players with
//      the same handle) resolves to nobody rather than to a guess.
//   2. Only an explicit alias ever replaces what CS2 reports. An unmatched player, or a matched one with
//      no alias, keeps the in-game name — the overlay never invents or "corrects" a name on its own.

// SteamID64 = the 64-bit "individual, public universe, desktop" base + the 32-bit account number.
const STEAM64_BASE=76561197960265728n;
const STEAM64=/^7656119\d{10}$/;
// Accepts what operators actually paste: SteamID64, legacy STEAM_X:Y:Z, [U:1:N] / U:1:N, and profile URLs
// that carry the numeric id. Vanity URLs cannot be resolved offline and are rejected rather than guessed.
export function toSteamId64(input?:string):string|undefined {
 if(typeof input!=='string') return undefined;
 const text=input.trim();
 if(!text) return undefined;
 if(STEAM64.test(text)) return text;
 const legacy=/^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(text);
 if(legacy) return String(STEAM64_BASE+BigInt(legacy[2])*2n+BigInt(legacy[1]));
 const modern=/^\[?U:1:(\d{1,10})\]?$/i.exec(text);
 if(modern) return String(STEAM64_BASE+BigInt(modern[1]));
 const profile=/steamcommunity\.com\/profiles\/(7656119\d{10})(?:[/?#]|$)/i.exec(text);
 return profile?profile[1]:undefined;
}

export interface LivePlayer {steamid?:string;name?:string}
export interface RosterEntry {team:TeamConfig;player:PlayerConfig}
export interface Roster {entries:RosterEntry[];bySteamId:Map<string,RosterEntry>;byName:Map<string,RosterEntry[]>}
// Names are compared folded: case, surrounding space and Unicode look-alike forms (full-width letters,
// ligatures) must not make "NOVA" and "ｎｏｖａ" two different people.
const fold=(value?:string)=>(typeof value==='string'?value:'').normalize('NFKC').trim().toLowerCase();

export function buildRoster(config?:{teams?:TeamConfig[]}|null):Roster {
 const entries:RosterEntry[]=[], bySteamId=new Map<string,RosterEntry>(), byName=new Map<string,RosterEntry[]>();
 for(const team of config?.teams||[]) for(const player of team.players||[]){
  const entry={team,player};
  entries.push(entry);
  const id=toSteamId64(player.steamid);
  if(id&&!bySteamId.has(id)) bySteamId.set(id,entry);
  // Both the handle and the alias identify a player: CS2 may already report the on-air name.
  for(const key of new Set([fold(player.name),fold(player.alias)])){
   if(!key) continue;
   const list=byName.get(key)||[];
   list.push(entry);byName.set(key,list);
  }
 }
 return {entries,bySteamId,byName};
}

// `preferTeamId` is the config team that currently holds the player's side; it only breaks a tie between
// same-named players, and never overrides a SteamID.
export function identify(roster:Roster,live:LivePlayer,preferTeamId?:string):RosterEntry|undefined {
 const byId=roster.bySteamId.get(live.steamid||'')||roster.bySteamId.get(toSteamId64(live.steamid)||'');
 if(byId) return byId;
 const candidates=roster.byName.get(fold(live.name));
 if(!candidates?.length) return undefined;
 if(candidates.length===1) return candidates[0];
 const narrowed=preferTeamId?candidates.filter(entry=>entry.team.id===preferTeamId):[];
 return narrowed.length===1?narrowed[0]:undefined;
}

// What the overlay prints for a live player: the alias when one is set and the player is recognised,
// otherwise exactly what CS2 reported.
export function shownName(roster:Roster,live:LivePlayer,preferTeamId?:string):string {
 return identify(roster,live,preferTeamId)?.player.alias||live.name||'';
}

// A card for the config-driven scenes (lineups, winner) and the lower third.
export interface PlayerCard {name:string;realName:string;role:string;photo:string;steamid:string;teamId:string}
export function cardOf(entry:RosterEntry):PlayerCard {
 const {player,team}=entry;
 return {name:player.alias||player.name||player.nickname||'',realName:player.nickname||'',role:player.role||'',photo:player.photo||'',steamid:player.steamid||'',teamId:team.id};
}
// Coaches, analysts and substitutes are on the roster but are not part of "the starting five".
const BENCH=/\b(coach|head coach|analyst|manager|sub|substitute|bench|stand-?in|reserve)\b/i;
export const isBench=(player:Pick<PlayerConfig,'role'>)=>BENCH.test(player.role||'');
export function splitRoster(team:TeamConfig,starters=5):{starters:PlayerCard[];bench:PlayerCard[]} {
 const cards=(team.players||[]).map(player=>cardOf({team,player}));
 const playing:PlayerCard[]=[], bench:PlayerCard[]=[];
 for(const [index,card] of cards.entries()) (isBench(team.players[index])||playing.length>=starters?bench:playing).push(card);
 return {starters:playing,bench};
}
