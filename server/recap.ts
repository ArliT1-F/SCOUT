// Recap Kit (docs/LAUNCH-FEATURES.md §4): what a finished match leaves behind.
//
// Everything here comes from the session archive — the same file the archive tab already shows — and
// nothing is invented. GSI reports assists, MVPs and per-round damage only while the round is live,
// so the host writes a small player snapshot at each round end (server/recordings.ts). An archive
// without snapshots still produces a recap from kills and rounds, with assists, MVPs and damage
// reported as "not captured" instead of zero.
import type {KillEvent,RoundEvent} from './events.js';
import type {MatchArchive,SnapshotPlayer} from './recordings.js';
import type {ScoutConfig} from './config.js';
import type {MatchState} from './state.js';

export interface RecapPlayer {
 steamid:string;name:string;teamIndex:number;
 kills:number;deaths:number;assists:number|null;mvps:number|null;
 headshots:number;damage:number|null;adr:number|null;kd:number|null;hsPct:number|null;
}
export interface RecapMap {map:string;ctScore:number;tScore:number;winner:'CT'|'T'|null;rounds:number;winnerTeamIndex:number|null}
export interface RecapTeam {name:string;mapsWon:number;players:number}
export interface Recap {
 archiveId:string;name:string;event:string;stage:string;format:string;
 startedAt:number;endedAt:number|null;durationMs:number|null;
 teams:RecapTeam[];maps:RecapMap[];players:RecapPlayer[];
 totals:{kills:number;headshots:number;rounds:number;maps:number};
 captured:{snapshots:boolean;assists:boolean;damage:boolean};
 seriesWinner:number|null;mvp:RecapPlayer|null;
}
const isKill=(event:MatchArchive['events'][number]):event is {at:number;type:'kill';data:KillEvent}=>event.type==='kill';
const isRound=(event:MatchArchive['events'][number]):event is {at:number;type:'round';data:RoundEvent}=>event.type==='round';
export function buildRecap(archive:MatchArchive):Recap {
 const kills=archive.events.filter(isKill).map(event=>event.data);
 const rounds=archive.events.filter(isRound).map(event=>event.data);
 const snapshots=archive.snapshots??[];
 // The last observation of a player wins: it is a cumulative GSI match_stats reading, not a delta.
 const latest=new Map<string,SnapshotPlayer>();
 for(const snapshot of snapshots) for(const player of snapshot.players) latest.set(player.steamid,player);
 const damageByPlayer=new Map<string,number>();
 for(const snapshot of snapshots) for(const player of snapshot.players) damageByPlayer.set(player.steamid,(damageByPlayer.get(player.steamid)??0)+Math.max(0,player.roundDamage||0));
 const teamOrder=new Map<string,number>();
 for(const snapshot of snapshots) for(const player of snapshot.players) if(player.teamIndex>=0) teamOrder.set(player.steamid,player.teamIndex);
 const names=new Map<string,string>();
 for(const player of latest.values()) names.set(player.steamid,player.name);
 for(const kill of kills){
  if(kill.killer&&kill.killerName&&!names.has(kill.killer)) names.set(kill.killer,kill.killerName);
  if(!names.has(kill.victim)) names.set(kill.victim,kill.victimName);
 }
 const steamids=new Set<string>([...names.keys()]);
 const killsBy=new Map<string,number>(),deathsBy=new Map<string,number>(),headshotsBy=new Map<string,number>();
 for(const kill of kills){
  if(kill.killer) killsBy.set(kill.killer,(killsBy.get(kill.killer)??0)+1);
  deathsBy.set(kill.victim,(deathsBy.get(kill.victim)??0)+1);
  if(kill.headshot&&kill.killer) headshotsBy.set(kill.killer,(headshotsBy.get(kill.killer)??0)+1);
 }
 const roundCount=rounds.length;
 const players:RecapPlayer[]=[];
 for(const steamid of steamids){
  const snapshot=latest.get(steamid);
  const killsTotal=snapshot?.kills??killsBy.get(steamid)??0;
  const deathsTotal=snapshot?.deaths??deathsBy.get(steamid)??0;
  const headshots=headshotsBy.get(steamid)??0;
  const damage=snapshots.length?damageByPlayer.get(steamid)??0:null;
  players.push({
   steamid,name:names.get(steamid)||steamid,teamIndex:teamOrder.get(steamid)??-1,
   kills:killsTotal,deaths:deathsTotal,
   assists:snapshot?snapshot.assists:null,mvps:snapshot?snapshot.mvps:null,
   headshots,damage,
   adr:damage!==null&&roundCount?Math.round((damage/roundCount)*10)/10:null,
   kd:deathsTotal?Math.round((killsTotal/deathsTotal)*100)/100:null,
   hsPct:killsTotal?Math.round((headshots/killsTotal)*100):null,
  });
 }
 players.sort((first,second)=>second.kills-first.kills||second.headshots-first.headshots||first.name.localeCompare(second.name));
 // Per-map result: the last round recorded on that map is the score, and the side that won it is
 // mapped back to an organisation through the round-end snapshot (side → teamIndex).
 const mapNames=[...new Set<string>([...archive.maps,...rounds.map(round=>round.map)])].filter(Boolean);
 const maps:RecapMap[]=mapNames.map(map=>{
  const mapRounds=rounds.filter(round=>round.map===map);
  const last=mapRounds[mapRounds.length-1];
  const lastSnapshot=[...snapshots].reverse().find(snapshot=>snapshot.map===map);
  let winnerTeamIndex:number|null=null;
  if(last?.winner&&lastSnapshot){
   const sideVotes=new Map<number,number>();
   for(const player of lastSnapshot.players) if(player.side===last.winner&&player.teamIndex>=0) sideVotes.set(player.teamIndex,(sideVotes.get(player.teamIndex)??0)+1);
   const [top]=[...sideVotes.entries()].sort((first,second)=>second[1]-first[1]);
   if(top) winnerTeamIndex=top[0];
  }
  return {map,ctScore:last?.ctScore??0,tScore:last?.tScore??0,winner:last?.winner??null,rounds:mapRounds.length,winnerTeamIndex};
 });
 const teams=archive.teams.slice(0,2).map((name,index)=>({name,mapsWon:maps.filter(map=>map.winnerTeamIndex===index).length,players:players.filter(player=>player.teamIndex===index).length}));
 const seriesWinner=(()=>{
  if(teams.length<2) return null;
  if(teams[0].mapsWon===teams[1].mapsWon) return null;
  return teams[0].mapsWon>teams[1].mapsWon?0:1;
 })();
 const totals={kills:kills.length,headshots:kills.filter(kill=>kill.headshot).length,rounds:roundCount,maps:maps.length};
 return {
  archiveId:archive.id,name:archive.name,event:archive.event,stage:archive.stage,format:archive.format,
  startedAt:archive.startedAt,endedAt:archive.endedAt,durationMs:archive.endedAt?archive.endedAt-archive.startedAt:null,
  teams,maps,players,totals,
  captured:{snapshots:snapshots.length>0,assists:snapshots.length>0,damage:snapshots.length>0},
  seriesWinner,mvp:players[0]??null,
 };
}
// The host's side of the contract: one snapshot per round end, with the organisation resolved by
// SteamID at that moment. A player missing from the config keeps teamIndex -1 and is still counted.
export function snapshotFromState(state:MatchState,config:ScoutConfig,at:number):{map:string;round:number;players:SnapshotPlayer[]} {
 const teamOf=new Map<string,number>();
 config.teams.forEach((team,index)=>{for(const player of team.players) if(player.steamid) teamOf.set(player.steamid,index)});
 const players:SnapshotPlayer[]=Object.entries(state.allplayers||{}).map(([steamid,player])=>({
  steamid,
  name:player.name||steamid,
  side:String(player.team||''),
  kills:Number(player.match_stats?.kills||0),
  deaths:Number(player.match_stats?.deaths||0),
  assists:Number(player.match_stats?.assists||0),
  mvps:Number((player.match_stats as any)?.mvps||0),
  roundKills:Number(player.state?.round_kills||0),
  roundKillhs:Number(player.state?.round_killhs||0),
  roundDamage:Number((player.state as any)?.round_totaldmg||0),
  teamIndex:teamOf.get(steamid)??-1,
 }));
 return {map:state.map?.name||'',round:state.map?.round??0,players};
}
export function recapCsv(recap:Recap):string {
 const rows:string[][]=[['player','team','kills','deaths','assists','mvps','headshots','hs_pct','damage','adr','kd']];
 for(const player of recap.players){
  rows.push([player.name,recap.teams[player.teamIndex]?.name??'',String(player.kills),String(player.deaths),player.assists===null?'':String(player.assists),player.mvps===null?'':String(player.mvps),String(player.headshots),player.hsPct===null?'':String(player.hsPct),player.damage===null?'':String(player.damage),player.adr===null?'':String(player.adr),player.kd===null?'':String(player.kd)]);
 }
 // Spreadsheet formula prefixes are neutralized exactly like the owner desk's CSV exports.
 return rows.map(row=>row.map(value=>{const safe=/^[=+\-@]/.test(value)?`'${value}`:value;return /[",\n]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe}).join(',')).join('\n')+'\n';
}
export function formatDuration(ms:number|null):string {
 if(!ms||ms<0) return '—';
 const minutes=Math.round(ms/60_000);
 return minutes>=60?`${Math.floor(minutes/60)}h ${minutes%60}m`:`${minutes}m`;
}
