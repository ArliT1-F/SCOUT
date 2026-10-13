import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlatformStore,isPlatformOwner,platformOwnerEmail,sanitizeSettings,DEFAULT_PLATFORM_SETTINGS} from '../server/platform.js';

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
