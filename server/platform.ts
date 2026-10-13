import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
// Hosted multi-tenancy + platform administration (docs/PLATFORM.md).
// Whitelisting itself still lives in server/beta.ts / server/account-service.ts (approved accounts).
// This module is the layer above it: every approved account may own independent tournament
// workspaces, the SCOUT platform owner (SCOUT_OWNER_EMAIL) administers settings + whitelist +
// metrics, and live match events are aggregated so /welcome can eventually show real totals.
// Settings carry a monotonically increasing version; the host includes them in every WS snapshot
// and broadcasts on change, so a setting changed by the owner reaches open panels in real time.

export interface PlatformSettings {
 maxTournamentsPerUser:number; // beta default 3; set to 1 for release from /admin
 applicationsOpen:boolean;
 reviewNote:string;
 publicStatsEnabled:boolean;
 version:number; updatedAt:number; updatedBy:string;
}
export const DEFAULT_PLATFORM_SETTINGS:PlatformSettings={
 maxTournamentsPerUser:3, applicationsOpen:true,
 reviewNote:'Applications are reviewed by a human. You will receive an invite link as soon as your operator account is created.',
 publicStatsEnabled:false, version:1, updatedAt:0, updatedBy:'',
};
export type MetricKind='kill'|'headshot'|'grenade'|'round'|'map'|'match';
export const METRIC_KINDS:MetricKind[]=['kill','headshot','grenade','round','map','match'];
export interface MetricTotals {kills:number;headshots:number;grenades:number;rounds:number;maps:number;matches:number}
export const emptyTotals=():MetricTotals=>({kills:0,headshots:0,grenades:0,rounds:0,maps:0,matches:0});
export interface MetricLogEntry {at:number;kind:MetricKind;count:number;map?:string;detail?:string;accountId:string;tournamentId:string}
export interface Tournament {
 id:string;accountId:string;ownerEmail:string;name:string;
 config:unknown|null; // a normalized ScoutConfig (validated by the caller with configSchema)
 createdAt:number;updatedAt:number;lastActiveAt:number|null;
 totals:MetricTotals; logs:MetricLogEntry[]; // bounded, newest last
}
export interface TournamentView extends Omit<Tournament,'config'|'logs'> {hasConfig:boolean;logCount:number}
export interface PlatformStoreData {version:1;settings:PlatformSettings;tournaments:Tournament[];activeTournamentId:string|null;globalLogs:MetricLogEntry[]}

export const normalizeEmail=(v:string)=>v.trim().toLowerCase();
export function platformOwnerEmail(env:NodeJS.ProcessEnv=process.env){return normalizeEmail(env.SCOUT_OWNER_EMAIL||'')}
export function isPlatformOwner(email:string|null|undefined,env:NodeJS.ProcessEnv=process.env){
 const owner=platformOwnerEmail(env); return !!owner&&!!email&&normalizeEmail(email)===owner;
}
export function sanitizeSettings(input:Partial<PlatformSettings>|undefined,previous:PlatformSettings,by:string,now=Date.now()):PlatformSettings{
 const max=Math.floor(Number(input?.maxTournamentsPerUser));
 return {
  maxTournamentsPerUser:Number.isFinite(max)?Math.min(25,Math.max(1,max)):previous.maxTournamentsPerUser,
  applicationsOpen:typeof input?.applicationsOpen==='boolean'?input.applicationsOpen:previous.applicationsOpen,
  reviewNote:typeof input?.reviewNote==='string'?input.reviewNote.slice(0,400):previous.reviewNote,
  publicStatsEnabled:typeof input?.publicStatsEnabled==='boolean'?input.publicStatsEnabled:previous.publicStatsEnabled,
  version:previous.version+1, updatedAt:now, updatedBy:by,
 };
}
export function globalTotals(tournaments:Tournament[]):MetricTotals{
 const out=emptyTotals();
 for(const t of tournaments){out.kills+=t.totals.kills;out.headshots+=t.totals.headshots;out.grenades+=t.totals.grenades;out.rounds+=t.totals.rounds;out.maps+=t.totals.maps;out.matches+=t.totals.matches}
 return out;
}
export function tournamentView(t:Tournament):TournamentView{
 const {config,logs,...rest}=t; return {...rest,hasConfig:config!==null,logCount:logs.length};
}
const LOG_CAP=300, GLOBAL_LOG_CAP=1000;
export type PlatformResult<T>={ok:true;value:T}|{ok:false;status:number;code:string;message:string};
const fail=(status:number,code:string,message:string):PlatformResult<never>=>({ok:false,status,code,message});

export class PlatformStore {
 data:PlatformStoreData={version:1,settings:{...DEFAULT_PLATFORM_SETTINGS},tournaments:[],activeTournamentId:null,globalLogs:[]};
 constructor(private readonly file:string,private readonly now:()=>number=Date.now){}
 async load(){
  try{const p=JSON.parse(await readFile(this.file,'utf8'));
   if(p&&Array.isArray(p.tournaments)) this.data={version:1,settings:{...DEFAULT_PLATFORM_SETTINGS,...p.settings},tournaments:p.tournaments,activeTournamentId:p.activeTournamentId??null,globalLogs:Array.isArray(p.globalLogs)?p.globalLogs:[]};
  }catch(e:any){if(e?.code!=='ENOENT') console.warn('[platform] platform store unreadable — starting empty:',e.message)}
  return this;
 }
 async save(){
  await mkdir(path.dirname(this.file),{recursive:true});
  await writeFile(this.file+'.tmp',JSON.stringify(this.data,null,2),{mode:0o600});
  await rename(this.file+'.tmp',this.file);
 }
 get settings(){return this.data.settings}
 async updateSettings(input:Partial<PlatformSettings>,by:string){this.data.settings=sanitizeSettings(input,this.data.settings,by,this.now());await this.save();return this.data.settings}
 listFor(accountId:string){return this.data.tournaments.filter(t=>t.accountId===accountId).sort((a,b)=>b.updatedAt-a.updatedAt).map(tournamentView)}
 get(id:string){return this.data.tournaments.find(t=>t.id===id)}
 ownedBy(id:string,accountId:string){const t=this.get(id);return t&&t.accountId===accountId?t:null}
 async create(accountId:string,email:string,name:string,config:unknown|null):Promise<PlatformResult<Tournament>>{
  const mine=this.data.tournaments.filter(t=>t.accountId===accountId);
  if(mine.length>=this.data.settings.maxTournamentsPerUser)
   return fail(409,'tournament-limit',`You may host at most ${this.data.settings.maxTournamentsPerUser} tournament(s) on SCOUT right now. Delete one, or ask the SCOUT owner to raise the limit in /admin.`);
  const t:Tournament={id:randomBytes(9).toString('base64url'),accountId,ownerEmail:normalizeEmail(email),name:(name||'My tournament').trim().slice(0,80)||'My tournament',config:config??null,createdAt:this.now(),updatedAt:this.now(),lastActiveAt:null,totals:emptyTotals(),logs:[]};
  this.data.tournaments.push(t); await this.save(); return {ok:true,value:t};
 }
 async update(id:string,accountId:string,patch:{name?:string;config?:unknown}):Promise<PlatformResult<Tournament>>{
  const t=this.ownedBy(id,accountId); if(!t) return fail(404,'not-found','That tournament is not yours (or does not exist).');
  if(typeof patch.name==='string'&&patch.name.trim()) t.name=patch.name.trim().slice(0,80);
  if(patch.config!==undefined) t.config=patch.config;
  t.updatedAt=this.now(); await this.save(); return {ok:true,value:t};
 }
 async remove(id:string,accountId:string):Promise<PlatformResult<{removed:boolean}>>{
  const t=this.ownedBy(id,accountId); if(!t) return fail(404,'not-found','That tournament is not yours (or does not exist).');
  this.data.tournaments=this.data.tournaments.filter(x=>x!==t);
  if(this.data.activeTournamentId===id) this.data.activeTournamentId=null;
  await this.save(); return {ok:true,value:{removed:true}};
 }
 async activate(id:string,accountId:string):Promise<PlatformResult<Tournament>>{
  const t=this.ownedBy(id,accountId); if(!t) return fail(404,'not-found','That tournament is not yours (or does not exist).');
  this.data.activeTournamentId=id; t.lastActiveAt=this.now(); t.updatedAt=this.now(); await this.save(); return {ok:true,value:t};
 }
 active(){return this.data.activeTournamentId?this.get(this.data.activeTournamentId)??null:null}
 /** Ingest metric / match-log events. Headshots also count as kills only if the caller says so:
  *  a `headshot` event increments headshots alone, a `kill` increments kills alone — callers that
  *  derive both from one death send both, which is what server/index.ts does for GSI kills. */
 async record(tournamentId:string,events:Array<{kind:MetricKind;count?:number;map?:string;detail?:string}>):Promise<PlatformResult<MetricTotals>>{
  const t=this.get(tournamentId); if(!t) return fail(404,'not-found','Unknown tournament.');
  for(const e of events){
   if(!METRIC_KINDS.includes(e?.kind)) continue;
   const count=Math.min(1000,Math.max(1,Math.floor(Number(e.count)||1)));
   const key=e.kind==='kill'?'kills':e.kind==='headshot'?'headshots':e.kind==='grenade'?'grenades':e.kind==='round'?'rounds':e.kind==='map'?'maps':'matches';
   t.totals[key]+=count;
   const entry:MetricLogEntry={at:this.now(),kind:e.kind,count,map:e.map?.slice(0,40),detail:e.detail?.slice(0,160),accountId:t.accountId,tournamentId:t.id};
   t.logs.push(entry); if(t.logs.length>LOG_CAP) t.logs.splice(0,t.logs.length-LOG_CAP);
   this.data.globalLogs.push(entry); if(this.data.globalLogs.length>GLOBAL_LOG_CAP) this.data.globalLogs.splice(0,this.data.globalLogs.length-GLOBAL_LOG_CAP);
  }
  t.updatedAt=this.now(); await this.save(); return {ok:true,value:t.totals};
 }
 /** Owner's cross-user view: one row per account that owns tournaments, plus every tournament. */
 adminSummary(accounts:Array<{id:string;email:string;status:string}>){
  const byAccount=new Map<string,{accountId:string;email:string;status:string;tournaments:number;totals:MetricTotals;lastActiveAt:number|null}>();
  for(const a of accounts) byAccount.set(a.id,{accountId:a.id,email:a.email,status:a.status,tournaments:0,totals:emptyTotals(),lastActiveAt:null});
  for(const t of this.data.tournaments){
   let row=byAccount.get(t.accountId);
   if(!row){row={accountId:t.accountId,email:t.ownerEmail,status:'approved',tournaments:0,totals:emptyTotals(),lastActiveAt:null};byAccount.set(t.accountId,row)}
   row.tournaments++; const g=globalTotals([t]); (Object.keys(g) as (keyof MetricTotals)[]).forEach(k=>row!.totals[k]+=g[k]);
   row.lastActiveAt=Math.max(row.lastActiveAt||0,t.lastActiveAt||t.updatedAt)||null;
  }
  return {settings:this.settings,activeTournamentId:this.data.activeTournamentId,
   totals:globalTotals(this.data.tournaments),tournaments:this.data.tournaments.map(tournamentView),
   users:[...byAccount.values()].sort((a,b)=>(b.lastActiveAt||0)-(a.lastActiveAt||0)),
   recentLogs:[...this.data.globalLogs].reverse().slice(0,100)};
 }
}
