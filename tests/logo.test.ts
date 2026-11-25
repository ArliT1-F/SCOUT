import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';

// The SCOUT mark replaced the ✳ character that stood in for it everywhere (panel, unlock screen, touch
// remote, landing page, HUD event header and all eight broadcast scenes), and was later redrawn as the
// stencil S. This pins the parts of that promise a test can hold: the component draws the same path
// the shipped SVGs do, the asset files exist, and the glyph cannot quietly come back.

const read=(path:string)=>readFile(fileURLToPath(new URL(`../${path}`,import.meta.url)),'utf8');
const {ScoutMark,ScoutBrand,SCOUT_MARK_PATH}=await import('../src/logo');
const paths=(source:string)=>[...source.matchAll(/<path d="([^"]+)"/g)].map(match=>match[1]);

test('the mark component and the shipped SVGs draw the same shape',async()=>{
 assert.deepEqual(paths(await read('public/logo/scout-mark.svg')),[SCOUT_MARK_PATH],'public/logo/scout-mark.svg has drifted from src/logo.tsx');
 assert.deepEqual(paths(await read('public/favicon.svg')),[SCOUT_MARK_PATH],'public/favicon.svg has drifted from src/logo.tsx');
 // The email-avatar (BIMI) logo: SVG Tiny PS, square, solid ground, a title and no x/y on the root.
 const bimi=await read('public/logo/scout-bimi.svg');
 assert.deepEqual(paths(bimi),[SCOUT_MARK_PATH],'public/logo/scout-bimi.svg has drifted from src/logo.tsx');
 assert.match(bimi,/version="1\.2" baseProfile="tiny-ps"/);
 assert.match(bimi,/<title>SCOUT<\/title>/);
 assert.match(bimi,/<rect width="100" height="100" fill="#120e15"\/>/,'inboxes need a solid background');
 assert.doesNotMatch(bimi.split('>')[0],/\s[xy]=/,'BIMI validators reject x/y on the root element');
 // Point symmetry is what makes the stencil S read the same either way up: every corner, turned
 // 180° about the centre, lands on another corner of the same path.
 const corners=new Set<string>();
 let at=[0,0];
 for(const [,cmd,args] of SCOUT_MARK_PATH.matchAll(/([MLHV])\s*([\d\s]+)/g)){
  const n=args.trim().split(/\s+/).map(Number);
  at=cmd==='H'?[n[0],at[1]]:cmd==='V'?[at[0],n[0]]:[n[0],n[1]];
  corners.add(at.join(','));
 }
 assert.equal(corners.size,14,'two gaps, four 45° cuts and the bar ends');
 for(const corner of corners){const [x,y]=corner.split(',').map(Number);assert.ok(corners.has(`${100-x},${100-y}`),`${corner} has no 180° partner`)}
});

test('the rendered mark is a single-path SVG in the bright tone',()=>{
 const html=renderToString(createElement(ScoutMark,{size:32,title:'SCOUT'}));
 assert.match(html,/^<svg/,'the mark is an inline SVG, not a font glyph');
 assert.match(html,/width="32" height="32"/);
 assert.match(html,/viewBox="0 0 100 100"/,'one viewBox, so one shape at every size');
 assert.match(html,/stroke="var\(--mark-bright,currentColor\)"/,'the S takes the bright tone, or the surrounding colour');
 assert.match(html,/fill="none"/);
 assert.match(html,/<title>SCOUT<\/title>/,'a titled mark is announced by its name');
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
