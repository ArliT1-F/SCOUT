import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlatformStore,isPlatformOwner,platformOwnerEmail,sanitizeSettings,DEFAULT_PLATFORM_SETTINGS,configHash} from '../server/platform.js';
import {normalizeConfig} from '../server/config.js';

const store=async()=>new PlatformStore(path.join(await mkdtemp(path.join(tmpdir(),'scout-platform-')),'store.json'),()=>1000).load();

test('only the SCOUT_OWNER_EMAIL account is the platform owner',()=>{
 const env={SCOUT_OWNER_EMAIL:' Owner@Example.com '};
 assert.equal(platformOwnerEmail(env),'owner@example.com');
 assert.equal(isPlatformOwner('owner@example.com',env),true);
 assert.equal(isPlatformOwner('someone@example.com',env),false);
 assert.equal(isPlatformOwner('owner@example.com',{}),false);
});

test('settings are clamped, versioned and keep the beta default of 3 tournaments',()=>{
 assert.equal(DEFAULT_PLATFORM_SETTINGS.maxTournamentsPerUser,3);
 const next=sanitizeSettings({maxTournamentsPerUser:0},DEFAULT_PLATFORM_SETTINGS,'owner@example.com',5);
 assert.equal(next.maxTournamentsPerUser,1); assert.equal(next.version,2); assert.equal(next.updatedBy,'owner@example.com');
});

test('each whitelisted user owns independent tournaments, up to the admin limit',async()=>{
 const s=await store();
 assert.equal((await s.create('a','a@example.com','A Cup',null)).ok,true);
 assert.equal((await s.create('a','a@example.com','A2',null)).ok,true);
 assert.equal((await s.create('a','a@example.com','A3',null)).ok,true);
 const fourth=await s.create('a','a@example.com','A4',null);
 assert.equal(fourth.ok,false); if(!fourth.ok) assert.equal(fourth.code,'tournament-limit');
 // another user is unaffected by a's limit and cannot touch a's tournaments
 assert.equal((await s.create('b','b@example.com','B Cup',null)).ok,true);
 assert.equal(s.listFor('b').length,1); assert.equal(s.ownedBy(s.listFor('a')[0].id,'b'),null);
 await s.updateSettings({maxTournamentsPerUser:1},'owner@example.com');
 assert.equal((await s.create('b','b@example.com','B2',null)).ok,false);
});

test('match-log metrics aggregate per tournament and globally (kills, headshots, grenades)',async()=>{
 const s=await store();
 const t=(await s.create('a','a@example.com','Cup',null) as any).value;
 await s.record(t.id,[{kind:'kill',count:2,map:'de_mirage'},{kind:'headshot'},{kind:'grenade',count:3},{kind:'round'}]);
 await s.record(t.id,[{kind:'bogus' as any},{kind:'kill',count:0}]); // bogus ignored, count clamped to 1
 const summary=s.adminSummary([{id:'a',email:'a@example.com',status:'approved'}]);
 assert.deepEqual(summary.totals,{kills:3,headshots:1,grenades:3,rounds:1,maps:0,matches:0});
 assert.equal(summary.users[0].totals.kills,3);
 assert.equal(summary.recentLogs[0].kind,'kill');
});

test('a tournament survives a reload from disk',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-platform-')); const file=path.join(dir,'store.json');
 const s=await new PlatformStore(file,()=>1000).load();
 const t=(await s.create('a','a@example.com','Persisted',null) as any).value;
 await s.activate(t.id,'a');
 const again=await new PlatformStore(file,()=>1000).load();
 assert.equal(again.listFor('a')[0].name,'Persisted'); assert.equal(again.active()?.id,t.id);
});

test('active selections survive independently per account without tenant-scoping the live host',async()=>{
 const s=await store();const a=(await s.create('a','a@example.com','A',null) as any).value;const b=(await s.create('b','b@example.com','B',null) as any).value;
 await s.activate(a.id,'a');await s.activate(b.id,'b');assert.equal(s.active()?.id,b.id);assert.equal(s.activeFor('a')?.id,a.id);assert.equal(s.activeFor('b')?.id,b.id);
 await s.remove(a.id,'a');assert.equal(s.activeFor('a'),null);assert.equal(s.activeFor('b')?.id,b.id);
});

test('saving the active config bumps a normalized hash/version and reactivation cannot revert it',async()=>{
 const s=await store();const cfg=normalizeConfig({teams:[{id:'a',name:'Alpha'},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage'}]});
 const r=await s.create('a','a@example.com','Cup',cfg);assert.ok(r.ok);await s.activate(r.value.id,'a');const original=r.value.configHash;
 const edited=structuredClone(cfg);edited.teams[0].name='New roster';await s.saveActiveConfig(edited);
 assert.equal(s.active()?.configVersion,2);assert.notEqual(s.active()?.configHash,original);assert.equal(s.active()?.configHash,configHash(edited));
 await s.record(r.value.id,[{kind:'kill'}]);assert.equal(s.active()?.configVersion,2,'metric timestamps are not config revisions');
 await s.activate(r.value.id,'a');assert.equal((s.active()?.config as typeof cfg).teams[0].name,'New roster');assert.equal(s.active()?.configVersion,2);
 assert.equal(configHash({...edited,futureField:true}),configHash(edited),'normalization ignores version-skew fields');
 const stale=await s.update(r.value.id,'a',{config:cfg},{version:1,hash:original!});assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.code,'config-conflict');
});

test('idempotency survives log eviction, out-of-order batches, concurrent writes and restart',async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-dedup-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'store.json');const s=await new PlatformStore(file).load();
 const r=await s.create('a','a@example.com','Cup',null);assert.ok(r.ok);const id=r.value.id;
 await s.record(id,[{id:'device:5',kind:'kill'},{id:'device:1',kind:'kill'},{id:'device:3',kind:'kill'},{id:'device:3',kind:'kill'}]);
 await Promise.all(Array.from({length:1100},(_,i)=>i+1).filter(n=>![1,3,5].includes(n)).reduce<Array<Array<{id:string;kind:'kill'}>>>((batches,n,i)=>{if(i%50===0)batches.push([]);batches.at(-1)!.push({id:`device:${n}`,kind:'kill'});return batches},[]).map(batch=>s.record(id,batch)));
 assert.equal(s.get(id)?.totals.kills,1100);assert.equal(s.get(id)?.logs.length,300);assert.equal(s.data.globalLogs.length,1000);assert.deepEqual(s.data.eventIds['device:device'],[[1,1100]],'one compact range, not a growing per-kill ID list');
 const again=await new PlatformStore(file).load();await again.record(id,[{id:'device:1',kind:'kill'},{id:'device:1100',kind:'kill'}]);assert.equal(again.get(id)?.totals.kills,1100);
});

test('old stores migrate missing config versions and active-account selections without a reset',async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-platform-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'store.json');
 await writeFile(file,JSON.stringify({version:1,tournaments:[{id:'cup',accountId:'a',ownerEmail:'a@example.com',name:'Legacy cup',config:{teams:[{id:'a',name:'A'},{id:'b',name:'B'}],maps:[{name:'de_mirage'}]},createdAt:1,updatedAt:1,lastActiveAt:1,totals:{kills:4,headshots:0,grenades:0,rounds:0,maps:0,matches:0},logs:[]}],activeTournamentId:'cup'}));
 const migrated=await new PlatformStore(file).load();assert.equal(migrated.activeFor('a')?.id,'cup');assert.equal(migrated.active()?.configVersion,1);assert.equal(migrated.active()?.configHash,configHash(migrated.active()?.config));assert.equal(migrated.adminSummary([]).totals.kills,4);
});
