import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {configSchema,normalizeConfig,sponsorAt,liveSponsors} from '../server/config';
import {createEventPack,restoreEventPack} from '../server/packs';
import {radarsSchema} from '../server/radars';
import {emptyLayout} from '../server/layout';
import {defaultOverlay,sponsorWidget} from '../server/overlay';
import {SponsorSlot} from '../src/hud';
import {SceneStage} from '../src/stage';

// Sponsors: the config shape, the shared rotation clock, the HUD slot, the break screen row and the
// event-pack round trip for their logos.

const base={teams:[{id:'a',name:'Alpha'},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage'}]};
const withSponsors=(sponsors:any)=>normalizeConfig({...base,sponsors});

test('sponsors default on, drop empty rows, and only accept sponsor uploads',()=>{
 const empty=normalizeConfig(base);
 assert.deepEqual(empty.sponsors,{items:[],rotateSeconds:10,showOnHud:true,showOnBreak:true,caption:''});
 const config=withSponsors({items:[{id:'s1',name:'Drink',logo:'uploads/sponsors/1-d.png'},{id:'s2'},{id:'s1',name:'Name only'}]});
 assert.deepEqual(config.sponsors.items.map(item=>item.id),['s1','s1-2'],'blank rows go, duplicate ids are made unique');
 assert.equal(configSchema.safeParse({...base,sponsors:{items:[{id:'x',logo:'https://elsewhere.test/a.png'}]}}).success,false);
 assert.equal(configSchema.safeParse({...base,sponsors:{rotateSeconds:1}}).success,false);
 assert.deepEqual(liveSponsors(config.sponsors).map(item=>item.id),['s1'],'a sponsor without a logo is not drawn');
});

test('every output shows the same sponsor at the same host time',()=>{
 const sponsors=withSponsors({rotateSeconds:5,items:[{id:'a',logo:'uploads/sponsors/1-a.png'},{id:'b',logo:'uploads/sponsors/1-b.png'},{id:'c',logo:'uploads/sponsors/1-c.png'}]}).sponsors;
 assert.deepEqual([0,4_999,5_000,10_000,15_000].map(now=>sponsorAt(sponsors,now)?.id),['a','a','b','c','a']);
 assert.equal(sponsorAt({items:[]},0),null);
});

test('the HUD slot follows the sponsor switch and the Overlay Studio layer',()=>{
 const sponsors=withSponsors({items:[{id:'a',name:'Drink',logo:'uploads/sponsors/1-a.png'}]}).sponsors;
 const overlay=defaultOverlay();
 const html=renderToString(createElement(SponsorSlot,{sponsors,overlay,now:0}));
 assert.match(html,/class="hud-sponsor"/);assert.match(html,/src="\/uploads\/sponsors\/1-a\.png"/);assert.match(html,/alt="Drink"/);
 assert.equal(renderToString(createElement(SponsorSlot,{sponsors:{...sponsors,showOnHud:false},overlay,now:0})),'');
 const hidden=defaultOverlay();sponsorWidget(hidden).enabled=false;
 assert.equal(renderToString(createElement(SponsorSlot,{sponsors,overlay:hidden,now:0})),'');
 // An overlay saved before the layer existed still gets a slot in the default place.
 const old={...defaultOverlay(),widgets:defaultOverlay().widgets.filter(widget=>widget.kind!=='sponsorSlot')};
 assert.match(renderToString(createElement(SponsorSlot,{sponsors,overlay:old,now:0})),/hud-sponsor/);
});

test('the break screen lines sponsors up under its caption',()=>{
 const render=(sponsors:any)=>renderToString(createElement(SceneStage,{scene:'break',config:withSponsors(sponsors) as any,swapped:false,players:[],nameOf:()=>'',breakEndsAt:null,now:0}));
 const html=render({caption:'Presented by',items:[{id:'a',name:'Drink',logo:'uploads/sponsors/1-a.png'},{id:'b',name:'Chairs',logo:'uploads/sponsors/1-b.png'}]});
 assert.match(html,/PRESENTED BY/);
 assert.equal((html.match(/\/uploads\/sponsors\//g)||[]).length,2);
 assert.doesNotMatch(render({showOnBreak:false,items:[{id:'a',logo:'uploads/sponsors/1-a.png'}]}),/st-sponsors/);
 assert.doesNotMatch(render({}),/st-sponsors/,'no sponsors, no empty row');
});

const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=','base64');
test('event packs carry sponsor logos and remap them on restore',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scout-sponsor-pack-'));
 try{
  const source=path.join(root,'source');
  await mkdir(path.join(source,'sponsors'),{recursive:true});await writeFile(path.join(source,'sponsors','1-a.png'),tinyPng);
  const config=withSponsors({items:[{id:'a',name:'Drink',logo:'uploads/sponsors/1-a.png'}]});
  const pack=await createEventPack(config,radarsSchema.parse({maps:{}}),emptyLayout(),defaultOverlay(),source);
  assert.deepEqual(pack.assets.map(asset=>asset.path),['uploads/sponsors/1-a.png']);
  const restored=await restoreEventPack(pack,path.join(root,'destination'));
  assert.match(restored.config.sponsors.items[0].logo,/^uploads\/sponsors\/\d+-pack-/);
 }finally{await rm(root,{recursive:true,force:true})}
});
