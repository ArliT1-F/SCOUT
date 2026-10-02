import {validateGsi,sanitize,BLOCKED_KEYS,type Issue} from './schema.js';
export type {Issue} from './schema.js';
export interface WeaponState { name:string; type:string; state:string; ammo_clip?:number; ammo_reserve?:number }
export interface PlayerState { steamid:string; name:string; observer_slot?:number; team:'CT'|'T'; activity?:string; state:{health:number;armor:number;helmet?:boolean;money:number;round_kills:number;round_killhs?:number;flashed?:number;burning?:number;defusekit?:boolean}; weapons:Record<string,WeaponState>; match_stats:{kills:number;deaths:number;assists:number}; position?:string;forward?:string }
export interface GrenadeState { type?:string; owner?:string; lifetime?:string|number; effecttime?:string|number; position?:string; velocity?:string }
export interface MatchState { provider?:{steamid?:string;timestamp?:number};map?:{name:string;phase:string;round:number;team_ct:{name:string;score:number};team_t:{name:string;score:number}};round?:{phase:string;win_team?:'CT'|'T';bomb?:string};player?:PlayerState;allplayers?:Record<string,PlayerState>;phase_countdowns?:{phase:string;phase_ends_in:string|number};bomb?:{state:string;countdown?:string;position?:string};grenades?:Record<string,GrenadeState> }

export function mergeDelta(base: Record<string,any>, delta: Record<string,any>): Record<string,any> {
 const out = {...base};
 for (const [key,value] of Object.entries(delta)) {
  if(BLOCKED_KEYS.has(key)) continue;
  if(value === null) { delete out[key]; continue; }
  // Dynamic inventories are authoritative when supplied; omission retains them.
  if(['weapons','allplayers','grenades'].includes(key)) out[key]=sanitize(value);
  else if(value && typeof value==='object' && !Array.isArray(value)) out[key]=mergeDelta(out[key] && typeof out[key]==='object'?out[key]:{},value);
  else out[key]=value;
 }
 return out;
}
// Intake diagnostics: the shipped code could not tell "CS2 never sent anything" apart from
// "every packet 401'd" or "CS2 is sending player-only data because it is playing, not observing".
// FeedMonitor counts the three outcomes and reports which blocks the last accepted packet carried.
export const GSI_BLOCKS=['provider','map','round','player','allplayers','phase_countdowns','bomb','grenades'] as const;
export type GsiBlock=typeof GSI_BLOCKS[number];
export type TokenSource='env'|'default';
export interface GsiDiagnostics {accepted:number;rejectedAuth:number;rejectedShape:number;rejectedLate:number;subtreeIssues:number;lastPacketAt:number;lastPacketAge:number;lastRejectedAt:number;lastRejectedReason:string;blocks:Record<string,number>;allplayers:number;allplayersSeen:boolean;observerGap:boolean;provider:string|null;tokenSource:TokenSource;port:number;uri:string}
export class FeedMonitor {
 accepted=0; rejectedAuth=0; rejectedShape=0; rejectedLate=0; subtreeIssues=0; lastPacketAt=0; lastRejectedAt=0; lastRejectedReason=''; lastRejectedLogAt=0; lastIssueLogAt=0; lastLateLogAt=0; blocks:Record<string,number>={}; allplayers=0; allplayersSeen=false; provider:string|null=null;
 constructor(readonly tokenSource:TokenSource='default',readonly port=8080){}
 get uri(){return `http://127.0.0.1:${this.port}/gsi`}
 // The token itself is never passed in: only "env" or "default" is remembered.
 accept(payload:any,now=Date.now()) {
  const first=this.accepted===0; this.accepted++; this.lastPacketAt=now;
  const blocks:Record<string,number>={};
  for(const key of GSI_BLOCKS){const value=payload?.[key]; if(value===undefined||value===null) continue; blocks[key]=typeof value==='object'?Object.keys(value).length:1}
  const firstAllplayers=!this.allplayersSeen&&blocks.allplayers!==undefined;
  this.blocks=blocks; this.allplayers=blocks.allplayers??0; if(blocks.allplayers!==undefined) this.allplayersSeen=true;
  this.provider=typeof payload?.provider?.steamid==='string'?payload.provider.steamid:null;
  const observerGap=this.accepted===100&&!this.allplayersSeen;
  return {first,firstAllplayers,observerGap};
 }
 // Rejection logging is rate-limited inside the monitor so a 20 Hz bad-token feed logs once per gap.
 reject(kind:'auth'|'shape',reason='',now=Date.now(),gapMs=10000) {
  if(kind==='auth') this.rejectedAuth++; else this.rejectedShape++;
  this.lastRejectedAt=now; this.lastRejectedReason=reason;
  // The first rejection always logs; after that the reason is logged at most once per gap.
  const log=this.lastRejectedLogAt===0||now-this.lastRejectedLogAt>=gapMs; if(log) this.lastRejectedLogAt=now;
  return {log};
 }
 // "Late" is not a GSI fault: the payload was well-formed but the store already holds a newer
 // provider.timestamp. It is how a replayed recording, a second observer or a clock skew shows up.
 late(now=Date.now(),gapMs=10000) {
  this.rejectedLate++;
  const log=this.lastLateLogAt===0||now-this.lastLateLogAt>=gapMs; if(log) this.lastLateLogAt=now;
  return {log};
 }
 // Schema issues are normal on a live feed (CS2 omits or empties fields between rounds), so they are
 // counted and logged at the same 10 s cadence as rejections rather than one line per packet.
 issues(list:Issue[],now=Date.now(),gapMs=10000) {
  this.subtreeIssues+=list.length;
  const log=list.length>0&&(this.lastIssueLogAt===0||now-this.lastIssueLogAt>=gapMs); if(log) this.lastIssueLogAt=now;
  return {log,count:list.length,last:list[list.length-1]};
 }
 snapshot(now=Date.now()):GsiDiagnostics {return {accepted:this.accepted,rejectedAuth:this.rejectedAuth,rejectedShape:this.rejectedShape,rejectedLate:this.rejectedLate,subtreeIssues:this.subtreeIssues,lastPacketAt:this.lastPacketAt,lastPacketAge:this.lastPacketAt?now-this.lastPacketAt:0,lastRejectedAt:this.lastRejectedAt,lastRejectedReason:this.lastRejectedReason,blocks:this.blocks,allplayers:this.allplayers,allplayersSeen:this.allplayersSeen,observerGap:this.accepted>=100&&!this.allplayersSeen,provider:this.provider,tokenSource:this.tokenSource,port:this.port,uri:this.uri}}
}
// Exactly one next action for the operator, keyed to the failure modes seen in the field.
export function feedNextAction(gsi?:GsiDiagnostics|null):string {
 if(!gsi) return 'Host not reporting diagnostics yet — reload the dashboard or restart the host.';
 if(gsi.accepted===0&&gsi.rejectedAuth>0) return `CS2 reaches the host but every packet is rejected on its token (${gsi.rejectedAuth} so far). Put the cfg auth token into GSI_TOKEN and restart the host — the current token comes from ${gsi.tokenSource==='env'?'the environment':'the built-in default'}.`;
 if(gsi.accepted===0&&gsi.rejectedShape>0) return `Packets arrive but fail the shape check (${gsi.rejectedShape} so far): ${gsi.lastRejectedReason||'missing provider'}. Confirm the cfg was not saved as .cfg.txt and that CS2 was fully restarted.`;
 if(gsi.accepted===0) return `Nothing has reached ${gsi.uri}. Check the cfg sits in game/csgo/cfg/ (not .cfg.txt), that CS2 was fully restarted, and that the cfg uri port matches the host port ${gsi.port}.`;
 if(gsi.rejectedLate>0&&gsi.rejectedLate>=gsi.accepted-gsi.rejectedLate) return `${gsi.rejectedLate} packets were ignored because the host already holds a newer provider timestamp. Restart the host before replaying an older recording, and check that only one observer is pushing.`;
 if(gsi.lastPacketAge>5000) return `Last packet was ${Math.round(gsi.lastPacketAge/1000)}s ago. The match may have ended, or CS2 lost the endpoint — check the host is still running.`;
 if(!gsi.allplayersSeen&&gsi.accepted>=100) return `Receiving packets (${gsi.accepted}) but no allplayers block: CS2 is playing, not spectating. Join as observer/GOTV so rosters and the killfeed have data.`;
 return `Feed healthy: ${gsi.accepted} packets accepted, blocks ${Object.keys(gsi.blocks).join(', ')||'(none)'}. Switch the preview to GSI feed to watch live data.`;
}
export class MatchStore {
 state:MatchState={}; lastSeen=0; revision=0;
 // Returns the per-subtree validation issues, or false when the packet was dropped as late.
 // A malformed field never aborts the packet: it is dropped, counted and reported.
 ingest(payload:MatchState, now=Date.now()):{issues:Issue[];reset:boolean}|false {
  const old=this.state, {payload:clean,issues}=validateGsi(payload);
  const next=clean as MatchState;
  if(next.provider?.timestamp && old.provider?.timestamp && next.provider.timestamp<old.provider.timestamp) return false;
  const reset = now-this.lastSeen>5000 || !!(next.map?.name && old.map?.name!==next.map.name) || !!(next.provider?.steamid && old.provider?.steamid!==next.provider.steamid);
  this.state=mergeDelta(reset?{}:old,next); this.lastSeen=now; this.revision++; return {issues,reset};
 }
}
