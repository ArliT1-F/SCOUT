import type {MatchState} from './state.js';
// Events are derived by differencing successive snapshots, never inferred from a single packet, so a
// repeated packet (CS2 resends whole blocks) produces nothing. Health→0 is the only death trigger;
// the killer comes from a round_kills/match_stats increment in the same packet, which is how normal
// authoritative allplayers blocks arrive. Missing increments leave the killer unknown rather than
// guessing.
export type Side='CT'|'T';
export type RoundReason='bomb'|'defuse'|'elimination'|'time'|'unknown';
export interface KillEvent {id:number;at:number;round:number;map:string;killer?:string;killerName?:string;killerSide?:Side;victim:string;victimName:string;victimSide?:Side;weapon?:string;headshot:boolean}
export interface RoundEvent {round:number;map:string;winner?:Side;reason:RoundReason;ctScore:number;tScore:number;startedAt:number;endedAt:number}
export interface EventSnapshot {kills:KillEvent[];rounds:RoundEvent[]}
interface Watched {health?:number;roundKills:number;roundKillhs:number;kills:number;name:string;side?:Side;active?:string}
const KILL_RING=8, ROUND_RING=40;
export class EventTracker {
 kills:KillEvent[]=[]; rounds:RoundEvent[]=[]; round:number|undefined;
 private watched:Record<string,Watched>={}; private started:Record<string,number>={}; private id=0; private bombOutcome:RoundReason|undefined; private lastBomb:string|undefined;
 // `reset` is the store's own reset (map change, provider change or a >5 s gap). Kills and per-player
 // watch state are dropped unconditionally — that is what stops a stale feed from double-counting —
 // while finished rounds are kept, tagged with their map, because they are history, not live state.
 observe(state:MatchState,now=Date.now(),reset=false):{kills:KillEvent[];ended?:RoundEvent} {
  if(reset){this.kills=[];this.watched={};this.started={};this.round=undefined;this.bombOutcome=undefined;this.lastBomb=undefined}
  const map=state.map?.name||'', players=state.allplayers||{}, round=state.map?.round??this.round??0;
  // Only a *transition* counts: the merged state keeps the last bomb.state for the rest of the map,
  // so reading it directly would label every later round end with the same outcome.
  const bomb=state.bomb?.state;
  if(bomb&&bomb!==this.lastBomb){if(bomb==='exploded') this.bombOutcome='bomb'; else if(bomb==='defused') this.bombOutcome='defuse'}
  if(bomb!==undefined) this.lastBomb=bomb;
  const current:Record<string,Watched>={};
  for(const [steamid,player] of Object.entries(players)){
   const before=this.watched[steamid];
   current[steamid]={health:player.state?.health??before?.health,roundKills:player.state?.round_kills??before?.roundKills??0,roundKillhs:player.state?.round_killhs??before?.roundKillhs??0,kills:player.match_stats?.kills??before?.kills??0,name:player.name||before?.name||steamid,side:(player.team||before?.side) as Side|undefined,active:Object.values(player.weapons||{}).find(weapon=>weapon.state==='active')?.name||before?.active};
  }
  const risen=(value:(watched:Watched)=>number)=>Object.keys(current).map(other=>[other,value(current[other])-(value(this.watched[other]??current[other]))] as [string,number]).filter(([,delta])=>delta>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([other])=>other);
  // A kill is credited when another player's round_kills rises in the same packet; match_stats.kills
  // is the fallback when round_kills is not in the packet. Several deaths in one packet are matched
  // to the credited killers in order — best effort, and the only honest guess available.
  const roundRises=risen(player=>player.roundKills), credited=roundRises.length?roundRises:risen(player=>player.kills);
  const deaths=Object.entries(current).filter(([steamid,player])=>player.health===0&&this.watched[steamid]?.health!==undefined&&this.watched[steamid].health!==0);
  const fresh:KillEvent[]=deaths.map(([steamid,player],index)=>{
   const killer=credited[index]!==steamid?credited[index]:credited.find(other=>other!==steamid);
   const from=killer?current[killer]:undefined;
   return {id:++this.id,at:now,round,map,killer,killerName:from?.name,killerSide:from?.side,victim:steamid,victimName:player.name,victimSide:player.side,weapon:from?.active,headshot:!!killer&&from!.roundKillhs>(this.watched[killer]?.roundKillhs??from!.roundKillhs)};
  });
  this.watched=current; this.kills=(fresh.length?this.kills.concat(fresh):this.kills).slice(-KILL_RING);
  if(state.map?.round!==undefined){const key=`${map}:${state.map.round}`; if(this.started[key]===undefined) this.started[key]=now; if(this.round!==state.map.round) this.bombOutcome=undefined; this.round=state.map.round}
  const ended=this.roundEnd(state,map,round,now);
  return {kills:fresh,ended};
 }
 private roundEnd(state:MatchState,map:string,round:number,now:number):RoundEvent|undefined {
  const over=state.round?.phase==='over'||state.map?.phase==='gameover'||state.map?.phase==='intermission';
  if(!over||this.rounds.some(event=>event.map===map&&event.round===round)) return undefined;
  const winners=(state.map as any)?.round_wins?.[String(round)];
  const winner=(state.round?.win_team||(winners==='ct'?'CT':winners==='t'?'T':undefined)) as Side|undefined;
  const players=Object.values(state.allplayers||{});
  const wiped=(side:Side)=>players.some(player=>player.team===side)&&players.every(player=>player.team!==side||player.state?.health===0);
  // A bomb left over from an earlier round must not label this round end, so the outcome only counts
  // once per round and is consumed here.
  const reason:RoundReason=this.bombOutcome??(winner&&wiped(winner==='CT'?'T':'CT')?'elimination':winner?'time':'unknown');
  this.bombOutcome=undefined;
  const event:RoundEvent={round,map,winner,reason,ctScore:state.map?.team_ct?.score??0,tScore:state.map?.team_t?.score??0,startedAt:this.started[`${map}:${round}`]??now,endedAt:now};
  this.rounds=this.rounds.concat(event).slice(-ROUND_RING);
  return event;
 }
 snapshot():EventSnapshot {return {kills:this.kills,rounds:this.rounds}}
}
