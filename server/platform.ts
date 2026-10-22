import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {normalizeConfig} from './config.js';
// Account-owned workspaces and aggregate metrics. Live GSI/WS remains one match per host.
import {DEFAULT_MAP_ROTATION} from '../src/map-rotation.js';
export {DEFAULT_MAP_ROTATION};
export function sanitizeMapRotation(input:unknown,previous:string[]):string[]{
 if(!Array.isArray(input)||!input.length||input.length>32||input.some(v=>typeof v!=='string'||!/^de_[a-z0-9_]{1,48}$/.test(v)))return [...previous];
 return [...new Set(input)];
}
export interface PlatformSettings {
 mapRotation:string[];
 maxTournamentsPerUser:number;
 applicationsOpen:boolean; reviewNote:string; publicStatsEnabled:boolean; betaReviewers:string[];
 version:number; updatedAt:number; updatedBy:string;
}
export const DEFAULT_PLATFORM_SETTINGS:PlatformSettings={
 mapRotation:[...DEFAULT_MAP_ROTATION],maxTournamentsPerUser:3,applicationsOpen:true,
 reviewNote:'Applications are reviewed by a human. If approved, we will email you a single-use invitation.',
 publicStatsEnabled:false,betaReviewers:[],version:1,updatedAt:0,updatedBy:'',
};
export type MetricKind='kill'|'headshot'|'grenade'|'round'|'map'|'match';
export const METRIC_KINDS:MetricKind[]=['kill','headshot','grenade','round','map','match'];
export interface MetricTotals {kills:number;headshots:number;grenades:number;rounds:number;maps:number;matches:number}
export const emptyTotals=():MetricTotals=>({kills:0,headshots:0,grenades:0,rounds:0,maps:0,matches:0});
export interface MetricEvent {id?:string;kind:MetricKind;count?:number;map?:string;detail?:string;at?:number}
export interface MetricLogEntry {id?:string;at:number;kind:MetricKind;count:number;map?:string;detail?:string;accountId:string;tournamentId:string}
export interface Tournament {
 id:string;accountId:string;ownerEmail:string;name:string;
 config:unknown|null; configVersion:number; configHash:string|null;
 createdAt:number;updatedAt:number;lastActiveAt:number|null;
 totals:MetricTotals;logs:MetricLogEntry[];
}
export interface TournamentView extends Omit<Tournament,'config'|'logs'> {hasConfig:boolean;logCount:number}
export interface ConfigReceipt {id:string;tournamentId:string;configVersion:number;configHash:string;localHash:string}
export interface PlatformStoreData {
 version:1;settings:PlatformSettings;tournaments:Tournament[];activeTournamentId:string|null;
 activeByAccount:Record<string,string>;globalLogs:MetricLogEntry[];
 // Compressed sequence ranges are never pruned with the logs: even very old retries stay deduped.
 eventIds:Record<string,Array<[number,number]>>;
 configReceipts:Record<string,ConfigReceipt>;
}
export const normalizeEmail=(v:string)=>v.trim().toLowerCase();
export function platformOwnerEmail(env:NodeJS.ProcessEnv=process.env){return normalizeEmail(env.SCOUT_OWNER_EMAIL||'')}
export function isPlatformOwner(email:string|null|undefined,env:NodeJS.ProcessEnv=process.env){
 const owner=platformOwnerEmail(env);return !!owner&&!!email&&normalizeEmail(email)===owner;
}
export function sanitizeSettings(input:Partial<PlatformSettings>|undefined,previous:PlatformSettings,by:string,now=Date.now()):PlatformSettings{
 const max=Math.floor(Number(input?.maxTournamentsPerUser));
 const candidate=Array.isArray(input?.betaReviewers)?input.betaReviewers:previous.betaReviewers??[];
 const betaReviewers=[...new Set(candidate.filter((email):email is string=>typeof email==='string').map(normalizeEmail).filter(email=>email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))].slice(0,100);
 return {
  mapRotation:sanitizeMapRotation(input?.mapRotation,previous.mapRotation??DEFAULT_MAP_ROTATION),
  maxTournamentsPerUser:Number.isFinite(max)?Math.min(25,Math.max(1,max)):previous.maxTournamentsPerUser,
  applicationsOpen:typeof input?.applicationsOpen==='boolean'?input.applicationsOpen:previous.applicationsOpen,
  reviewNote:typeof input?.reviewNote==='string'?input.reviewNote.slice(0,400):previous.reviewNote,
  publicStatsEnabled:typeof input?.publicStatsEnabled==='boolean'?input.publicStatsEnabled:previous.publicStatsEnabled,
  betaReviewers,
  version:previous.version+1,updatedAt:now,updatedBy:by,
 };
}
/** Schema normalization strips unknown fields and fixes property order before hashing. */
export function configHash(config:unknown){return createHash('sha256').update(JSON.stringify(normalizeConfig(config))).digest('hex')}
export function globalTotals(tournaments:Tournament[]):MetricTotals{
 const out=emptyTotals();for(const t of tournaments)for(const k of Object.keys(out) as (keyof MetricTotals)[])out[k]+=t.totals[k];return out;
}
export function tournamentView(t:Tournament):TournamentView{
 const {config,logs,...rest}=t;return {...rest,hasConfig:config!==null,logCount:logs.length};
}
const LOG_CAP=300,GLOBAL_LOG_CAP=1000;
export type PlatformResult<T>={ok:true;value:T}|{ok:false;status:number;code:string;message:string};
const fail=(status:number,code:string,message:string):PlatformResult<never>=>({ok:false,status,code,message});
function eventSequence(id:string):[string,number]{
 const match=/^([\w-]+):([1-9]\d*)$/.exec(id);
 return match&&Number.isSafeInteger(Number(match[2]))?[`device:${match[1]}`,Number(match[2])]:[`event:${id}`,0];
}
export class PlatformStore {
 data:PlatformStoreData={version:1,settings:{...DEFAULT_PLATFORM_SETTINGS},tournaments:[],activeTournamentId:null,activeByAccount:{},globalLogs:[],eventIds:{},configReceipts:{}};
 private writes:Promise<void>=Promise.resolve();
 constructor(private readonly file:string,private readonly now:()=>number=Date.now){}
 async load(){
  try{const p=JSON.parse(await readFile(this.file,'utf8'));
   if(p&&Array.isArray(p.tournaments)){
    this.data={...this.data,...p,version:1,settings:{...DEFAULT_PLATFORM_SETTINGS,...p.settings},activeByAccount:p.activeByAccount??{},globalLogs:p.globalLogs??[],eventIds:p.eventIds??{},configReceipts:p.configReceipts??{}};
    for(const t of this.data.tournaments){
     t.configVersion=t.configVersion||1;
     if(t.config!==null){t.config=normalizeConfig(t.config);t.configHash=configHash(t.config)}else t.configHash=null;
    }
    const active=this.active();if(active&&!this.data.activeByAccount[active.accountId])this.data.activeByAccount[active.accountId]=active.id;
   }
  }catch(e:any){if(e?.code!=='ENOENT')console.warn('[platform] platform store unreadable:',e.message)}
  return this;
 }
 async save(){
  const snapshot=JSON.stringify(this.data,null,2);
  const write=this.writes.then(async()=>{
   await mkdir(path.dirname(this.file),{recursive:true});
   await writeFile(this.file+'.tmp',snapshot,{mode:0o600});await rename(this.file+'.tmp',this.file);
  });
  this.writes=write.catch(()=>{});await write;
 }
 get settings(){return this.data.settings}
 async setSettings(settings:PlatformSettings){
  if(JSON.stringify(this.settings)===JSON.stringify(settings))return;
  this.data.settings={...DEFAULT_PLATFORM_SETTINGS,...settings};await this.save();
 }
 async updateSettings(input:Partial<PlatformSettings>,by:string){this.data.settings=sanitizeSettings(input,this.settings,by,this.now());await this.save();return this.settings}
 listFor(accountId:string){return this.data.tournaments.filter(t=>t.accountId===accountId).sort((a,b)=>b.updatedAt-a.updatedAt).map(tournamentView)}
 get(id:string){return this.data.tournaments.find(t=>t.id===id)}
 ownedBy(id:string,accountId:string){const t=this.get(id);return t&&t.accountId===accountId?t:null}
 async create(accountId:string,email:string,name:string,config:unknown|null):Promise<PlatformResult<Tournament>>{
  if(this.listFor(accountId).length>=this.settings.maxTournamentsPerUser)return fail(409,'tournament-limit',`You may host at most ${this.settings.maxTournamentsPerUser} tournament(s) on SCOUT right now. Delete one, or ask the SCOUT owner to raise the limit in /admin.`);
  const normalized=config==null?null:normalizeConfig(config);
  const t:Tournament={id:randomBytes(9).toString('base64url'),accountId,ownerEmail:normalizeEmail(email),name:(name||'My tournament').trim().slice(0,80)||'My tournament',config:normalized,configVersion:1,configHash:normalized?configHash(normalized):null,createdAt:this.now(),updatedAt:this.now(),lastActiveAt:null,totals:emptyTotals(),logs:[]};
  this.data.tournaments.push(t);await this.save();return {ok:true,value:t};
 }
 async update(id:string,accountId:string,patch:{name?:string;config?:unknown},expected?:{version:number;hash:string}):Promise<PlatformResult<Tournament>>{
  const t=this.ownedBy(id,accountId);if(!t)return fail(404,'not-found','That tournament is not yours (or does not exist).');
  if(expected&&(t.configVersion!==expected.version||t.configHash!==expected.hash))return fail(409,'config-conflict','A newer version exists on the platform.');
  if(typeof patch.name==='string'&&patch.name.trim())t.name=patch.name.trim().slice(0,80);
  if(patch.config!==undefined){t.config=normalizeConfig(patch.config);t.configHash=configHash(t.config);t.configVersion++}
  t.updatedAt=this.now();await this.save();return {ok:true,value:t};
 }
 async saveActiveConfig(config:unknown){const t=this.active();return t?this.update(t.id,t.accountId,{config}):null}
 async remove(id:string,accountId:string):Promise<PlatformResult<{removed:boolean}>>{
  const t=this.ownedBy(id,accountId);if(!t)return fail(404,'not-found','That tournament is not yours (or does not exist).');
  this.data.tournaments=this.data.tournaments.filter(x=>x!==t);
  if(this.data.activeTournamentId===id)this.data.activeTournamentId=null;
  if(this.data.activeByAccount[accountId]===id)delete this.data.activeByAccount[accountId];
  await this.save();return {ok:true,value:{removed:true}};
 }
 async activate(id:string,accountId:string):Promise<PlatformResult<Tournament>>{
  const t=this.ownedBy(id,accountId);if(!t)return fail(404,'not-found','That tournament is not yours (or does not exist).');
  this.data.activeTournamentId=id;this.data.activeByAccount[accountId]=id;t.lastActiveAt=this.now();t.updatedAt=this.now();await this.save();return {ok:true,value:t};
 }
 active(){return this.data.activeTournamentId?this.get(this.data.activeTournamentId)??null:null}
 activeFor(accountId:string){const id=this.data.activeByAccount[accountId];return id?this.ownedBy(id,accountId):null}
 /** A launcher's local shadow retains metrics, but never claims a browser's account identity. */
 async adopt(input:{id:string;name:string;configVersion:number;updatedAt:number},deviceId:string,email:string,config:unknown){
  let t=this.get(input.id);
  if(!t){t={id:input.id,name:input.name,accountId:`device:${deviceId}`,ownerEmail:email,config:null,configVersion:1,configHash:null,createdAt:this.now(),updatedAt:input.updatedAt,lastActiveAt:null,totals:emptyTotals(),logs:[]};this.data.tournaments.push(t)}
  Object.assign(t,{name:input.name,config:normalizeConfig(config),configHash:configHash(config),configVersion:input.configVersion,updatedAt:input.updatedAt,lastActiveAt:this.now()});
  this.data.activeTournamentId=t.id;this.data.activeByAccount[t.accountId]=t.id;await this.save();
 }
 hasEvent(id:string){const [key,n]=eventSequence(id);return this.data.eventIds[key]?.some(([lo,hi])=>lo<=n&&n<=hi)??false}
 markEvent(id:string){
  const [key,n]=eventSequence(id);const ranges=[...(this.data.eventIds[key]??[]),[n,n] as [number,number]].sort((a,b)=>a[0]-b[0]);
  const merged:Array<[number,number]>=[];
  for(const [lo,hi] of ranges){const last=merged.at(-1);if(last&&lo<=last[1]+1)last[1]=Math.max(last[1],hi);else merged.push([lo,hi])}
  this.data.eventIds[key]=merged;
 }
 /** Totals and the idempotency ledger are persisted in the same atomic snapshot. */
 async record(tournamentId:string,events:MetricEvent[]):Promise<PlatformResult<MetricTotals>>{
  const t=this.get(tournamentId);if(!t)return fail(404,'not-found','Unknown tournament.');
  let changed=false;
  for(const e of events){
   if(!METRIC_KINDS.includes(e?.kind)||(e.id&&this.hasEvent(e.id)))continue;
   const count=Math.min(1000,Math.max(1,Math.floor(Number(e.count)||1)));
   const key=e.kind==='kill'?'kills':e.kind==='headshot'?'headshots':e.kind==='grenade'?'grenades':e.kind==='round'?'rounds':e.kind==='map'?'maps':'matches';
   t.totals[key]+=count;if(e.id)this.markEvent(e.id);changed=true;
   const entry:MetricLogEntry={id:e.id,at:e.at??this.now(),kind:e.kind,count,map:e.map?.slice(0,40),detail:e.detail?.slice(0,160),accountId:t.accountId,tournamentId:t.id};
   t.logs.push(entry);if(t.logs.length>LOG_CAP)t.logs.splice(0,t.logs.length-LOG_CAP);
   this.data.globalLogs.push(entry);if(this.data.globalLogs.length>GLOBAL_LOG_CAP)this.data.globalLogs.splice(0,this.data.globalLogs.length-GLOBAL_LOG_CAP);
  }
  if(changed){t.updatedAt=this.now();await this.save()}return {ok:true,value:t.totals};
 }
 /** Compare-and-swap config pushes; the receipt and config commit together, like metrics. */
 async pushConfig(id:string,accountId:string,config:unknown,eventId:string,localHash:string,base:{version:number;hash:string}):Promise<PlatformResult<ConfigReceipt>>{
  if(this.hasEvent(eventId)){const receipt=this.data.configReceipts[eventId];return receipt?{ok:true,value:receipt}:fail(409,'config-conflict','A newer version exists on the platform.')}
  const t=this.ownedBy(id,accountId);if(!t)return fail(404,'not-found','Unknown tournament.');
  if(t.configVersion!==base.version||t.configHash!==base.hash)return fail(409,'config-conflict','A newer version exists on the platform.');
  t.config=normalizeConfig(config);t.configHash=configHash(t.config);t.configVersion++;t.updatedAt=this.now();
  const receipt:ConfigReceipt={id:eventId,tournamentId:id,configVersion:t.configVersion,configHash:t.configHash,localHash};
  this.markEvent(eventId);this.data.configReceipts[eventId]=receipt;await this.save();return {ok:true,value:receipt};
 }
 adminSummary(accounts:Array<{id:string;email:string;status:string}>){
  const byAccount=new Map<string,{accountId:string;email:string;status:string;tournaments:number;totals:MetricTotals;lastActiveAt:number|null}>();
  for(const a of accounts)byAccount.set(a.id,{accountId:a.id,email:a.email,status:a.status,tournaments:0,totals:emptyTotals(),lastActiveAt:null});
  for(const t of this.data.tournaments){
   let row=byAccount.get(t.accountId);
   if(!row){row={accountId:t.accountId,email:t.ownerEmail,status:'approved',tournaments:0,totals:emptyTotals(),lastActiveAt:null};byAccount.set(t.accountId,row)}
   row.tournaments++;const g=globalTotals([t]);(Object.keys(g) as (keyof MetricTotals)[]).forEach(k=>row!.totals[k]+=g[k]);
   row.lastActiveAt=Math.max(row.lastActiveAt||0,t.lastActiveAt||t.updatedAt)||null;
  }
  return {settings:this.settings,activeTournamentId:this.data.activeTournamentId,totals:globalTotals(this.data.tournaments),tournaments:this.data.tournaments.map(tournamentView),users:[...byAccount.values()].sort((a,b)=>(b.lastActiveAt||0)-(a.lastActiveAt||0)),recentLogs:[...this.data.globalLogs].reverse().slice(0,100)};
 }
}
