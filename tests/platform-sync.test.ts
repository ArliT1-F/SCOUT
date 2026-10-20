import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {Installation,LocalBetaService,HostedBetaService,type BetaResult,type LauncherBetaService} from '../server/beta.js';
import {normalizeConfig,type ScoutConfig} from '../server/config.js';
import {GRACE_MS} from '../server/licensing.js';
import {configHash,PlatformStore,type Tournament} from '../server/platform.js';
import {PlatformDeviceService,PlatformSyncAgent,SyncOutbox,createMatchPack} from '../server/platform-sync.js';
import {LauncherSyncStatus} from '../src/operator-tools.js';
import {createAccountService} from '../server/account-service.js';
import {platformHost,hostConfig} from './helpers/platform-host.js';

const config=(name='Cup'):ScoutConfig=>normalizeConfig({event:{name},teams:[{id:'a',name:'Alpha'},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage'}]});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=','base64');
function value<T>(r:BetaResult<T>):T{assert.equal(r.ok,true,JSON.stringify(r));return r.value}
async function harness(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=await mkdtemp(path.join(tmpdir(),'scout-sync-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=1_000_000;
 const now=()=>clock;
 const beta=await new LocalBetaService({dir:path.join(root,'accounts'),autoApprove:true,now}).load();
 const context={address:'127.0.0.1',userAgent:'test',origin:'http://platform.test',secure:false};
 const account=value(await beta.apply({name:'Ada Operator',email:'ada@example.com',organisation:'LAN',country:'AL',useCase:'Cups',events:'weekly'},context));
 const signed=value(await beta.activate({invite:account.invite!,password:'long-enough-password'},context));
 const grant=value(await beta.deviceStart({label:'Venue',platform:'windows'},context));
 value(await beta.deviceDecide(signed.cookieId,grant.userCode,true));
 const poll=value(await beta.devicePoll({deviceCode:grant.deviceCode}));
 const installation=await new Installation(path.join(root,'local','installation.json'),now).load();assert.ok(installation.completeLink(poll));await installation.save();
 const credentials={deviceId:poll.deviceId!,installationId:installation.view().installationId,token:poll.installationToken!};
 const centralFile=path.join(root,'central','store.json');
 let central=await new PlatformStore(centralFile,now).load();
 const tournament=value(await central.create(account.account.id,'ada@example.com','Ada Cup',config()));await central.activate(tournament.id,account.account.id);
 const centralUploads=path.join(root,'central','uploads'),localUploads=path.join(root,'local','uploads');
 let service=new PlatformDeviceService(central,beta,centralUploads);
 let reachable=true,loseAck=false,calls=0,writes=0;
 const fetchImpl:typeof fetch=async(url,init)=>{
  calls++;if(!reachable)throw Error('venue internet offline');
  const route=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));
  const result=route==='sync'?await service.sync(body):await service.metrics(body);
  if(route==='metrics'&&loseAck){loseAck=false;throw Error('response lost after commit')}
  return new Response(JSON.stringify(result.ok?result.value:{error:result.message,code:result.code}),{status:result.ok?200:result.status,headers:{'Content-Type':'application/json'}});
 };
 const local=await new PlatformStore(path.join(root,'local','store.json'),now).load();
 let live=config('Local default');
 const stateFile=path.join(root,'local','sync.json'),outboxFile=path.join(root,'local','outbox.json');
 let outbox=await new SyncOutbox(outboxFile).load();
 let beforeWrite:()=>void=()=>{};
 const makeAgent=async()=>new PlatformSyncAgent({url:'http://platform.test',installation,platform:local,outbox,file:stateFile,uploadRoot:localUploads,now,fetchImpl,readConfig:()=>live,
  writeConfig:async(next,remote,expectedHash)=>{beforeWrite();if(configHash(live)!==expectedHash)return false;live=next;writes++;await local.adopt(remote,credentials.deviceId,'ada@example.com',next);return true},
 }).load();
 let agent=await makeAgent();
 return {root,beta,account,signed,credentials,installation,tournament,local,centralUploads,localUploads,outboxFile,stateFile,
  get central(){return central},get service(){return service},get agent(){return agent},get outbox(){return outbox},get live(){return live},set live(next:ScoutConfig){live=next},
  get writes(){return writes},get calls(){return calls},get now(){return clock},advance:(ms:number)=>{clock+=ms},offline:()=>{reachable=false},online:()=>{reachable=true},loseAck:()=>{loseAck=true},
  beforeWrite:(fn:()=>void)=>{beforeWrite=fn},
  reload:async()=>{central=await new PlatformStore(centralFile,now).load();service=new PlatformDeviceService(central,beta,centralUploads);outbox=await new SyncOutbox(outboxFile).load();agent=await makeAgent()},
 };
}

test('device sync resolves the linked account, ignores unknown input, and sends only changed versions',async(t)=>{
 const h=await harness(t);
 const other=value(await h.central.create('other','other@example.com','Other cup',config('Other')));await h.central.activate(other.id,'other');
 const first=value(await h.service.sync({...h.credentials,accountId:'other',futureFlag:true}));
 assert.equal(first.tournament?.id,h.tournament.id,'account selection is not the shared live workspace or the request’s claimed account');
 assert.ok(first.tournament?.pack);assert.equal(first.tournament.configHash,configHash(first.tournament.pack.config));
 assert.equal(JSON.stringify(first).includes('accountId'),false,'internal device identity never rides the sync/browser view');
 const known={...h.credentials,knownTournamentId:h.tournament.id,knownConfigHash:first.tournament.configHash,knownConfigVersion:first.tournament.configVersion,knownSettingsVersion:first.settings!.version};
 assert.deepEqual(value(await h.service.sync(known)),{status:'active'});
 await h.central.updateSettings({reviewNote:'Next wave'},'owner@example.com');
 const settingsOnly=value(await h.service.sync(known));assert.equal(settingsOnly.settings?.reviewNote,'Next wave');assert.equal(settingsOnly.tournament,undefined);
});

test('a matching hash is a no-op, including asset remapping and metadata-only version bumps',async(t)=>{
 const h=await harness(t);const cfg=config();cfg.teams[0].logo='uploads/logos/alpha.png';
 await mkdir(path.join(h.centralUploads,'logos'),{recursive:true});await writeFile(path.join(h.centralUploads,'logos','alpha.png'),png);
 value(await h.central.update(h.tournament.id,h.account.account.id,{config:cfg}));
 await h.agent.tick();assert.equal(h.writes,1);assert.notEqual(configHash(h.live),h.tournament.configHash,'pack restore rewrites artwork paths');
 assert.deepEqual(await readFile(path.join(h.localUploads,...h.live.teams[0].logo.split('/').slice(1))),png);
 const restored=JSON.stringify(h.live);await h.agent.tick();assert.equal(h.writes,1);assert.equal(JSON.stringify(h.live),restored);
 await h.agent.applyUpdate();assert.equal(h.writes,1,'even an explicit refresh of a clean hash is a no-op');assert.equal(JSON.stringify(h.live),restored);
 value(await h.central.update(h.tournament.id,h.account.account.id,{config:cfg}));
 await h.agent.tick();assert.equal(h.writes,1,'saving identical normalized config only changes metadata');assert.equal(h.agent.view().tournament?.configVersion,3);
 const changed=config('Final');value(await h.central.update(h.tournament.id,h.account.account.id,{config:changed}));await h.agent.tick();assert.equal(h.writes,2);assert.equal(h.live.event.name,'Final');
});

test('local edits surface an update instead of being overwritten, and applying is an explicit fresh check',async(t)=>{
 const h=await harness(t);await h.agent.tick();h.live=config('Venue roster');
 value(await h.central.update(h.tournament.id,h.account.account.id,{config:config('Platform roster')}));
 await h.agent.tick();assert.equal(h.live.event.name,'Venue roster');assert.equal(h.writes,1);assert.equal(h.agent.view().state,'update-available');
 await h.agent.tick();assert.equal(h.writes,1,'an unchanged pending update is not restored each poll');
 const html=renderToString(createElement(LauncherSyncStatus,{sync:h.agent.view(),busy:false,onApply:()=>{}}));assert.match(html,/UPDATE AVAILABLE/);assert.match(html,/Apply platform config/);
 await h.agent.applyUpdate();assert.equal(h.live.event.name,'Platform roster');assert.equal(h.agent.view().state,'synced');assert.equal(h.writes,2);
});

test('a save during artwork restoration is rechecked under the commit lock, even on first sync',async(t)=>{
 const h=await harness(t);h.beforeWrite(()=>{h.live=config('Just saved by producer')});
 await h.agent.tick();assert.equal(h.writes,0);assert.equal(h.live.event.name,'Just saved by producer');assert.equal(h.agent.view().state,'update-available');
});

test('revocation mid-sync returns only revoked, and revoked pending updates cannot be applied',async(t)=>{
 const h=await harness(t);let checks=0;
 const identity:Pick<LauncherBetaService,'installationStatus'>={installationStatus:async(input,options)=>{assert.deepEqual(Object.keys(input).sort(),['deviceId','installationId','token']);checks++;if(checks===2)value(await h.beta.revokeDevice(h.signed.cookieId,h.credentials.deviceId));return h.beta.installationStatus(input,options)}};
 const guarded=new PlatformDeviceService(h.central,identity,h.centralUploads);
 assert.deepEqual(value(await guarded.sync(h.credentials)),{status:'revoked'});
 const h2=await harness(t);await h2.agent.tick();h2.live=config('Keep this live');
 value(await h2.central.update(h2.tournament.id,h2.account.account.id,{config:config('Newer')}));await h2.agent.tick();assert.equal(h2.agent.view().state,'update-available');
 value(await h2.beta.revokeDevice(h2.signed.cookieId,h2.credentials.deviceId));await h2.agent.applyUpdate();
 assert.equal(h2.agent.view().state,'revoked');assert.equal(h2.live.event.name,'Keep this live');assert.equal(h2.writes,1);
 h2.offline();await h2.agent.tick();assert.equal(h2.agent.view().state,'revoked','a later outage cannot turn a known revocation into offline grace');
});

test('de-approving an account stops both config delivery and metric ingestion without changing local output',async(t)=>{
 const h=await harness(t);await h.agent.tick();const before=JSON.stringify(h.live);
 await h.agent.appendMetrics(h.tournament.id,[{kind:'kill'}]);value(await h.beta.decide(h.account.account.id,'reject','owner'));
 await h.agent.tick();assert.equal(h.agent.view().state,'revoked');assert.equal(JSON.stringify(h.live),before);assert.equal(h.central.get(h.tournament.id)?.totals.kills,0);assert.equal(h.outbox.count(),1);
});

test('an outage, lost acknowledgement and process restart replay an outbox with exactly-once counting',async(t)=>{
 const h=await harness(t);await h.agent.tick();
 const derived=await h.agent.appendMetrics(h.tournament.id,[{kind:'kill',detail:'Alpha > Bravo'+'.'.repeat(200),map:'de_'+'.'.repeat(100)},{kind:'headshot'},{kind:'grenade'}]);
 assert.equal(derived[0].detail?.length,160);assert.equal(derived[0].map?.length,40,'valid but long GSI strings must not poison a metrics batch');
 value(await h.local.record(h.tournament.id,derived));h.offline();h.advance(15_000);await h.agent.tick();
 assert.equal(h.agent.view().state,'offline-grace');assert.equal(h.agent.view().graceExpiresAt,h.now-15_000+GRACE_MS);assert.equal(h.outbox.count(),3);
 await h.reload();assert.equal(h.outbox.count(),3);h.online();h.loseAck();await h.agent.tick();
 assert.equal(h.central.get(h.tournament.id)?.totals.kills,1);assert.equal(h.outbox.count(),3,'lost ACK must retain the durable batch');
 await h.reload();await h.agent.tick();assert.equal(h.outbox.count(),0);assert.equal(h.central.get(h.tournament.id)?.totals.kills,1);assert.equal(h.central.get(h.tournament.id)?.totals.headshots,1);assert.equal(h.central.adminSummary([]).totals.grenades,1);
 const next=await h.agent.appendMetrics(h.tournament.id,[{kind:'kill'}]);assert.equal(next[0].id,h.credentials.deviceId+':4');
 await h.agent.tick();assert.equal(h.central.adminSummary([]).totals.kills,2);
 h.offline();h.advance(GRACE_MS+1);await h.agent.tick();assert.equal(h.agent.view().state,'offline');assert.ok(h.live,'expired grace never deletes or gates the live config');
});

test('outboxes are capped, warn about oldest drops, and never reset the sequence on ACK or reload',async(t)=>{
 const root=await mkdtemp(path.join(tmpdir(),'scout-outbox-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'outbox.json');const warnings:string[]=[];
 const outbox=await new SyncOutbox(file,3,100_000,line=>warnings.push(line)).load();
 await outbox.appendMetrics('device','cup',Array.from({length:5},()=>({kind:'kill' as const})));
 assert.deepEqual(outbox.batch('device').map(e=>e.id),['device:3','device:4','device:5']);assert.match(warnings[0],/dropped 2 oldest/);
 await outbox.acknowledge(outbox.batch('device').map(e=>e.id));const again=await new SyncOutbox(file).load();assert.equal((await again.appendMetrics('device','cup',[{kind:'kill'}]))[0].id,'device:6');
 if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
 const byteFile=path.join(root,'bytes.json');const byteOutbox=await new SyncOutbox(byteFile,100,300,line=>warnings.push(line)).load();await byteOutbox.appendMetrics('device','cup',Array.from({length:3},()=>({kind:'kill' as const,detail:'x'.repeat(160)})));assert.ok((await readFile(byteFile)).length<=300);assert.equal(byteOutbox.count(),1,'serialized bytes are capped as well as event count');
 await writeFile(file,'corrupt');await assert.rejects(()=>new SyncOutbox(file).load(),'a corrupt ledger must not silently reuse device:1');
});

test('config saves push portable match artwork, chain offline saves, and retries bump versions once',async(t)=>{
 const h=await harness(t);await h.agent.tick();
 const first=config('Local edit 1');first.teams[0].logo='uploads/logos/venue.png';await mkdir(path.join(h.localUploads,'logos'),{recursive:true});await writeFile(path.join(h.localUploads,'logos','venue.png'),png);
 h.live=first;await h.local.saveActiveConfig(first);await h.agent.saveBack(first);
 const second=structuredClone(first);second.event.name='Local edit 2';h.live=second;await h.local.saveActiveConfig(second);await h.agent.saveBack(second);
 const pushes=h.outbox.batch(h.credentials.deviceId);const pack=(pushes[0] as any).pack;assert.deepEqual(pack.radars.maps,{});assert.deepEqual(pack.layout.elements,{});assert.deepEqual(pack.overlay.widgets,[]);
 h.loseAck();await h.agent.tick();assert.equal(h.central.get(h.tournament.id)?.configVersion,2);assert.equal(h.outbox.count(),2);
 await h.reload();await h.agent.tick();assert.equal(h.central.get(h.tournament.id)?.configVersion,3);assert.equal((h.central.get(h.tournament.id)?.config as ScoutConfig).event.name,'Local edit 2');assert.equal(h.outbox.count(),0);
 const remote=h.central.get(h.tournament.id) as Tournament;const logo=(remote.config as ScoutConfig).teams[0].logo;assert.notEqual(logo,second.teams[0].logo);assert.deepEqual(await readFile(path.join(h.centralUploads,...logo.split('/').slice(1))),png);
 assert.equal(h.live.event.name,'Local edit 2');await h.agent.tick();assert.equal(h.writes,1,'the platform echo does not rewrite a locally saved config or its remapped assets');
});

test('a stale config-push cannot overwrite a newer platform edit; accepting it cancels stale queued pushes',async(t)=>{
 const h=await harness(t);await h.agent.tick();h.live=config('Venue change');await h.local.saveActiveConfig(h.live);await h.agent.saveBack(h.live);
 value(await h.central.update(h.tournament.id,h.account.account.id,{config:config('Producer on platform')}));
 await h.agent.tick();assert.equal((h.central.get(h.tournament.id)?.config as ScoutConfig).event.name,'Producer on platform');assert.equal(h.live.event.name,'Venue change');assert.equal(h.agent.view().state,'update-available');
 h.live=config('Another queued change');await h.local.saveActiveConfig(h.live);await h.agent.saveBack(h.live);assert.equal(h.outbox.count(),1);
 await h.agent.applyUpdate();assert.equal(h.outbox.count(),0);assert.equal(h.live.event.name,'Producer on platform');assert.equal(h.central.get(h.tournament.id)?.configVersion,2);
});

test('another device contributes totals but cannot forge an ID or write another account’s tournament',async(t)=>{
 const h=await harness(t);const other=value(await h.central.create('other','other@example.com','Other',config('Other')));
 const denied=value(await h.service.metrics({...h.credentials,events:[{id:h.credentials.deviceId+':1',tournamentId:other.id,kind:'kill'}]}));assert.equal(denied.rejected?.length,1);assert.equal(other.totals.kills,0);
 const forged=await h.service.metrics({...h.credentials,events:[{id:'different-device:1',tournamentId:h.tournament.id,kind:'kill'}]});assert.equal(forged.ok,false);
 const tokenless=await h.service.sync({...h.credentials,token:'wrong'});assert.deepEqual(value(tokenless),{status:'revoked'});
 const grant=value(await h.beta.deviceStart({label:'Second venue',platform:'windows'},{address:'127.0.0.1',userAgent:'test',origin:'http://platform.test',secure:false}));value(await h.beta.deviceDecide(h.signed.cookieId,grant.userCode,true));const poll=value(await h.beta.devicePoll({deviceCode:grant.deviceCode}));
 const second={deviceId:poll.deviceId!,installationId:'second-install',token:poll.installationToken!};
 value(await h.service.metrics({...h.credentials,events:[{id:h.credentials.deviceId+':2',tournamentId:h.tournament.id,kind:'kill'}]}));
 value(await h.service.metrics({...second,events:[{id:second.deviceId+':1',tournamentId:h.tournament.id,kind:'kill'}]}));assert.equal(h.central.adminSummary([]).totals.kills,2);
});

test('version skew defaults missing versions, ignores future fields/kinds, and backs off unsupported hosts',async(t)=>{
 const h=await harness(t);
 const legacy=value(await h.service.sync({...h.credentials,appVersion:'old',future:42}));assert.equal(legacy.tournament?.configVersion,1);
 const future=value(await h.service.metrics({...h.credentials,future:true,events:[{id:h.credentials.deviceId+':1',tournamentId:h.tournament.id,kind:'future-event',unknown:true},{id:h.credentials.deviceId+':2',tournamentId:h.tournament.id,kind:'kill',extra:true}]}));assert.equal(future.acknowledged?.length,2);assert.equal(h.central.adminSummary([]).totals.kills,1);
 const oldIdentity:Pick<LauncherBetaService,'installationStatus'>={installationStatus:async()=>({ok:true,value:{status:'active'}})};
 assert.deepEqual(value(await new PlatformDeviceService(h.central,oldIdentity,h.centralUploads).sync(h.credentials)),{status:'unsupported'});
 let calls=0;const oldPlatform:typeof fetch=async()=>{calls++;return new Response('Not found',{status:404})};
 const agent=await new PlatformSyncAgent({url:'http://old.test',installation:h.installation,platform:h.local,outbox:h.outbox,file:path.join(h.root,'old-sync.json'),uploadRoot:h.localUploads,now:()=>h.now,fetchImpl:oldPlatform,readConfig:()=>h.live,writeConfig:async()=>{throw Error('must not apply')}}).load();
 await agent.tick();assert.equal(agent.view().state,'unsupported');await agent.tick();await agent.tick();assert.equal(calls,1,'404 is no sync, not an error loop');h.advance(5*60_000);await agent.tick();assert.equal(calls,2);
 let skewCalls=0;
 const skewed:typeof fetch=async()=>{skewCalls++;return new Response(JSON.stringify({...legacy,tournament:{...legacy.tournament,configHash:'f'.repeat(64)}}))};
 const skewAgent=new PlatformSyncAgent({url:'http://skew.test',installation:h.installation,platform:h.local,outbox:h.outbox,file:path.join(h.root,'skew-sync.json'),uploadRoot:h.localUploads,now:()=>h.now,fetchImpl:skewed,readConfig:()=>h.live,writeConfig:async()=>{throw Error('must not apply')}});
 await skewAgent.tick();assert.equal(skewAgent.view().state,'unsupported');await skewAgent.tick();assert.equal(skewCalls,1,'incompatible normalized hashes are no sync, not a repeated error');
 const minimal:typeof fetch=async()=>new Response(JSON.stringify({status:'active',future:true}));
 const minimalAgent=new PlatformSyncAgent({url:'http://minimal.test',installation:h.installation,platform:h.local,outbox:h.outbox,file:path.join(h.root,'minimal-sync.json'),uploadRoot:h.localUploads,fetchImpl:minimal,readConfig:()=>h.live,writeConfig:async()=>{throw Error('must not apply')}});
 await minimalAgent.tick();assert.equal(minimalAgent.view().state,'synced');assert.equal(minimalAgent.view().tournament,null);
});

test('real standalone HTTP saves and pack imports save back, closing applications is immediate, and sync stays off',async(t)=>{
 const host=await platformHost(t,{SCOUT_BETA_AUTO_APPROVE:'1'});
 const applied=await host.request('/api/beta/apply',{name:'Owner',email:'owner@example.com'});assert.equal(applied.status,200);
 const activated=await host.request('/api/beta/activate',{invite:new URL(applied.body.inviteUrl).searchParams.get('invite'),password:'long-enough-password'});assert.equal(activated.status,200);const cookie=activated.cookie;
 const created=await host.request('/api/platform/tournaments',{name:'Cup',config:hostConfig()},{cookie});assert.equal(created.status,200);const id=created.body.tournament.id;
 assert.equal((await host.request(`/api/platform/tournaments/${id}/activate`,{},{cookie})).status,200);
 const edited=hostConfig();edited.teams[0].name='Producer’s roster';
 assert.equal((await host.request('/api/config',edited,{method:'PUT'})).status,200);
 const saved=await host.request(`/api/platform/tournaments/${id}`,undefined,{cookie});assert.equal(saved.body.tournament.configVersion,2);assert.equal(saved.body.tournament.configHash,configHash(edited));
 await host.request(`/api/platform/tournaments/${id}/activate`,{},{cookie});assert.equal((await host.request('/api/config')).body.teams[0].name,'Producer’s roster');
 const imported=config('Imported final');const pack=await createMatchPack(imported,path.join(host.directory,'public','uploads'));
 assert.equal((await host.request('/api/pack/import',pack)).status,200);const afterImport=await host.request(`/api/platform/tournaments/${id}`,undefined,{cookie});assert.equal(afterImport.body.tournament.configVersion,3);assert.equal(afterImport.body.tournament.configHash,configHash(imported));
 const settings=await host.request('/api/platform/admin/settings',{applicationsOpen:false,reviewNote:'Closed locally'},{method:'PUT',cookie});assert.equal(settings.status,200);
 assert.equal((await host.request('/api/beta/status')).body.reviewNote,'Closed locally');const refused=await host.request('/api/beta/apply',{name:'Next applicant',email:'next@example.com'});assert.equal(refused.status,403);assert.equal(refused.body.code,'applications-closed');
 assert.equal((await host.request('/api/beta/link')).body.sync,undefined);await assert.rejects(()=>readFile(path.join(host.directory,'config','platform','outbox.json')),/ENOENT/);
});

test('real hosted routes share one settings desk and a linked venue sends config saves and derived GSI metrics uphill', {timeout:60_000},async(t)=>{
 const key='hosted-platform-test-service-key';
 const accounts=await createAccountService({file:':memory:',apiKey:key,ownerEmail:'owner@example.com',applicationsOpen:true,reviewNote:'Seeded wave',port:0,host:'127.0.0.1',log:()=>{}});t.after(()=>accounts.close());
 const accountRequest=async(route:string,body:unknown,cookie='')=>fetch(accounts.url+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
 assert.equal((await accountRequest('/apply',{name:'Owner',email:'owner@example.com'})).status,200);const owner=accounts.db.list()[0];const approved=accounts.db.decide(owner.id,'approve','Test owner')!;
 const activated=await accountRequest('/activate',{invite:approved.invite,password:'long-enough-password'});assert.equal(activated.status,200);const cookie=(activated.headers.getSetCookie?.()??[]).map(c=>c.split(';')[0]).join('; ');
 const central=await platformHost(t,{SCOUT_BETA_API_URL:accounts.url,SCOUT_BETA_API_KEY:key});
 assert.equal((await central.request('/api/beta/status')).body.reviewNote,'Seeded wave');
 const updated=await central.request('/api/platform/admin/settings',{applicationsOpen:false,reviewNote:'Closed in admin',publicStatsEnabled:true},{method:'PUT',cookie});assert.equal(updated.status,200);
 const refused=await central.request('/api/beta/apply',{name:'Next applicant',email:'next@example.com'});assert.equal(refused.status,403);assert.equal(refused.body.code,'applications-closed');
 assert.equal((await accountRequest('/apply',{name:'Next applicant',email:'direct@example.com'})).status,403);assert.equal((await central.request('/api/beta/status')).body.reviewNote,'Closed in admin');
 assert.equal((await central.request('/api/beta/settings')).status,404,'browser proxy cannot borrow the host’s service key for settings');
 assert.equal((await central.request('/api/beta/license/check',{resolveAccount:true})).status,404,'browser proxy cannot borrow the host’s service key for device identity');
 const created=await central.request('/api/platform/tournaments',{name:'Platform final',config:config('Platform final')},{cookie});assert.equal(created.status,200);const id=created.body.tournament.id;
 await central.request(`/api/platform/tournaments/${id}/activate`,{},{cookie});
 const launcherIdentity=new HostedBetaService(accounts.url);
 const grant=value(await launcherIdentity.deviceStart({label:'Venue PC',platform:'windows'},{address:'127.0.0.1',userAgent:'test',origin:central.url,secure:false}));assert.equal((await accountRequest('/device/approve',{userCode:grant.userCode},cookie)).status,200);const poll=value(await launcherIdentity.devicePoll({deviceCode:grant.deviceCode}));
 const venue=await platformHost(t,{SCOUT_BETA_API_URL:accounts.url,SCOUT_PLATFORM_URL:central.url},async directory=>{
  const installation=await new Installation(path.join(directory,'config','beta','installation.json')).load();assert.ok(installation.completeLink(poll));await installation.save();
  await writeFile(path.join(directory,'config','radars.json'),JSON.stringify({overviewSize:1024,maps:{de_mirage:{posX:12,posY:34,scale:2,image:''}}}));
  await writeFile(path.join(directory,'config','layout.json'),JSON.stringify({elements:{scoreboard:{x:40,y:20,w:1800}}}));
  await writeFile(path.join(directory,'config','overlay.json'),JSON.stringify({version:1,theme:{accent:'#123456'},widgets:[]}));
 });
 assert.equal((await venue.request('/api/beta/link/apply',{})).status,200);const initial=(await venue.request('/api/status')).body;assert.equal(initial.config.event.name,'Platform final');
 assert.equal(initial.radars.maps.de_mirage.posX,12);assert.equal(initial.layout.elements.scoreboard.x,40);assert.equal(initial.overlay.theme.accent,'#123456','per-venue calibration/design is not restored from central packs');
 assert.equal(initial.platform.settings.applicationsOpen,false);assert.equal(initial.platform.settings.reviewNote,'Closed in admin');
 // Larger than the account service's 256 KB body limit: artwork must go only to the platform.
 const largePng=Buffer.concat([png,Buffer.alloc(300_000)]);await writeFile(path.join(venue.directory,'public','uploads','logos','venue-large.png'),largePng);
 const localEdit=config('Venue edit');localEdit.teams[0].name='Venue roster';localEdit.teams[0].logo='uploads/logos/venue-large.png';assert.equal((await venue.request('/api/config',localEdit,{method:'PUT'})).status,200);
 const packet=(at:number,dead:boolean)=>({auth:{token:'platform-route-test-gsi-token'},provider:{steamid:'76561190000000000',timestamp:at},map:{name:'de_mirage',phase:'live',round:0,team_ct:{score:0},team_t:{score:0}},round:{phase:'live'},allplayers:{'76561190000000001':{name:'Killer',team:'CT',state:{health:100,round_kills:dead?1:0,round_killhs:dead?1:0}},'76561190000000002':{name:'Victim',team:'T',state:{health:dead?0:100}}}});
 assert.equal((await venue.request('/gsi',packet(1,false))).status,200);assert.equal((await venue.request('/gsi',packet(2,true))).status,200);assert.equal((await venue.request('/gsi',packet(2,true))).status,200);
 let stats:any,link:any;
 const deadline=Date.now()+22_000;
 do{
  stats=(await central.request('/api/platform/stats')).body;link=(await venue.request('/api/beta/link')).body;
  if(stats?.totals?.kills===1&&link?.sync?.outboxCount===0)break;
  await new Promise(resolve=>setTimeout(resolve,200));
 }while(Date.now()<deadline);
 assert.equal(stats.totals.kills,1,'the 15-second agent flushes EventTracker-derived kills from the venue');assert.equal(stats.totals.headshots,1);assert.equal(link.sync.outboxCount,0);
 const remote=await central.request(`/api/platform/tournaments/${id}`,undefined,{cookie});assert.equal(remote.body.tournament.configVersion,2);assert.equal(remote.body.tournament.config.teams[0].name,'Venue roster');
 const centralLogo=remote.body.tournament.config.teams[0].logo;assert.notEqual(centralLogo,localEdit.teams[0].logo);assert.deepEqual(await readFile(path.join(central.directory,'public',centralLogo)),largePng);
 const local=(await venue.request('/api/status')).body;assert.equal(local.config.event.name,'Venue edit');assert.equal(local.radars.maps.de_mirage.scale,2);assert.equal(local.overlay.theme.accent,'#123456');
 assert.equal((await accountRequest('/devices/revoke',{deviceId:poll.deviceId},cookie)).status,200);
 const revoked=await venue.request('/api/beta/link/apply',{});assert.equal(revoked.status,409);assert.equal(revoked.body.sync.state,'revoked');assert.equal((await venue.request('/api/config')).body.event.name,'Venue edit');
 const noToken=await central.request('/api/platform/device/sync',{deviceId:poll.deviceId,installationId:'venue',token:'wrong'});assert.deepEqual(noToken.body,{status:'revoked'});
});


test('a cold launcher gets seeded settings even when its local defaults have the same version',async(t)=>{
 const h=await harness(t);await h.central.setSettings({...h.central.settings,version:1,applicationsOpen:false,reviewNote:'Seeded closed'});
 assert.equal(h.local.settings.version,1);assert.equal(h.local.settings.applicationsOpen,true);await h.agent.tick();assert.equal(h.local.settings.applicationsOpen,false);assert.equal(h.local.settings.reviewNote,'Seeded closed');
});

test('a newer version with an identical central hash still warns when the local config has diverged',async(t)=>{
 const h=await harness(t);await h.agent.tick();h.live=config('Local edits');value(await h.central.update(h.tournament.id,h.account.account.id,{config:config()}));
 await h.agent.tick();assert.equal(h.agent.view().state,'update-available');assert.equal(h.live.event.name,'Local edits');assert.equal(h.writes,1);
 await h.agent.applyUpdate();assert.equal(h.live.event.name,'Cup');assert.equal(h.agent.view().state,'synced');
});

test('a central service-key failure is an outage, not a false device revocation',async(t)=>{
 const h=await harness(t);await h.agent.tick();
 const badIdentity:Pick<LauncherBetaService,'installationStatus'>={installationStatus:async()=>({ok:false,status:401,code:'bad-service-key',message:'Wrong service key'})};
 const unavailable=await new PlatformDeviceService(h.central,badIdentity,h.centralUploads).sync(h.credentials);assert.equal(unavailable.ok,false);if(!unavailable.ok)assert.equal(unavailable.status,503);
 const agent=await new PlatformSyncAgent({url:'http://platform.test',installation:h.installation,platform:h.local,outbox:h.outbox,file:h.stateFile,uploadRoot:h.localUploads,now:()=>h.now,fetchImpl:async()=>new Response('{}',{status:503}),readConfig:()=>h.live,writeConfig:async()=>{throw Error('must not apply')}}).load();
 await agent.tick();assert.equal(agent.view().state,'offline-grace');assert.equal(h.live.event.name,'Cup');
});

test('revoking during config-push restoration does not commit the new tournament config',async(t)=>{
 const h=await harness(t);await h.agent.tick();h.live=config('Do not commit');await h.local.saveActiveConfig(h.live);await h.agent.saveBack(h.live);let calls=0;
 const identity:Pick<LauncherBetaService,'installationStatus'>={installationStatus:async(input,options)=>{assert.deepEqual(Object.keys(input).sort(),['deviceId','installationId','token']);if(++calls===2)value(await h.beta.revokeDevice(h.signed.cookieId,h.credentials.deviceId));return h.beta.installationStatus(input,options)}};
 const result=value(await new PlatformDeviceService(h.central,identity,h.centralUploads).metrics({...h.credentials,events:h.outbox.batch(h.credentials.deviceId)}));assert.deepEqual(result,{status:'revoked'});assert.equal(h.central.get(h.tournament.id)?.configVersion,1);assert.equal((h.central.get(h.tournament.id)?.config as ScoutConfig).event.name,'Cup');assert.equal(h.outbox.count(),1);
});


test('failed outbox writes never expose unpersisted event IDs, and readable corrupt ledgers fail closed',async(t)=>{
 const root=await mkdtemp(path.join(tmpdir(),'scout-outbox-disk-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'outbox.json');const outbox=await new SyncOutbox(file).load();
 await outbox.appendMetrics('device','cup',[{kind:'kill'}]);await mkdir(file+'.tmp');
 await assert.rejects(()=>outbox.appendMetrics('device','cup',[{kind:'kill'}]));assert.deepEqual(outbox.batch('device').map(e=>e.id),['device:1']);
 await rm(file+'.tmp',{recursive:true});assert.equal((await outbox.appendMetrics('device','cup',[{kind:'kill'}]))[0].id,'device:2');
 const corrupted=JSON.parse(await readFile(file,'utf8'));corrupted.sequences.device=1;await writeFile(file,JSON.stringify(corrupted));await assert.rejects(()=>new SyncOutbox(file).load(),/sequence/);
});

test('owner map rotation reaches a linked host, survives offline restart, and catches up on reconnect',async(t)=>{
 const h=await harness(t);await h.agent.tick();const initialSeries=JSON.stringify(h.live.maps);const writes=h.writes;
 await h.central.updateSettings({mapRotation:['de_train','de_mirage']},'owner@example.com');
 await h.agent.tick();assert.deepEqual(h.local.settings.mapRotation,['de_train','de_mirage']);
 assert.equal(h.writes,writes,'a settings-only update never overwrites the local match');
 h.offline();await h.central.updateSettings({mapRotation:['de_ancient']},'owner@example.com');
 await h.agent.tick();await h.reload();await h.agent.tick();
 assert.deepEqual(h.local.settings.mapRotation,['de_train','de_mirage']);
 h.online();await h.agent.tick();assert.deepEqual(h.local.settings.mapRotation,['de_ancient']);
 assert.equal(JSON.stringify(h.live.maps),initialSeries);
});
