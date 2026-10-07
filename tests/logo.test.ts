import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';

// The SCOUT mark replaced the ✳ character that stood in for it everywhere (panel, unlock screen, touch
// remote, landing page, HUD event header and all eight broadcast scenes). This pins the parts of that
// promise a test can hold: the component draws the same geometry the shipped SVG does, the asset files
// exist, and the glyph cannot quietly come back.

const read=(path:string)=>readFile(fileURLToPath(new URL(`../${path}`,import.meta.url)),'utf8');
const {ScoutMark,ScoutBrand}=await import('../src/logo');

// Every <rect>/<circle> in a file, as "x,y,w,h,rx" / "cx,cy,r" tuples — enough to compare two drawings
// of the same mark without caring which file they live in.
function shapes(source:string):string[]{
 const out:string[]=[];
 // Only positioned shapes: the mask's white plate, the favicon's tile rect and other scaffolding have
 // no x/y and are not part of the mark.
 for(const match of source.replace(/<mask[\s\S]*?<\/mask>/g,'').matchAll(/<rect (x="[^"]*"[^/>]+)\/>/g)){
  const attr=(name:string)=>new RegExp(`${name}="([^"]+)"`).exec(match[1])?.[1]??'';
  out.push(`rect ${attr('x')} ${attr('y')} ${attr('width')} ${attr('height')} ${attr('rx')}`);
  const rotate=/rotate\(([\d.]+)/.exec(match[1])?.[1];
  if(rotate) out.push(`rotate ${rotate}`);
 }
 for(const match of source.replace(/<mask[\s\S]*?<\/mask>/g,'<mask></mask>').matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g))
  out.push(`circle ${match[1]} ${match[2]} ${match[3]}`);
 return out.sort();
}

test('the mark component and the shipped SVG draw the same shape',async()=>{
 const component=shapes(await read('src/logo.tsx'));
 const asset=shapes(await read('public/logo/scout-mark.svg'));
 const favicon=shapes(await read('public/favicon.svg'));
 assert.equal(component.length,16,'eight spoke rects, their seven rotations and the hub');
 assert.deepEqual(asset,component,'public/logo/scout-mark.svg has drifted from src/logo.tsx');
 assert.deepEqual(favicon,component,'public/favicon.svg has drifted from src/logo.tsx');
});

test('the rendered mark is a two-tone SVG with the icon’s centre hole',()=>{
 const html=renderToString(createElement(ScoutMark,{size:32,title:'SCOUT'}));
 assert.match(html,/^<svg/,'the mark is an inline SVG, not a font glyph');
 assert.match(html,/width="32" height="32"/);
 assert.match(html,/viewBox="0 0 100 100"/,'one viewBox, so one shape at every size');
 assert.match(html,/fill="var\(--mark-bright,currentColor\)"/,'the fat diagonals take the bright tone');
 assert.match(html,/fill="currentColor"/,'the hub and axial spokes take the surrounding colour');
 assert.match(html,/mask="url\(#scout-mark-hole[^)]*\)"/,'the icon’s centre hole is a mask, so it stays transparent');
 assert.match(html,/r="4\.7" fill="#000"/,'the hole is cut, not painted');
 assert.match(html,/<title>SCOUT<\/title>/,'a titled mark is announced by its name');
 // Two instances on one page must not share a mask id (a duplicate id would break the second one).
 const twice=renderToString(createElement('div',null,createElement(ScoutMark,{}),createElement(ScoutMark,{})));
 const ids=[...twice.matchAll(/mask id="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(new Set(ids).size,2,`mask ids must be unique per instance, got ${ids.join(', ')}`);
});

test('the wordmark pairs the mark with the name, and the glyph is gone',async()=>{
 const brand=renderToString(createElement(ScoutBrand,{size:24}));
 assert.match(brand,/scout/);
 assert.match(brand,/<svg/);
 assert.match(brand,/®/);
 for(const file of ['src/main.tsx','src/session.tsx','src/site.tsx','src/operator-tools.tsx','src/hud.tsx','src/stage.tsx','src/logo.tsx'])
  assert.equal((await read(file)).includes('✳'),false,`${file} still renders the ✳ stand-in`);
 for(const asset of ['public/logo/scout-mark.svg','public/favicon.svg','public/favicon.png','public/apple-touch-icon.png'])
  assert.ok((await read(asset)).length>0,`${asset} should exist`);
});
