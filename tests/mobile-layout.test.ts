import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// The web surfaces are used from a phone: the landing page and the application form are read on one,
// the operator panel is checked on one at the venue, and the touch remote is built for one. Two bugs
// this pins shut, both found by loading the real pages at 390px and 320px:
//
//   1. the panel's chrome was written with bare element selectors (`footer{}`, `nav{}`, `main{}`,
//      `header{}`), which also matched the landing page's own <footer>/<nav>/<main>/<header> — its
//      three footer blocks were forced into one 812px row on a 390px phone;
//   2. a grid track of `repeat(auto-fit,minmax(330px,1fr))` cannot shrink below 330px, so the FAQ
//      overflowed a 320px phone.
//
// It also holds the phone chrome in place: the panel ships a drawer and a top bar, index.html ships
// the mark as its favicon, and the drawer's classes are actually rendered.

const css=await readFile(fileURLToPath(new URL('../src/style.css',import.meta.url)),'utf8');
const main=await readFile(fileURLToPath(new URL('../src/main.tsx',import.meta.url)),'utf8');
const html=await readFile(fileURLToPath(new URL('../index.html',import.meta.url)),'utf8');
const clean=css.replace(/\/\*[\s\S]*?\*\//g,'');

// Top-level rules only: a selector's own text, with the media-query wrappers removed.
function selectors():string[]{
 const out:string[]=[];
 let cursor=0;
 while(cursor<clean.length){
  const open=clean.indexOf('{',cursor);
  if(open<0) break;
  const close=clean.indexOf('}',open);
  const selector=clean.slice(cursor,open).trim();
  if(!selector.startsWith('@')) for(const part of selector.split(',')) out.push(part.trim());
  cursor=close+1;
 }
 return out;
}

test('panel chrome never styles a bare structural element',()=>{
 // html/body/:root and the universal selector are document-level on purpose; everything else that
 // targets an element by tag alone leaks into the landing page, the uploads or an embedded preview.
 const structural=/^(nav|main|header|footer|aside|section|figure|article|table|ul|ol|p|h[1-6])([ >+~]|$)/;
 const leaks=selectors().filter(selector=>structural.test(selector)&&selector.split(' ')[0]===selector.split(' ')[0]&&!/^\.|^#|^\w*\[/.test(selector.split(' ')[0]));
 assert.deepEqual(leaks,[],`scope these to .app (or a class): ${leaks.join(', ')}`);
 assert.ok(selectors().includes('.app footer'),'the panel footer rule should exist, scoped');
});

test('every auto-fit grid can shrink to a 320px phone',()=>{
 // `minmax(330px,1fr)` locks the track: min(330px,100%) keeps the desktop look and fits a narrow phone.
 const offenders=[...clean.matchAll(/grid-template-columns:repeat\(auto-fit,minmax\((?!min\()\s*(\d+)px/g)].map(match=>match[0]);
 assert.deepEqual(offenders,[],'auto-fit tracks with a fixed floor overflow narrow screens');
 assert.ok(clean.includes('minmax(min(330px,100%)'),'the FAQ grid is the one that overflowed 320px');
});

test('the panel ships a phone drawer, and the drawer is real',()=>{
 for(const rule of ['.app .sidebar.open','.nav-backdrop','.mobile-bar','.mobile-bar-button'])
  assert.ok(selectors().some(selector=>selector.split(' ').join(' ').includes(rule))||clean.includes(rule),`src/style.css should define ${rule}`);
 assert.match(clean,/@media\(max-width:700px\)/,'the drawer breakpoint');
 assert.match(clean,/@media\(max-width:760px\)/,'the public-page breakpoint');
 assert.match(clean,/font-size:16px/,'inputs go to 16px on a phone or iOS zooms the page on focus');
 assert.match(clean,/env\(safe-area-inset/,'notches and home indicators');
 // and the classes the stylesheet asks for are actually rendered
 for(const token of ['mobile-bar','mobile-bar-button','nav-backdrop','sidebar'])
  assert.ok(main.includes(token),`src/main.tsx should render ${token}`);
 assert.match(main,/aria-label="Open the panel navigation"/,'the drawer handle is labelled for screen readers');
 assert.match(main,/aria-expanded=\{navOpen\}/,'the handle reports whether the drawer is open');
});

test('index.html carries the mark and the phone meta the pages rely on',()=>{
 assert.match(html,/rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
 assert.match(html,/rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
 assert.match(html,/name="theme-color" content="#0b0a0d"/);
 assert.match(html,/viewport-fit=cover/,'safe-area insets need the viewport opt-in');
 assert.match(html,/apple-mobile-web-app-title" content="SCOUT"/);
 // A favicon with the ✳ in it would be the old brand coming back.
 assert.equal(html.includes('✳'),false);
});
