import test from 'node:test';
import assert from 'node:assert/strict';
import {PlatformStore} from '../server/platform.js';
import {normalizeConfig} from '../server/config.js';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The hub projection is the boundary: what is not in PublicTournament cannot leak. These tests use a
// real tournament config (roster with real names, SteamIDs, host-only asset paths) and assert the
// published shape contains none of it — plus that multi-stage data arrives as a readable table.
const setup=async()=>{
 const file=join(await mkdtemp(join(tmpdir(),'scout-hub-')),'store.json');
 const store=await new PlatformStore(file).load();
 const created=await store.create('acct_1','owner@example.com','Autumn Cup',config());
 if(!created.ok) throw new Error(created.message);
 return {store,id:created.value.id};
};
const config=()=>normalizeConfig({
 event:{name:'Autumn Cup',stage:'Group A'},
 format:'bo3',
 maps:[{name:'de_mirage',status:'done',score:[13,9]},{name:'de_inferno',status:'live'}],
 teams:[
  {id:'t1',name:'Nova',tag:'NOV',logo:'assets/teams/nova.png',players:[{name:'Oleksandr Kostyliev',nickname:'s1mple',steamid:'STEAM_1:1:123',photo:'uploads/players/a.png',role:'AWPer'}]},
  {id:'t2',name:'Falcons',tag:'FLC',logo:'uploads/teams/falcons.png',players:[{name:'Real Name',nickname:'NiKo',steamid:'STEAM_1:1:456',role:'Rifler'}]},
 ],
 bracket:{rounds:[
  {name:'Group A',matches:[{id:'m1',a:{team:'t1'},b:{team:'t2'},aScore:2,bScore:0,winner:'a',status:'done'},{id:'m2',a:{label:'Winner of A'},b:{team:'t2'},aScore:0,bScore:0,winner:null,status:'upcoming'}]},
  {name:'Playoffs',matches:[{id:'m3',a:{team:'t1'},b:{label:'TBD'},aScore:0,bScore:0,winner:null,status:'upcoming'}]},
 ]},
 schedule:[{id:'s1',at:Date.now()+60_000,a:{team:'t1'},b:{team:'t2'},stage:'Group A',format:'bo1'}],
});

test('a published hub never carries player identity, steamids or host-only assets',async()=>{
 const {store,id}=await setup();
 await store.setPublication(id,'acct_1',{published:true,visibility:'public',showRoster:true,slug:'autumn-cup'});
 const projected=store.publicTournament('autumn-cup');
 assert.ok(projected);
 const text=JSON.stringify(projected);
 for(const secret of ['Oleksandr Kostyliev','Real Name','STEAM_1:1','uploads/','acct_1','photo']){
  assert.equal(text.includes(secret),false,`projection leaked ${secret}`);
 }
 assert.deepEqual(projected!.teams[0].players,[{name:'s1mple',role:'AWPer'}],'a roster shows the gamer name and role only');
 assert.equal(projected!.teams[0].logo,'/assets/teams/nova.png');
 assert.equal(projected!.teams[1].logo,null,'an uploaded logo is not reachable from the website');
});

test('the series page carries a group table and a knockout stage',async()=>{
 const {store,id}=await setup();
 await store.setPublication(id,'acct_1',{published:true,visibility:'public',slug:'autumn-cup'});
 const projected=store.publicTournament('autumn-cup')!;
 assert.equal(projected.stageHeadline,'Group A → Playoffs');
 const group=projected.stages.find(stage=>stage.kind==='group')!;
 assert.equal(group.table.length,2);
 assert.equal(group.table.find(row=>row.team==='Nova')?.points,3);
 const playoff=projected.stages.find(stage=>stage.kind==='playoff')!;
 assert.equal(playoff.table.length,0,'a knockout stage is read as a bracket, not ranked');
 assert.equal(playoff.matches.length,1);
});

test('a private or missing publication is null, never a stripped page',async()=>{
 const {store,id}=await setup();
 await store.setPublication(id,'acct_1',{published:true,visibility:'private',slug:'autumn-cup'});
 assert.equal(store.publicTournament('autumn-cup'),null);
 assert.equal(store.publicTournament('does-not-exist'),null);
});

test('an unpublished tournament keeps its slug so links can be revived',async()=>{
 const {store,id}=await setup();
 await store.setPublication(id,'acct_1',{published:true,visibility:'public',slug:'autumn-cup'});
 assert.equal(store.publicTournament('autumn-cup')?.slug,'autumn-cup');
 await store.setPublication(id,'acct_1',{published:false});
 assert.equal(store.publicTournament('autumn-cup'),null);
});
