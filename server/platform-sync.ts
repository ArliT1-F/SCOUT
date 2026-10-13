import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {BetaResult,Installation,LauncherBetaService} from './beta.js';
import {normalizeConfig,type ScoutConfig} from './config.js';
import {emptyLayout} from './layout.js';
import {overlaySchema} from './overlay.js';
import {emptyRadars} from './radars.js';
import {createEventPack,eventPackSchema,restoreEventPack,type EventPack} from './packs.js';
import {GRACE_MS} from './licensing.js';
import {configHash,DEFAULT_PLATFORM_SETTINGS,METRIC_KINDS,PlatformStore,type ConfigReceipt,type MetricEvent,type MetricKind,type PlatformSettings} from './platform.js';

export const SYNC_INTERVAL_MS=15_000;
const SKEW_RETRY_MS=5*60_000;
const neutralOverlay=()=>overlaySchema.parse({widgets:[]});
/** Reuse the trusted pack transport, but never export per-venue calibration or overlay design. */
export const createMatchPack=(config:ScoutConfig,uploadRoot:string)=>createEventPack(config,emptyRadars(),emptyLayout(),neutralOverlay(),uploadRoot);
export interface SyncTournament {id:string;name:string;configHash:string;configVersion:number;updatedAt:number;pack?:EventPack}
export interface SyncReply {status:'active'|'revoked'|'unsupported';settings?:PlatformSettings;tournament?:SyncTournament|null}
export interface MetricsReply {status:'active'|'revoked'|'unsupported';acknowledged?:string[];conflicts?:string[];rejected?:string[];configs?:ConfigReceipt[]}
const credentialsSchema=z.object({deviceId:z.string().min(1).max(100),installationId:z.string().min(1).max(100),token:z.string().min(1).max(200)}).strip();
const syncRequestSchema=credentialsSchema.extend({
 knownConfigHash:z.string().max(64).optional().default(''),knownConfigVersion:z.number().int().nonnegative().optional().default(0),
 knownTournamentId:z.string().max(100).nullable().optional(),knownSettingsVersion:z.number().int().nonnegative().optional().default(0),appVersion:z.string().max(100).optional().default(''),
});
const eventBase={id:z.string().min(1).max(150),tournamentId:z.string().min(1).max(100)};
const metricSchema=z.object({...eventBase,kind:z.enum(METRIC_KINDS as [MetricKind,...MetricKind[]]),count:z.number().int().min(1).max(1000).optional(),map:z.string().max(64).optional(),detail:z.string().max(160).optional(),at:z.number().int().nonnegative().optional()}).strip();
const pushSchema=z.object({...eventBase,kind:z.literal('config-push'),pack:eventPackSchema,localHash:z.string().length(64),baseConfigVersion:z.number().int().nonnegative().optional().default(0),baseConfigHash:z.string().max(64).optional().default(''),baseEventId:z.string().max(150).optional()}).strip();
export type MetricOutboxEvent=z.infer<typeof metricSchema>;
export type ConfigOutboxEvent=z.infer<typeof pushSchema>;
export type OutboxEvent=MetricOutboxEvent|ConfigOutboxEvent;
const invalid=(message:string):BetaResult<never>=>({ok:false,status:400,code:'invalid-sync',message});

/** Central-host half. Every request resolves ownership from the installation token, not its body. */
export class PlatformDeviceService {
 private ingestion:Promise<unknown>=Promise.resolve();
 constructor(private readonly platform:PlatformStore,private readonly identity:Pick<LauncherBetaService,'installationStatus'>,private readonly uploadRoot:string,private readonly readSettings:()=>Promise<void>=async()=>{}){}
 private async authenticate(input:z.infer<typeof credentialsSchema>){
  // Never forward the sync body (especially event packs/metrics) to the account service.
  const result=await this.identity.installationStatus({deviceId:input.deviceId,installationId:input.installationId,token:input.token},{includeAccountId:true});
  if(!result.ok){
   if(result.code==='bad-service-key'||result.code==='service-key-required')return {ok:false as const,status:503,code:'identity-unavailable',message:'The central host cannot authenticate with its account service.'};
   return result;
  }
  if(result.value.status!=='active')return {ok:true as const,value:{status:'revoked' as const}};
  // Old account services do not resolve identity. No guessing by email and no error/retry storm.
  if(!result.value.accountId)return {ok:true as const,value:{status:'unsupported' as const}};
  return {ok:true as const,value:{status:'active' as const,accountId:result.value.accountId}};
 }
 async sync(raw:unknown):Promise<BetaResult<SyncReply>>{
  const parsed=syncRequestSchema.safeParse(raw);if(!parsed.success)return invalid('Send this installation’s device ID, installation ID and token.');
  const input=parsed.data,auth=await this.authenticate(input);
  if(!auth.ok||auth.value.status!=='active')return auth;
  await this.readSettings();
  const reply:SyncReply={status:'active'};
  if(input.knownSettingsVersion!==this.platform.settings.version)reply.settings=this.platform.settings;
  const t=this.platform.activeFor(auth.value.accountId);
  if(!t||!t.config||!t.configHash)reply.tournament=null;
  else{
   const differentTournament=input.knownTournamentId!==undefined&&input.knownTournamentId!==t.id;
   if(differentTournament||input.knownConfigHash!==t.configHash||input.knownConfigVersion!==t.configVersion){
    // Capture one config revision before asynchronous artwork reads.
    reply.tournament={id:t.id,name:t.name,configHash:t.configHash,configVersion:t.configVersion,updatedAt:t.updatedAt};
    if(differentTournament||input.knownConfigHash!==t.configHash)reply.tournament.pack=await createMatchPack(normalizeConfig(t.config),this.uploadRoot);
   }
  }
  // Artwork may take time to read. Revocation during that work must not release a config.
  const confirmed=await this.authenticate(input);
  if(!confirmed.ok||confirmed.value.status!=='active')return confirmed;
  if(confirmed.value.accountId!==auth.value.accountId)return {ok:true,value:{status:'revoked'}};
  return {ok:true,value:reply};
 }
 metrics(raw:unknown):Promise<BetaResult<MetricsReply>>{
  const result=this.ingestion.then(()=>this.ingest(raw));this.ingestion=result.catch(()=>{});return result;
 }
 private async ingest(raw:unknown):Promise<BetaResult<MetricsReply>>{
  const parsed=credentialsSchema.extend({events:z.array(z.unknown()).max(100).optional().default([])}).safeParse(raw);
  if(!parsed.success)return invalid('Send authenticated batches of at most 100 events.');
  const input=parsed.data,auth=await this.authenticate(input);
  if(!auth.ok||auth.value.status!=='active')return auth;
  const acknowledged:string[]=[],conflicts:string[]=[],rejected:string[]=[],configs:ConfigReceipt[]=[];
  const events:OutboxEvent[]=[];
  for(const rawEvent of input.events){
   const e:any=rawEvent;
   if(!e||typeof e.id!=='string'||!e.id.startsWith(input.deviceId+':')||!/^[1-9]\d*$/.test(e.id.slice(input.deviceId.length+1))||!Number.isSafeInteger(Number(e.id.slice(input.deviceId.length+1))))return invalid('Event IDs must be this device ID plus a monotonic sequence.');
   // Future event kinds are acknowledged but not interpreted by an older host.
   if(e.kind!=='config-push'&&!METRIC_KINDS.includes(e.kind)){acknowledged.push(e.id);continue}
   const checked=(e.kind==='config-push'?pushSchema:metricSchema).safeParse(e);
   if(!checked.success)return invalid('An outbox event or its artwork is invalid.');
   events.push(checked.data);
  }
  for(let i=0;i<events.length;){
   const e=events[i++];
   if(!this.platform.ownedBy(e.tournamentId,auth.value.accountId)){acknowledged.push(e.id);rejected.push(e.id);continue}
   if(e.kind!=='config-push'){
    const batch:MetricOutboxEvent[]=[e];
    while(i<events.length&&events[i].kind!=='config-push'&&events[i].tournamentId===e.tournamentId)batch.push(events[i++] as MetricOutboxEvent);
    await this.platform.record(e.tournamentId,batch);acknowledged.push(...batch.map(item=>item.id));continue;
   }
   let result;
   if(this.platform.hasEvent(e.id)){
    const receipt=this.platform.data.configReceipts[e.id];
    if(receipt)configs.push(receipt);else conflicts.push(e.id);
   }else{
    if(configHash(e.pack.config)!==e.localHash)return invalid('The config-push hash does not match its pack.');
    const predecessor=e.baseEventId?.startsWith(input.deviceId+':')?this.platform.data.configReceipts[e.baseEventId]:undefined;
    const base=predecessor?.tournamentId===e.tournamentId?{version:predecessor.configVersion,hash:predecessor.configHash}:{version:e.baseConfigVersion,hash:e.baseConfigHash};
    const target=this.platform.ownedBy(e.tournamentId,auth.value.accountId)!;
    if(target.configVersion!==base.version||target.configHash!==base.hash){conflicts.push(e.id);acknowledged.push(e.id);continue}
    const restored=await restoreEventPack(e.pack,this.uploadRoot);
    const confirmed=await this.authenticate(input);
    if(!confirmed.ok||confirmed.value.status!=='active')return confirmed;
    if(confirmed.value.accountId!==auth.value.accountId)return {ok:true,value:{status:'revoked'}};
    // Recheck after I/O as well; a browser may have saved while the artwork was being restored.
    result=await this.platform.pushConfig(e.tournamentId,auth.value.accountId,restored.config,e.id,e.localHash,base);
    if(result.ok)configs.push(result.value);else if(result.code==='config-conflict')conflicts.push(e.id);else rejected.push(e.id);
   }
   acknowledged.push(e.id);
  }
  // Also durably flush deduplicated retries before acknowledging them after a prior disk error.
  if(events.length)await this.platform.save();
  return {ok:true,value:{status:'active',acknowledged,conflicts,rejected,configs}};
 }
}

interface OutboxData {version:1;sequences:Record<string,number>;events:OutboxEvent[]}
/** Serialized atomic writes protect both the queue and its never-reset sequence from GSI bursts. */
export class SyncOutbox {
 private data:OutboxData={version:1,sequences:Object.create(null),events:[]};
 private writes:Promise<unknown>=Promise.resolve();
 constructor(private readonly file:string,private readonly cap=10_000,private readonly byteCap=100*1024*1024,private readonly warn:(message:string)=>void=console.warn){}
 async load(){
  try{
   const p=JSON.parse(await readFile(this.file,'utf8'));
   if(!p||!Array.isArray(p.events)||!p.sequences||typeof p.sequences!=='object'||Array.isArray(p.sequences))throw Error('Invalid outbox');
   for(const n of Object.values(p.sequences))if(!Number.isSafeInteger(n)||Number(n)<0)throw Error('Invalid outbox sequence ledger');
   const ids=new Set<string>();
   for(const e of p.events){
    const match=typeof e?.id==='string'?/^(.+):([1-9]\d*)$/.exec(e.id):null;
    if(!match||!Number.isSafeInteger(Number(match[2]))||!Object.hasOwn(p.sequences,match[1])||p.sequences[match[1]]<Number(match[2])||ids.has(e.id)||typeof e.kind!=='string'||typeof e.tournamentId!=='string')throw Error('Invalid outbox event/sequence');
    ids.add(e.id);
   }
   this.data={version:1,sequences:Object.assign(Object.create(null),p.sequences),events:p.events};
  }
  catch(e:any){if(e?.code!=='ENOENT')throw e} // Never reset an unreadable sequence ledger and reuse IDs.
  return this;
 }
 private mutate<T>(fn:(data:OutboxData)=>T):Promise<T>{
  const result=this.writes.then(async()=>{
   // Expose only committed events to the flusher. A failed write must not send an ID whose
   // counter was never persisted (and might be reused after a restart).
   const data:OutboxData={version:1,sequences:Object.assign(Object.create(null),this.data.sequences),events:[...this.data.events]};
   const value=fn(data);let dropped=0,bytes=Buffer.byteLength(JSON.stringify(data));
   while(data.events.length>this.cap||bytes>this.byteCap){const e=data.events.shift();if(!e)break;bytes-=Buffer.byteLength(JSON.stringify(e))+1;dropped++}
   await mkdir(path.dirname(this.file),{recursive:true});await writeFile(this.file+'.tmp',JSON.stringify(data),{mode:0o600});await rename(this.file+'.tmp',this.file);
   this.data=data;if(dropped)this.warn(`[platform-sync] outbox cap reached — dropped ${dropped} oldest event(s).`);return value;
  });
  this.writes=result.catch(()=>{});return result;
 }
 private id(deviceId:string,data:OutboxData){const n=(data.sequences[deviceId]??0)+1;if(!Number.isSafeInteger(n))throw Error('Device sequence exhausted');data.sequences[deviceId]=n;return `${deviceId}:${n}`}
 appendMetrics(deviceId:string,tournamentId:string,events:MetricEvent[]){return this.mutate(data=>{
  const added=events.map(e=>({...e,id:this.id(deviceId,data),tournamentId}));data.events.push(...added);return added;
 })}
 appendConfig(deviceId:string,tournamentId:string,pack:EventPack,base:{version:number;hash:string}){return this.mutate(data=>{
  const previous=[...data.events].reverse().find(e=>e.kind==='config-push'&&e.tournamentId===tournamentId&&e.id.startsWith(deviceId+':'));
  const e:ConfigOutboxEvent={id:this.id(deviceId,data),tournamentId,kind:'config-push',pack,localHash:configHash(pack.config),baseConfigVersion:base.version,baseConfigHash:base.hash,...(previous?{baseEventId:previous.id}:{})};
  data.events.push(e);return e;
 })}
 acknowledge(ids:string[]){const set=new Set(ids);return this.mutate(data=>{data.events=data.events.filter(e=>!set.has(e.id))})}
 async settled(){await this.writes}
 batch(deviceId:string){
  const batch:OutboxEvent[]=[];
  for(const e of this.data.events){if(!e.id.startsWith(deviceId+':'))continue;batch.push(e);if(batch.length===100||e.kind==='config-push')break}
  return batch;
 }
 configIds(deviceId:string,tournamentId:string){return this.data.events.filter(e=>e.kind==='config-push'&&e.tournamentId===tournamentId&&e.id.startsWith(deviceId+':')).map(e=>e.id)}
 count(deviceId?:string){return this.data.events.filter(e=>!deviceId||e.id.startsWith(deviceId+':')).length}
}

export type SyncState='synced'|'update-available'|'revoked'|'offline-grace'|'offline'|'unlinked'|'unsupported';
export interface PlatformSyncView {
 enabled:true;state:SyncState;lastGoodAt:number|null;graceExpiresAt:number|null;outboxCount:number;
 tournament:{id:string;name:string;configVersion:number}|null;update:{id:string;name:string;configVersion:number}|null;message:string;
}
interface AgentState {deviceId:string|null;platformUrl:string;tournamentId:string|null;name:string;remoteHash:string;remoteVersion:number;settingsVersion:number;localHash:string;lastGoodAt:number|null;revoked:boolean}
export interface PlatformSyncOptions {
 url:string;installation:Installation;platform:PlatformStore;outbox:SyncOutbox;file:string;uploadRoot:string;
 readConfig:()=>ScoutConfig;
 // The host rechecks expectedHash under the same lock used by panel saves/imports/activation.
 writeConfig:(config:ScoutConfig,tournament:SyncTournament,expectedHash:string,deviceId:string)=>Promise<boolean>;
 changed?:()=>void;fetchImpl?:typeof fetch;now?:()=>number;appVersion?:string;
}
export class PlatformSyncAgent {
 private state:AgentState;
 private pending:SyncTournament|null=null;
 private network:'active'|'offline'|'unsupported'='offline';
 private retryAt=0;
 private operations:Promise<unknown>=Promise.resolve();
 private polling:Promise<void>|null=null;
 private readonly now:()=>number;
 constructor(private readonly options:PlatformSyncOptions){
  this.now=options.now??Date.now;
  this.state={deviceId:null,platformUrl:options.url,tournamentId:null,name:'',remoteHash:'',remoteVersion:0,settingsVersion:0,localHash:'',lastGoodAt:null,revoked:false};
 }
 async load(){
  try{const p=JSON.parse(await readFile(this.options.file,'utf8'));if(p.platformUrl===this.options.url)this.state={...this.state,...p}}
  catch(e:any){if(e?.code!=='ENOENT')console.warn('[platform-sync] sync state unreadable:',e.message)}return this;
 }
 start(){const timer=setInterval(()=>void this.tick(),SYNC_INTERVAL_MS);timer.unref();void this.tick();return ()=>clearInterval(timer)}
 tick(){
  if(this.polling)return this.polling;
  const run=this.operations.then(()=>this.run(false));this.operations=run.catch(()=>{});this.polling=run;
  return run.finally(()=>{this.polling=null});
 }
 async applyUpdate(){const run=this.operations.then(()=>this.run(true));this.operations=run.catch(()=>{});await run;return this.view()}
 private async persist(){await mkdir(path.dirname(this.options.file),{recursive:true});await writeFile(this.options.file+'.tmp',JSON.stringify(this.state),{mode:0o600});await rename(this.options.file+'.tmp',this.options.file)}
 private credentials(){const c=this.options.installation.credentials();return c.deviceId&&c.token?{...c,deviceId:c.deviceId,token:c.token}:null}
 private stillLinked(deviceId:string){return this.credentials()?.deviceId===deviceId}
 private async request(route:string,body:unknown):Promise<any>{
  const r=await (this.options.fetchImpl??fetch)(this.options.url.replace(/\/$/,'')+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000),redirect:'error'});
  if([400,404,405,409,413].includes(r.status)){this.network='unsupported';this.retryAt=this.now()+SKEW_RETRY_MS;return null}
  if(r.status===401||r.status===403){this.state.revoked=true;this.pending=null;return null}
  if(!r.ok)throw Error(`Platform answered ${r.status}`);
  const reply=await r.json() as SyncReply|MetricsReply|null;
  if(reply?.status==='revoked'){this.state.revoked=true;this.pending=null;return null}
  if(reply?.status!=='active'){this.network='unsupported';this.retryAt=this.now()+SKEW_RETRY_MS;return null}
  return reply;
 }
 private async receive(t:SyncTournament,deviceId:string,force:boolean,conflict=false){
  if(!t||typeof t.id!=='string'||typeof t.configHash!=='string')return; // missing/future fields degrade to no sync
  t={...t,name:typeof t.name==='string'?t.name:'Tournament',configVersion:t.configVersion??1,updatedAt:t.updatedAt??0};
  const local=configHash(this.options.readConfig());
  if(!force&&t.id===this.state.tournamentId&&t.configVersion<this.state.remoteVersion)return;
  if(!force&&(conflict||(this.state.localHash&&local!==this.state.localHash&&(t.id!==this.state.tournamentId||t.configVersion>this.state.remoteVersion||t.configHash!==this.state.remoteHash)))){this.pending=t;return}
  if(t.id===this.state.tournamentId&&t.configHash===this.state.remoteHash&&(!force||local===this.state.localHash)){
   this.state.remoteVersion=t.configVersion;this.state.name=t.name;this.pending=null;
   if(force){const ids=this.options.outbox.configIds(deviceId,t.id);if(ids.length)await this.options.outbox.acknowledge(ids)}
   return; // Even an explicit refresh of an already clean config is a file/broadcast no-op.
  }
  if(!t.pack)return;
  const checked=eventPackSchema.safeParse(t.pack);
  if(!checked.success){this.network='unsupported';this.retryAt=this.now()+SKEW_RETRY_MS;this.pending=null;return}
  const pack=checked.data;
  if(configHash(pack.config)!==t.configHash){
   // Different config schema defaults across versions cannot safely round-trip. Keep the local
   // broadcast and back off, rather than endlessly fetching/overwriting an incompatible pack.
   this.network='unsupported';this.retryAt=this.now()+SKEW_RETRY_MS;this.pending=null;return;
  }
  const restored=await restoreEventPack(pack,this.options.uploadRoot);
  if(!this.stillLinked(deviceId)||this.state.revoked)return;
  if(!await this.options.writeConfig(restored.config,t,local,deviceId)){this.pending=t;return}
  this.state.tournamentId=t.id;this.state.name=t.name;this.state.remoteHash=t.configHash;this.state.remoteVersion=t.configVersion;this.state.localHash=configHash(restored.config);this.pending=null;if(this.state.localHash!==local)this.options.changed?.();
  if(force){const ids=this.options.outbox.configIds(deviceId,t.id);if(ids.length)await this.options.outbox.acknowledge(ids)}
 }
 private async run(force:boolean){
  const c=this.credentials();if(!c){this.pending=null;return}
  if(c.deviceId!==this.state.deviceId){this.state={deviceId:c.deviceId,platformUrl:this.options.url,tournamentId:null,name:'',remoteHash:'',remoteVersion:0,settingsVersion:0,localHash:'',lastGoodAt:null,revoked:false};this.pending=null;this.retryAt=0}
  if(!force&&this.now()<this.retryAt)return;
  try{
   const seen=force?null:this.pending;
   const reply=await this.request('/api/platform/device/sync',{...c,knownConfigHash:force?'':seen?.configHash??this.state.remoteHash,knownConfigVersion:force?0:seen?.configVersion??this.state.remoteVersion,knownTournamentId:force?null:seen?.id??this.state.tournamentId,knownSettingsVersion:this.state.settingsVersion,appVersion:this.options.appVersion??'0.1.0'});
   if(!this.stillLinked(c.deviceId))return;
   if(!reply)return;
   this.state.revoked=false;this.network='active';this.state.lastGoodAt=this.now();
   if(reply.settings&&typeof reply.settings.version==='number'){const previous=this.options.platform.settings;await this.options.platform.setSettings({...DEFAULT_PLATFORM_SETTINGS,...reply.settings});this.state.settingsVersion=reply.settings.version;if(previous!==this.options.platform.settings)this.options.changed?.()}
   if(reply.tournament)await this.receive(reply.tournament,c.deviceId,force);
   if(reply.tournament===null){this.pending=null;this.state.tournamentId=null;this.state.remoteHash='';this.state.remoteVersion=0}
   if(!this.stillLinked(c.deviceId)||this.state.revoked)return;
   await this.options.outbox.settled();
   // Bound work per wakeup. FIFO batches (one pack maximum each) also preserve config-push chains.
   for(let i=0;i<10;i++){
    const batch=this.options.outbox.batch(c.deviceId);if(!batch.length)break;
    const flushed=await this.request('/api/platform/device/metrics',{...c,events:batch});
    if(!flushed||!this.stillLinked(c.deviceId))break;
    if(!Array.isArray(flushed.acknowledged)){this.network='unsupported';this.retryAt=this.now()+SKEW_RETRY_MS;break}
    for(const receipt of flushed.configs??[]){
     const sent=batch.find(e=>e.id===receipt.id&&e.kind==='config-push') as ConfigOutboxEvent|undefined;
     if(sent&&receipt.tournamentId===this.state.tournamentId&&receipt.configVersion>=this.state.remoteVersion){
      this.state.remoteHash=receipt.configHash;this.state.remoteVersion=receipt.configVersion;this.state.localHash=sent.localHash;
      if(this.pending&&this.pending.id===receipt.tournamentId&&this.pending.configVersion<=receipt.configVersion)this.pending=null;
     }
    }
    const ids=batch.filter(e=>flushed.acknowledged.includes(e.id)).map(e=>e.id);
    if(ids.length)await this.options.outbox.acknowledge(ids);
    if(flushed.conflicts?.length){
     this.retryAt=0;
     if(!this.pending){
      const latest=await this.request('/api/platform/device/sync',{...c,knownConfigHash:'',knownConfigVersion:0,knownSettingsVersion:this.state.settingsVersion});
      if(latest?.tournament&&this.stillLinked(c.deviceId))await this.receive(latest.tournament,c.deviceId,false,true);
     }
     break; // Never rebase queued local writes onto somebody else's edit.
    }
    if(flushed.rejected?.length)console.warn(`[platform-sync] ${flushed.rejected.length} event(s) referenced a removed or unowned tournament.`);
    if(ids.length<batch.length)break;
   }
  }catch{this.network='offline'}
  finally{await this.persist().catch(e=>console.warn('[platform-sync] could not persist sync state:',e.message));}
 }
 async appendMetrics(tournamentId:string,events:MetricEvent[]):Promise<MetricEvent[]>{
  const c=this.credentials();
  return c&&c.deviceId===this.state.deviceId&&tournamentId===this.state.tournamentId?this.options.outbox.appendMetrics(c.deviceId,tournamentId,events.map(e=>({...e,count:Math.min(1000,Math.max(1,Math.floor(Number(e.count)||1))),map:e.map?.slice(0,40),detail:e.detail?.slice(0,160),at:e.at??this.now()}))):events;
 }
 async saveBack(config:ScoutConfig){
  const c=this.credentials(),t=this.options.platform.active();
  if(!c||c.deviceId!==this.state.deviceId||!t||t.id!==this.state.tournamentId)return;
  const pack=await createMatchPack(config,this.options.uploadRoot);
  await this.options.outbox.appendConfig(c.deviceId,t.id,pack,{version:this.state.remoteVersion,hash:this.state.remoteHash});
 }
 view():PlatformSyncView{
  const c=this.credentials(),good=this.state.lastGoodAt,expires=good===null?null:good+GRACE_MS;
  const state:SyncState=!c?'unlinked':this.state.revoked?'revoked':this.network==='unsupported'?'unsupported':this.network==='offline'?(expires!==null&&this.now()<=expires?'offline-grace':'offline'):this.pending?'update-available':'synced';
  const message=state==='revoked'?'This device or account was revoked. Platform updates are paused; the broadcast is unchanged.':state==='update-available'?'A newer version exists on the platform. Local edits were kept; apply it explicitly when ready.':state==='offline-grace'?'Platform unreachable. Using the last-known config within its 7-day grace; metrics are queued.':state==='offline'?'Platform unreachable; the broadcast still uses your local config.':state==='unsupported'?'This platform or account service does not support launcher sync yet. Local operation is unchanged.':state==='unlinked'?'Link this installation to enable platform sync.':'Synced with the platform. Radar, layout and overlay remain local.';
  return {enabled:true,state,lastGoodAt:good,graceExpiresAt:expires,outboxCount:this.options.outbox.count(c?.deviceId),tournament:this.state.tournamentId?{id:this.state.tournamentId,name:this.state.name,configVersion:this.state.remoteVersion}:null,update:this.pending?{id:this.pending.id,name:this.pending.name,configVersion:this.pending.configVersion}:null,message};
 }
}
