export interface WeaponState { name:string; type:string; state:string; ammo_clip?:number; ammo_reserve?:number }
export interface PlayerState { steamid:string; name:string; observer_slot?:number; team:'CT'|'T'; activity?:string; state:{health:number;armor:number;helmet?:boolean;money:number;round_kills:number;round_killhs?:number;flashed?:number;burning?:number;defusekit?:boolean}; weapons:Record<string,WeaponState>; match_stats:{kills:number;deaths:number;assists:number}; position?:string;forward?:string }
export interface MatchState { provider?:{steamid?:string;timestamp?:number};map?:{name:string;phase:string;round:number;team_ct:{name:string;score:number};team_t:{name:string;score:number}};round?:{phase:string;win_team?:'CT'|'T';bomb?:string};player?:PlayerState;allplayers?:Record<string,PlayerState>;phase_countdowns?:{phase:string;phase_ends_in:string|number};bomb?:{state:string;countdown?:string;position?:string};grenades?:Record<string,unknown> }
const blocked = new Set(['__proto__','constructor','prototype','auth','previously','added','removed']);
export function mergeDelta(base: Record<string,any>, delta: Record<string,any>): Record<string,any> {
 const out = {...base};
 for (const [key,value] of Object.entries(delta)) {
  if(blocked.has(key)) continue;
  if(value === null) { delete out[key]; continue; }
  // Dynamic inventories are authoritative when supplied; omission retains them.
  if(['weapons','allplayers','grenades'].includes(key)) out[key]=sanitize(value);
  else if(value && typeof value==='object' && !Array.isArray(value)) out[key]=mergeDelta(out[key] && typeof out[key]==='object'?out[key]:{},value);
  else out[key]=value;
 }
 return out;
}
function sanitize(value:any):any { if(Array.isArray(value)) return value.map(sanitize); if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=>!blocked.has(k)).map(([k,v])=>[k,sanitize(v)])); return value; }
export class MatchStore {
 state:MatchState={}; lastSeen=0; revision=0;
 ingest(payload:MatchState, now=Date.now()) {
  const old=this.state;
  if(payload.provider?.timestamp && old.provider?.timestamp && payload.provider.timestamp<old.provider.timestamp) return false;
  const reset = now-this.lastSeen>5000 || (payload.map?.name && old.map?.name!==payload.map.name) || (payload.provider?.steamid && old.provider?.steamid!==payload.provider.steamid);
  this.state=mergeDelta(reset?{}:old,payload); this.lastSeen=now; this.revision++; return true;
 }
}
