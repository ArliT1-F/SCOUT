import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// The broadcast scenes are 1920 × 1080 graphics read from across a venue, not panel widgets. This
// guards the two ways that promise breaks silently, both seen in the wild:
//
//   1. a scene renders a class that src/style.css never defines — the element then inherits the
//      document's panel typography (13px), which is what "the letters are super small and it looks
//      weird" was: the round recap and the player statistics scenes had no rules at all;
//   2. a scene rule declares a size that is fine on a monitor but invisible in a broadcast frame.
//
// It parses the stylesheet the way tests/output-transparency.test.ts does, so a class that only
// exists in a comment or in the JSX does not count as styled.

const stage=await readFile(fileURLToPath(new URL('../src/stage.tsx',import.meta.url)),'utf8');
const css=await readFile(fileURLToPath(new URL('../src/style.css',import.meta.url)),'utf8');

// Every st-* token a rendered className actually mentions, from literals and template strings.
function classesRenderedByScenes():Set<string>{
 const used=new Set<string>();
 for(const match of stage.matchAll(/className=(?:"([^"]*)"|\{[^}]*?`([^`]*)`)/g)){
  const text=`${match[1]||''} ${match[2]||''}`;
  for(const token of text.matchAll(/\bst-[a-z0-9-]+/g)) used.add(token[0]);
 }
 return used;
}

type Rule={selector:string;declarations:string};
// Top-level rules only: a selector's own declarations are what a scene element reads, and nested
// @media blocks are the panel's, not the 1920 × 1080 canvas's — a font-size that only applies at
// 1500px is an operator-window size, not a broadcast one.
//
// Blocks are matched by counting braces, not by taking the first '}'. A declaration-less nesting
// like @keyframes st-blink{0%,100%{opacity:1}50%{opacity:.25}} closes twice, and the naive version
// swallowed the *next* rule's selector into the keyframes' leftovers — which is why this test used
// to depend on a duplicate .stage rule existing further down the file to prove the canvas is styled.
function stylesheetRules():Rule[]{
 const clean=css.replace(/\/\*[\s\S]*?\*\//g,'');
 const out:Rule[]=[];
 let cursor=0;
 while(cursor<clean.length){
  const open=clean.indexOf('{',cursor);
  if(open<0) break;
  // Skip statement at-rules (@import, @charset) so their text never leaks into a selector.
  const statement=clean.indexOf(';',cursor);
  if(statement>=0&&statement<open){cursor=statement+1;continue}
  const selector=clean.slice(cursor,open).trim();
  let depth=1,index=open+1;
  while(index<clean.length&&depth>0){const character=clean[index];if(character==='{') depth++;else if(character==='}') depth--;index++}
  const close=index-1;
  if(!selector.startsWith('@')) out.push({selector,declarations:clean.slice(open+1,close)});
  cursor=close+1;
 }
 return out;
}
const all=stylesheetRules();
const partsOf=(rule:Rule)=>rule.selector.split(',').map(part=>part.trim());
const rulesFor=(selector:string)=>all.filter(rule=>partsOf(rule).includes(selector));
const fontSizes=(rule:Rule)=>[...rule.declarations.matchAll(/(?:^|;)\s*font-size\s*:\s*([\d.]+)px/g)].map(match=>Number(match[1]));

test('every class the scenes render is styled by the stylesheet',()=>{
 const used=[...classesRenderedByScenes()];
 assert.ok(used.length>50,`expected the scenes to render many st-* classes, found ${used.length}`);
 assert.ok(all.some(rule=>rule.selector==='.stage'),'the stylesheet should still define the scene canvas');
 const unstyled=used.filter(name=>!all.some(rule=>partsOf(rule).some(part=>part.includes(`.${name}`))));
 assert.deepEqual(unstyled,[],`these scene classes have no CSS rule, so they fall back to 13px panel text: ${unstyled.join(', ')}`);
});

test('the round recap and player statistics scenes carry broadcast-sized text',()=>{
 // The headline, the two names on a kill row and the stat numbers are what a viewer reads; the panel's
 // own sizes (9–19px) are for an operator sitting 60cm from a monitor, not for a 1080p broadcast frame.
 const floors:Record<string,number>={
  '.st-recap-kicker':20,'.st-recap-winner h1':40,'.st-recap-winner small':20,'.st-recap-kill':32,
  '.st-recap-kill span':20,'.st-recap-kills>small':20,
  '.st-stats-title h1':56,'.st-stats-title small':20,'.st-stats-team h2':40,
  '.st-stat-row':36,'.st-stat-row b':28,'.st-stat-head':16,
 };
 for(const [selector,floor] of Object.entries(floors)){
  const sizes=rulesFor(selector).flatMap(fontSizes);
  assert.ok(sizes.length>0,`${selector} should declare a font-size in px`);
  assert.ok(Math.max(...sizes)>=floor,`${selector} is ${Math.max(...sizes)}px; a broadcast scene needs at least ${floor}px`);
 }
});

test('no scene rule shrinks text below the readable floor',()=>{
 // Sizes in em inherit from their sized parent (the bracket's LIVE tab), so only px is checked here.
 const offenders=all.filter(rule=>/\bst-/.test(rule.selector)&&fontSizes(rule).some(size=>size<12));
 assert.deepEqual(offenders.map(rule=>rule.selector),[],'scene text below 12px is unreadable on air');
});
