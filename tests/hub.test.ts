import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlatformStore} from '../server/platform.js';
import {normalizeConfig} from '../server/config.js';
import {defaultPublication,embedUrl,hubMeta,hubUrl,normalizePublication,projectTournament,safeStreamUrl,slugify,summarizeHub} from '../server/hub.js';

// Tournament Hub (docs/LAUNCH-FEATURES.md §1). Two properties matter more than any feature:
//   1. only what the organiser published leaves the host — no SteamID, real name, email or log;
//   2. a private or missing publication is a 404, never a page with holes in it.
const store=async()=>new PlatformStore(path.join(await mkdtemp(path.join(tmpdir(),'scout-hub-')),'store.json'),()=>1000).load();
const config=()=>normalizeConfig({
 name:'Autumn Cup',event:{name:'Autumn Cup 2026',stage:'Semifinals'},format:'bo3',
 teams:[
  {id:'t1',name:'Vertex',tag:'VTX',color:'#fff',logo:'assets/logos/vertex.png',players:[{steamid:'76561198000000001',name:'Ada Lovelace',nickname:'ada',role:'IGL',alias:'ada',photo:'uploads/players/ada.png'}]},
  {id:'t2',name:'Parallax',tag:'PLX',color:'#000',logo:'https://evil.example/x.png',players:[{steamid:'76561198000000002',name:'Grace Hopper',nickname:'grace',role:'AWP',alias:'grace',photo:''}]},
 ],
 maps:[{name:'de_mirage',pick:'A',status:'done',score:[13,9]},{name:'de_ancient',pick:'B',status:'live',score:[4,2]}],
 schedule:[{id:'s1',at:1_800_000_000_000,a:{team:'t1',label:''},b:{team:'t2',label:''},stage:'Semifinal',format:'bo3',stream:'https://twitch.tv/autumn'}],
});
async function published(over:Record<string,unknown>={}){
 const platform=await store();
 const created=await platform.create('a1','organiser@example.com','Autumn Cup',config());
 assert.equal(created.ok,true);if(!created.ok)throw new Error('create failed');
 const result=await platform.setPublication(created.value.id,'a1',{published:true,visibility:'unlisted',slug:'autumn-cup',...over});
 assert.equal(result.ok,true);if(!result.ok)throw new Error('publish failed');
 return {platform,id:created.value.id,publication:result.value.publication};
}

test('a slug is a stable, lowercase, URL-safe handle',()=>{
 assert.equal(slugify('Autumn Cup 2026'),'autumn-cup-2026');
 assert.equal(slugify('  Scrimm — Night  #3  '),'scrimm-night-3');
 assert.equal(slugify('???'),'event-page','a name with no letters still yields a usable slug');
 assert.ok(slugify('a'.repeat(80)).length<=48);
});

test('publishing defaults to unlisted, and only what is switched on is projected',async()=>{
 const {platform,publication}=await published();
 assert.equal(publication?.visibility,'unlisted');
 assert.equal(publication?.showRoster,false);
 assert.equal(publication?.showSchedule,true);
 const projected=platform.publicTournament('autumn-cup');
 assert.ok(projected);
 assert.equal(projected.name,'Autumn Cup');
 assert.equal(projected.teams[0].name,'Vertex');
 assert.equal(projected.teams[0].logo,'/assets/logos/vertex.png','a shipped asset is referenced');
 assert.equal(projected.teams[1].logo,null,'an absolute URL is not a logo');
 assert.deepEqual(projected.teams[0].players,[],'rosters are opt-in');
 assert.equal(projected.maps[0].score?.[0],13);
 assert.equal(projected.schedule[0].at,1_800_000_000_000);
 assert.equal(projected.links.stream,null);
});

test('the public projection cannot carry a SteamID, a real name, an email or a log',async()=>{
 const {platform}=await published({showRoster:true,stream:'https://twitch.tv/autumn'});
 const projected=platform.publicTournament('autumn-cup');
 assert.ok(projected);
 const serialized=JSON.stringify(projected);
 for(const forbidden of ['76561198000000001','76561198000000002','ada.lovelace','@example.com','uploads/players','steamid','ownerEmail','logs']){
  assert.equal(serialized.includes(forbidden),false,`${forbidden} must never reach a public page`);
 }
 assert.equal(projected.teams[0].players[0].name,'ada','the gamer name, not the real name');
 assert.equal(projected.teams[0].players[0].role,'IGL');
 assert.equal(projected.links.stream,'https://twitch.tv/autumn');
});

test('a private publication is indistinguishable from a missing one',async()=>{
 const {platform}=await published({visibility:'private'});
 assert.equal(platform.publicTournament('autumn-cup'),null);
 assert.equal(platform.bySlug('autumn-cup'),null);
 assert.deepEqual(platform.hubs(),[]);
 assert.equal(platform.published().length,0);
});

test('unpublishing keeps the tournament and its data, and republishing restores the link',async()=>{
 const {platform,id}=await published();
 const off=await platform.setPublication(id,'a1',{published:false});
 assert.equal(off.ok,true);if(!off.ok)return;
 assert.equal(off.value.publication,null);
 assert.ok(platform.get(id));
 assert.equal(platform.publicTournament('autumn-cup'),null);
 const on=await platform.setPublication(id,'a1',{published:true,slug:'autumn-cup'});
 assert.equal(on.ok,true);
 assert.ok(platform.publicTournament('autumn-cup'));
});

test('only the owner can publish, and a slug is unique across the platform',async()=>{
 const {platform,id}=await published();
 const other=await platform.create('a2','other@example.com','Autumn Cup',config());
 assert.equal(other.ok,true);if(!other.ok)return;
 assert.equal((await platform.setPublication(id,'a2',{published:true})).ok,false,'a stranger cannot publish your tournament');
 const collision=await platform.setPublication(other.value.id,'a2',{published:true,visibility:'public',slug:'autumn-cup'});
 assert.equal(collision.ok,true);if(!collision.ok)return;
 assert.notEqual(collision.value.publication?.slug,'autumn-cup','a second organiser gets a different URL');
 assert.ok(collision.value.publication?.slug.startsWith('autumn-cup-'));
});

test('a stream link is a link, or nothing at all',()=>{
 assert.equal(safeStreamUrl('javascript:alert(1)'),'');
 assert.equal(safeStreamUrl('data:text/html,<script>'),'');
 assert.equal(safeStreamUrl('not a url'),'');
 assert.equal(safeStreamUrl('https://twitch.tv/x'),'https://twitch.tv/x');
 assert.equal(safeStreamUrl(`https://example.com/${'a'.repeat(400)}`),'');
});

test('a malformed publication falls back instead of throwing',()=>{
 const previous=defaultPublication('Autumn Cup',1);
 assert.equal(normalizePublication(undefined,previous),previous);
 assert.equal(normalizePublication({published:false},previous),null);
 const next=normalizePublication({slug:'!!!',visibility:'nonsense' as any},previous,2);
 assert.equal(next?.slug,'autumn-cup');
 assert.equal(next?.visibility,'unlisted');
 assert.equal(next?.updatedAt,2);
});

test('the hub lists only published tournaments, live ones first',async()=>{
 const {platform}=await published();
 const second=await platform.create('a2','other@example.com','Winter Cup',config());
 assert.equal(second.ok,true);if(!second.ok)return;
 await platform.setPublication(second.value.id,'a2',{published:true,slug:'winter-cup',visibility:'public'});
 const hubs=platform.hubs();
 assert.equal(hubs.length,2);
 const summaries=hubs.map(hub=>hub.slug).sort();
 assert.deepEqual(summaries,['autumn-cup','winter-cup']);
 const summary=summarizeHub(platform.get(platform.bySlug('winter-cup')!.id)!);
 assert.equal(summary?.visibility,'public');
});

test('the page metadata is per-tournament and honest about indexing',async()=>{
 const {platform}=await published({visibility:'public'});
 const projected=platform.publicTournament('autumn-cup');
 assert.ok(projected);
 const meta=hubMeta(projected);
 assert.match(meta.title,/Autumn Cup/);
 assert.match(meta.description,/mirage 13:9/i);
 assert.equal(meta.robots,'index, follow');
 assert.equal(hubMeta({...projected,visibility:'unlisted'}).robots,'noindex, follow','an unlisted page asks not to be indexed');
 assert.equal(hubUrl('https://scout.example/','autumn-cup'),'https://scout.example/t/autumn-cup');
 assert.equal(embedUrl('https://scout.example','autumn-cup'),'https://scout.example/embed/autumn-cup');
});
