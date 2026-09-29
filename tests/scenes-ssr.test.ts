import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {SceneStage} from '../src/stage';
import {normalizeConfig} from '../server/config';

// The scenes' pictures are the shipped thumbnails (public/thumbs/), never the radar overviews
// (public/radars/) — those belong to the custom radar only. Rendering both picture-showing scenes
// to HTML pins the rule end to end: which <img> paths go to the browser, and that the matchup
// chips carry a picture slot at all. (createElement instead of JSX so the file matches the
// tests/*.test.ts suite glob.)

const config=normalizeConfig({
 event:{name:'Campus Cup',stage:'Grand final'},format:'bo3',
 teams:[
  {id:'a',name:'Vertex',tag:'VTX',color:'#d970c2',players:[{name:'nova',steamid:'1'}]},
  {id:'b',name:'Parallax',tag:'PRX',color:'#e8c97e',players:[]},
 ],
 maps:[{name:'de_mirage',pick:'A',score:[13,9],status:'done'},{name:'de_inferno',pick:'B',score:[8,6],status:'live'},{name:'de_nuke',pick:'decider',status:'upcoming'}],
}) as any;

const render=(scene:'matchup'|'veto')=>renderToString(createElement(SceneStage,{
 scene,config,swapped:false,players:[],nameOf:()=>'',breakEndsAt:null,now:Date.now()
}));

test('matchup and map series show thumbnails, never radar overviews',()=>{
 for(const scene of ['matchup','veto'] as const){
  const html=render(scene);
  const thumbs=[...html.matchAll(/\/thumbs\/[\w-]+\.png/g)].map(match=>match[0]);
  assert.deepEqual(thumbs,['/thumbs/de_mirage.png','/thumbs/de_inferno.png','/thumbs/de_nuke.png'],`${scene}: one thumbnail per map`);
  assert.equal((html.match(/\/radars\//g)||[]).length,0,`${scene}: radar imagery must not reach a scene`);
 }
});

test('the matchup chip has a picture slot that collapses without a file',()=>{
 const html=render('matchup');
 assert.equal((html.match(/st-chip-pic/g)||[]).length,3,'a slot per map card');
 // MapPicture renders null when the card has no image path, leaving only the empty slot.
 const bare=renderToString(createElement(SceneStage,{
  scene:'matchup',config:{format:'bo3',teams:[{id:'a',name:'A'},{id:'b',name:'B'}],maps:[{name:''}]},
  swapped:false,players:[],nameOf:()=>'',breakEndsAt:null,now:Date.now()
 }));
 assert.ok(bare.includes('st-chip-pic'),'the slot exists even with no picture');
 assert.ok(!bare.includes('<img'),'no picture, no img');
});
