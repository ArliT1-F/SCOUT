import {z} from 'zod';
// CS2 pushes partial payloads at ~20 Hz and every block is optional, so validation must be
// per-subtree and non-fatal: a bad field is dropped and counted, the rest of the packet is merged.
// Coercion is defensive because CS2 sends some numbers as strings ("phase_ends_in":"71.4",
// "health":"100") and empties unset enums (bomb state "", round win_team "").
export interface Issue {path:string;reason:string}
// Metadata CS2 repeats in every packet, plus the keys that would let a payload walk the prototype chain.
export const BLOCKED_KEYS=new Set(['__proto__','constructor','prototype','auth','previously','added','removed']);
export function sanitize(value:any):any { if(Array.isArray(value)) return value.map(sanitize); if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([k])=>!BLOCKED_KEYS.has(k)).map(([k,v])=>[k,sanitize(v)])); return value }
const isObject=(value:any):value is Record<string,any>=>!!value && typeof value==='object' && !Array.isArray(value);
const numeric=z.union([z.number(),z.string().trim().min(1)]).transform(Number).refine(Number.isFinite,'expected a number').describe('a number').optional();
const integer=z.union([z.number(),z.string().trim().min(1)]).transform(Number).refine(Number.isInteger,'expected an integer').describe('an integer').optional();
const flag=z.union([z.boolean(),z.number(),z.string()]).transform(value=>value===true||value===1||value==='1'||value==='true').describe('a boolean').optional();
const text=z.string().describe('a string').optional();
const clock=z.union([z.string(),z.number()]).transform(String).describe('a clock value').optional();
// Unset enums arrive as "" — that deletes the key instead of counting as invalid, so a normal
// round-boundary packet does not fill the diagnostics with noise.
const oneOf=(...values:string[])=>z.string().refine(value=>value===''||values.includes(value),'expected one of '+values.join('/')).describe(values.join('/')).transform(value=>value===''?undefined:value).optional();
const side=z.object({name:text,flag:text,score:integer,consecutive_round_losses:integer,timeouts_remaining:integer,matches_won_this_series:integer}).passthrough();
const playerState=z.object({health:integer,armor:integer,helmet:flag,flashed:numeric,smoked:numeric,burning:numeric,money:integer,round_kills:integer,round_killhs:integer,round_totaldmg:integer,equip_value:integer,defusekit:flag}).passthrough();
const matchStats=z.object({kills:integer,assists:integer,deaths:integer,mvps:integer,score:integer}).passthrough();
const weapon=z.object({name:text,type:text,state:text,ammo_clip:integer,ammo_reserve:integer,paintkit:text}).passthrough();
const player=z.object({steamid:text,name:text,clan:text,observer_slot:integer,team:oneOf('CT','T'),activity:text,state:playerState,weapons:z.record(weapon),match_stats:matchStats,position:text,forward:text,spectarget:text}).passthrough();
const grenade=z.object({type:text,owner:text,lifetime:clock,effecttime:clock,position:text,velocity:text}).passthrough();
export const schemas={
 provider:z.object({name:text,appid:integer,version:integer,steamid:text,timestamp:numeric}).passthrough(),
 map:z.object({name:text,mode:text,phase:text,round:integer,warmup:flag,num_matches:integer,team_ct:side,team_t:side}).passthrough(),
 round:z.object({phase:text,win_team:oneOf('CT','T'),bomb:oneOf('planted','exploded','defused')}).passthrough(),
 player,
 allplayers:z.record(player),
 phase_countdowns:z.object({phase:text,phase_ends_in:clock}).passthrough(),
 bomb:z.object({state:oneOf('carrying','planted','defusing','defused','exploded','dropped'),countdown:clock,player:text,position:text}).passthrough(),
 grenades:z.record(grenade),
};
function reasonOf(error:z.ZodError,field:z.ZodTypeAny):string {const issue=error.issues[0]; if(!issue) return 'invalid value'; const described=(field as any)?._def?.description; return issue.message==='Invalid input'&&described?`expected ${described}`:issue.message}
// zod keeps a record's member schema on _def; read it defensively so a zod upgrade degrades to
// "drop that block" instead of throwing inside the GSI hot path.
const recordMember=(schema:z.ZodTypeAny):z.ZodTypeAny|undefined=>(schema as any)?._def?.valueType;
function repair(raw:any,schema:z.ZodTypeAny,path:string,issues:Issue[]):any {
 if(schema instanceof z.ZodRecord) return repairRecord(raw,schema,path,issues);
 if(schema instanceof z.ZodObject) return repairObject(raw,schema,path,issues);
 const parsed=schema.safeParse(raw);
 if(parsed.success) return parsed.data;
 issues.push({path,reason:reasonOf(parsed.error,schema)});
 return undefined;
}
function repairObject(raw:any,schema:z.ZodObject<any>,path:string,issues:Issue[]):Record<string,any>|undefined {
 if(!isObject(raw)){issues.push({path,reason:'expected an object'});return undefined}
 const out:Record<string,any>={}, shape=schema.shape;
 for(const [key,value] of Object.entries(raw)){
  if(BLOCKED_KEYS.has(key)||key in shape) continue;
  out[key]=sanitize(value); // unknown keys survive untouched, minus the blocked ones, for forward compatibility
 }
 for(const [key,field] of Object.entries(shape)){
  if(!Object.prototype.hasOwnProperty.call(raw,key)) continue; // omission preserves the previously merged value
  const repaired=repair(raw[key],field as z.ZodTypeAny,path+'.'+key,issues);
  if(repaired!==undefined) out[key]=repaired;
 }
 return out;
}
function repairRecord(raw:any,schema:z.ZodRecord<any>,path:string,issues:Issue[]):Record<string,any>|undefined {
 if(!isObject(raw)){issues.push({path,reason:'expected an object'});return undefined}
 const member=recordMember(schema), out:Record<string,any>={};
 for(const [key,value] of Object.entries(raw)){
  if(BLOCKED_KEYS.has(key)) continue;
  const repaired=member?repair(value,member,path+'.'+key,issues):sanitize(value);
  if(repaired!==undefined) out[key]=repaired;
 }
 return out;
}
export function validateGsi(payload:any):{payload:Record<string,any>;issues:Issue[]} {
 const issues:Issue[]=[];
 if(!isObject(payload)) return {payload:{},issues:[{path:'',reason:'expected a GSI object'}]};
 const out:Record<string,any>={};
 for(const [key,value] of Object.entries(payload)){
  if(BLOCKED_KEYS.has(key)) continue;
  const schema=(schemas as Record<string,z.ZodTypeAny>)[key];
  if(!schema){out[key]=sanitize(value);continue} // unknown blocks pass through: CS2 adds them between versions
  const repaired=repair(value,schema,key,issues);
  if(repaired!==undefined) out[key]=repaired;
 }
 // CS2 keys `allplayers` by SteamID and does not repeat the id inside each entry, yet the HUD finds the
 // observed player, keys its rows and matches the operator's roster by `steamid`. Fill it in from the key
 // (an entry that already carries an id keeps it).
 if(isObject(out.allplayers)) for(const [steamid,entry] of Object.entries(out.allplayers)) if(isObject(entry)&&(typeof entry.steamid!=='string'||!entry.steamid)) entry.steamid=steamid;
 return {payload:out,issues};
}
