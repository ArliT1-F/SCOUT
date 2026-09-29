import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// OBS composites the browser source over the game capture. A background on the root element is
// propagated to the whole document canvas, which paints an opaque frame and hides the gameplay —
// so the output routes must never let <html> or <body> carry a background of their own.
const css=await readFile(fileURLToPath(new URL('../src/style.css',import.meta.url)),'utf8');
const entry=await readFile(fileURLToPath(new URL('../src/main.tsx',import.meta.url)),'utf8');

type Rule={selector:string;declarations:string};
function closingBrace(text:string,open:number):number{let depth=0;for(let i=open;i<text.length;i++){if(text[i]==='{')depth++;else if(text[i]==='}'&&--depth===0)return i}return text.length}
function collect(text:string,start=0,end=text.length,out:Rule[]=[]):Rule[]{
 let cursor=start;
 while(cursor<end){
  const open=text.indexOf('{',cursor);
  if(open<0||open>=end)break;
  // Skip statement at-rules (@import, @tailwind, @charset) so their text never leaks into a selector.
  const statement=text.indexOf(';',cursor);
  if(statement>=0&&statement<open){cursor=statement+1;continue}
  const close=closingBrace(text,open);
  const selector=text.slice(cursor,open).trim();
  if(selector.startsWith('@'))collect(text,open+1,close,out); // descend into @media and friends
  else out.push({selector,declarations:text.slice(open+1,close)});
  cursor=close+1;
 }
 return out;
}
const rules=collect(css.replace(/\/\*[\s\S]*?\*\//g,'')); // comments would pollute selector slices
const parts=(rule:Rule)=>rule.selector.split(',').map(part=>part.trim());
const declarations=(rule:Rule,prefix:string)=>rule.declarations.split(';').map(d=>d.trim()).filter(d=>d.startsWith(prefix));
const backgrounds=(rule:Rule)=>[...declarations(rule,'background:'),...declarations(rule,'background-color:')];
const hitsRoot=(rule:Rule)=>parts(rule).some(part=>/^(html|:root)\b/.test(part));
const hitsBody=(rule:Rule)=>parts(rule).some(part=>/^body\b/.test(part));

test('no rule paints a background on the html/:root canvas',()=>{
 const painted=rules.filter(rule=>hitsRoot(rule)&&backgrounds(rule).some(d=>!/transparent/i.test(d)));
 assert.deepEqual(painted.map(rule=>`${rule.selector}{${backgrounds(rule).join(';')}}`),[],'<html> background propagates to the OBS canvas and hides the game capture');
 assert.ok(rules.some(rule=>parts(rule).includes('html')&&backgrounds(rule).some(d=>/transparent/i.test(d))),'expected an explicit html{background:transparent} guard');
});

test('the dark operator-panel background is scoped away from the output routes',()=>{
 // The exact hex is the theme's near-black (#0b0a0d); what matters is where it may be painted.
 const panel=rules.filter(rule=>backgrounds(rule).some(d=>/#0b0a0d/i.test(d)));
 assert.equal(panel.length,1,'exactly one rule should paint the panel background');
 assert.ok(hitsBody(panel[0])&&!hitsRoot(panel[0]),`panel background must live on <body>, not the canvas: ${panel[0].selector}`);
 assert.match(panel[0].selector,/:not\(\.output-body\)/,`panel background must not apply to the output body: ${panel[0].selector}`);
});

test('output html and body classes force transparency over any competing rule',()=>{
 for(const selector of ['.output-body','html.output-root']){
  const rule=rules.find(candidate=>parts(candidate).includes(selector));
  assert.ok(rule,`missing ${selector} rule`);
  assert.ok(backgrounds(rule!).some(d=>/transparent\s*!important/i.test(d)),`${selector} must force a transparent background`);
 }
});

test('the transparency checker is opt-in and painted behind the canvas, not on the document',()=>{
 const checker=rules.find(rule=>rule.selector.includes('.checker-backdrop'));
 assert.ok(checker,'expected a .checker-backdrop rule for /obs?checker=1');
 assert.match(checker!.declarations,/z-index:\s*-1/,'checkerboard must sit behind the HUD canvas');
 assert.ok(!backgrounds(checker!).some(d=>/!important/.test(d)),'checkerboard must not override the transparent document');
 assert.match(entry,/showChecker=isOutputRoute&&new URLSearchParams\(location\.search\)\.get\('checker'\)==='1'/,'checkerboard only renders on an output route with the explicit flag');
});

test('output routes are tagged transparent before the first paint',()=>{
 const guard=/if\(isOutputRoute\)\s*\{[^}]*documentElement\.classList\.add\('output-root'\)[^}]*\}/.exec(entry);
 assert.ok(guard,'main.tsx must tag <html> for the output routes at module scope');
 assert.ok(/body\??\.classList\.add\('output-body'\)/.test(guard![0]),'the module-scope tag must cover <body> too');
 assert.ok(entry.indexOf('createRoot(document')>guard!.index,'tagging after mount leaves an opaque first frame in OBS');
 assert.ok(entry.includes('if(isOutputRoute)return <Output'),'/obs and /game must render the shared Output renderer');
});
