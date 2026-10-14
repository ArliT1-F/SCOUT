import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {Hud} from '../src/hud';
import {SceneStage} from '../src/stage';
import {demo} from '../src/demo';
import {SCENE_IDS,defaultControls} from '../server/controls';
import {DEFAULT_THEME,THEME_PRESETS,defaultOverlay,overlayThemeStyle,overlayWidgetSchema,widgetStyle} from '../server/overlay';
import {configSides} from '../server/sides';
import {normalizeConfig} from '../server/config';

// "Only the first overlay changed" is what the studio looked like while the full-canvas scenes
// carried their own palette: the live HUD read the theme tokens, the matchup, bracket, winner,
// break, recap and stats scenes read hard-coded magenta-era hexes, and the Overlay Studio promised
// the opposite ("Theme tokens update the real HUD and every full-screen broadcast scene").
//
// These tests hold the promise down without a browser: the stylesheet is parsed the way
// tests/scene-legibility.test.ts and tests/output-transparency.test.ts parse it, and the renderer is
// asked for the tokens it actually puts on the .hud root.

const css=await readFile(fileURLToPath(new URL('../src/style.css',import.meta.url)),'utf8');

type Rule={selector:string;declarations:string};
function stylesheetRules():Rule[]{
 const clean=css.replace(/\/\*[\s\S]*?\*\//g,'');
 const out:Rule[]=[];
 let cursor=0;
 while(cursor<clean.length){
  const open=clean.indexOf('{',cursor);
  if(open<0) break;
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
const rules=stylesheetRules();
const partsOf=(rule:Rule)=>rule.selector.split(',').map(part=>part.trim());
// A scene rule is anything that only exists inside the 1920 × 1080 canvas: the stage and the st-*
// graphics. The operator panel's own chrome (.preview-stage, .site-stage, .scene-art) is deliberately
// not themed by the broadcast palette.
const isSceneRule=(rule:Rule)=>partsOf(rule).some(part=>/^\.st-[a-z0-9-]+/.test(part)||/^\.stage(?:-|\b)/.test(part));
const isHudRule=(rule:Rule)=>partsOf(rule).some(part=>/^\.hud\b/.test(part)||/^\.(scoreboard|signal-lost|hud-banner|phase-banner|phase-card|round-result|kill|kill-weapon|player|lower-third|radar|radar-label|clock|roster-label|hud-event|hud-footer)/.test(part));
// Pure white or black at any opacity is theme-neutral: a 4% white surface reads as "raised" on any
// backdrop, and a black shadow is a shadow. Everything else has to come from the palette.
const neutral=/^#(?:f{3}|f{6}|0{3}|0{6})[0-9a-f]{0,2}$/i;
const paletteLiterals=(declarations:string):string[]=>{
 // var() fallbacks are the shipped default kept for a stylesheet used outside a themed .hud.
 const outside=declarations.replace(/var\([^()]*(?:\([^()]*\))?[^()]*\)/g,'var()');
 return [...new Set([...outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match=>match[0]))].filter(hex=>!neutral.test(hex));
};

test('every --theme-* token the stylesheet reads is one the theme provides',()=>{
 // A typo here is silent in CSS: the declaration is dropped and the surface falls back to its
 // var() default (or to nothing at all). The map is the contract.
 const referenced=new Set([...css.matchAll(/var\((--theme-[a-z0-9-]+)/g)].map(match=>match[1]));
 assert.ok(referenced.size>=20,`expected the stylesheet to read the theme tokens, found ${referenced.size}`);
 const provided=overlayThemeStyle(DEFAULT_THEME);
 const missing=[...referenced].filter(token=>!(token in provided));
 assert.deepEqual(missing,[],`these tokens are read by src/style.css but never set by overlayThemeStyle(): ${missing.join(', ')}`);
 for(const [token,value] of Object.entries(provided)) assert.ok(value!==undefined&&!String(value).includes('NaN'),`${token} resolved to ${value}`);
});

test('the full-canvas scenes paint from the palette, not from the default theme',()=>{
 const sceneRules=rules.filter(isSceneRule);
 assert.ok(sceneRules.length>100,`expected the scene stylesheet to be large, found ${sceneRules.length} rules`);
 const offenders=sceneRules.flatMap(rule=>paletteLiterals(rule.declarations).map(hex=>`${rule.selector} → ${hex}`));
 assert.deepEqual(offenders,[],`scene rules must read the theme tokens instead of pinning a palette colour:\n${offenders.join('\n')}`);
 // The scene canvas itself is the clearest case: its backdrop is the theme's panel shade.
 const stage=rules.find(rule=>partsOf(rule).includes('.stage'));
 assert.ok(stage,`expected a .stage rule`);
 assert.match(stage!.declarations,/background:radial-gradient\([^)]*var\(--theme-stage-glow/,'the scene backdrop glow must come from the theme accent');
 assert.match(stage!.declarations,/var\(--theme-panel-deep/,'the scene backdrop body must come from the theme panel');
 assert.match(stage!.declarations,/var\(--theme-panel-deeper/,'the scene backdrop floor must come from the theme panel');
 assert.match(stage!.declarations,/color:var\(--text/,'the scene type colour must come from the theme');
});

test('the live HUD surfaces are painted from the palette too',()=>{
 const painted=(selector:string,property:RegExp)=>rules.some(rule=>partsOf(rule).includes(selector)&&property.test(rule.declarations)&&isHudRule(rule));
 for(const surface of ['.scoreboard','.signal-lost','.hud-banner','.phase-banner','.round-result','.phase-card','.kill','.player','.lower-third','.radar'])
  assert.ok(painted(surface,/background(?:-color)?:\s*var\(--theme-panel/),`${surface} must take its fill from the theme's panel token`);
 for(const surface of ['.kill-weapon','.round-result b','.radar-label'])
  assert.ok(painted(surface,/background:\s*var\(--theme-panel-alt/),`${surface} must take its fill from the theme's raised-panel token`);
 for(const selector of ['.hud','.hud-event','.hud-footer','.player-meta','.lower-third small','.phase-card p','.round-result i','.clock span','.roster-label span','.hud-event b'])
  assert.ok(painted(selector,/color:\s*var\(--text/),`${selector} must take its type colour from the theme`);
});

test('the scene cards and their outlines paint from the palette, not from translucent white',()=>{
 // The reported bug, and the hole in the palette test above: the scene cards were painted
 // background:#ffffff0a with #ffffff1c outlines, which that test waved through as theme-neutral.
 // White at 4-5% composites to the same grey over every theme's backdrop, so a preset change
 // repainted the live scoreboard (a solid --theme-panel surface) and left matchup, lineups, map
 // series, bracket, winner, break, recap and stats looking frozen. The cards now read the derived
 // scene tokens the way .st-bm already did, and this test names the surfaces so it cannot regress
 // one scene at a time.
 const painted=(selector:string,property:RegExp)=>rules.some(rule=>partsOf(rule).includes(selector)&&property.test(rule.declarations)&&isSceneRule(rule));
 for(const surface of ['.st-mapchip','.st-player','.st-map','.st-next','.st-recap-winner','.st-recap-kill','.st-stats-team'])
  assert.ok(painted(surface,/background:\s*var\(--theme-card/),`${surface} must take its fill from the theme's scene-card token`);
 for(const surface of ['.st-bench span','.st-results span','.st-recap-kill span'])
  assert.ok(painted(surface,/background:\s*var\(--theme-raised/),`${surface} must take its fill from the theme's raised-card token`);
 for(const surface of ['.st-mapchip','.st-map','.st-bm','.st-next','.st-results span','.st-recap-winner','.st-recap-kill'])
  assert.ok(painted(surface,/border(?:-[a-z]+)?:\s*1px solid var\(--theme-card-line/),`${surface} must take its outline from the theme's card-line token`);
 // No scene surface or outline may pin a translucent white/black again. Opaque white stays legal
 // where it is lettering or a dot on an accent chip, and a declaration in a team's own colour
 // (.st-monogram's sheen over var(--team)) is team identity, not a scene surface.
 const surfaceProperty=/^(?:background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?)$/;
 const translucent=(hex:string)=>{const digits=hex.slice(1);return digits.length===8?digits.slice(6).toLowerCase()!=='ff':digits.length===4?digits.slice(3).toLowerCase()!=='f':false};
 const offenders=rules.filter(isSceneRule).flatMap(rule=>rule.declarations.split(';').flatMap(declaration=>{
  const [property,...rest]=declaration.split(':');
  if(!property||!rest.length||!surfaceProperty.test(property.trim())) return [];
  const value=rest.join(':');if(value.includes('var(--team)')) return [];
  const outside=value.replace(/var\([^()]*(?:\([^()]*\))?[^()]*\)/g,'var()');
  const hexes=[...outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match=>match[0]).filter(translucent);
  const whites=[...outside.matchAll(/rgba?\(\s*(?:255\s*,\s*255\s*,\s*255|0\s*,\s*0\s*,\s*0)\s*,\s*(?!1\s*\))/g)].map(match=>match[0]);
  return [...hexes,...whites].map(literal=>`${rule.selector} { ${property.trim()}: ${value.trim()} }`);
 }));
 assert.deepEqual(offenders,[],`scene surfaces must read the theme tokens instead of pinning a translucent neutral:\n${offenders.join('\n')}`);
});

test('scene surfaces stay opaque whatever the operator sets panel opacity to',()=>{
 // A HUD panel is translucent on purpose (panelOpacity). A scene *is* the frame for its duration:
 // if the derived scene tokens carried that opacity, the game capture would show through the
 // bracket, the winner card and the map tiles.
 const theme={...DEFAULT_THEME,panel:'#120e18',panelAlt:'#171021',panelOpacity:.55};
 const style=overlayThemeStyle(theme);
 assert.match(String(style['--theme-panel']),/rgba\(18,14,24,0\.55\)/,'HUD panels keep the operator’s opacity');
 for(const token of ['--theme-panel-solid','--theme-panel-deep','--theme-panel-deeper','--theme-stage-glow','--theme-map-tile-a','--theme-map-tile-b','--theme-card','--theme-raised','--theme-won','--theme-ink'])
  assert.match(String(style[token as keyof typeof style]),/^rgb\(\d+,\d+,\d+\)$/,`${token} must be an opaque scene surface`);
 for(const token of ['--theme-scrim','--theme-scrim-strong','--theme-accent-soft','--theme-accent-line','--theme-accent-glow','--theme-card-line'])
  assert.match(String(style[token as keyof typeof style]),/^rgba\(\d+,\d+,\d+,\d(?:\.\d+)?\)$/,`${token} is a scrim or tint, not a surface`);
});

test('HUD layers follow the theme unless the operator pins a value',()=>{
 // The shipped layer defaults used to be a pinned colour and face, written inline by widgetStyle —
 // inline beats the .hud rule, which is how a saved layer could ignore every later theme change.
 for(const widget of defaultOverlay().widgets){
  assert.equal(widget.color,null,`${widget.id} must not be born with a pinned colour`);
  assert.equal(widget.font,null,`${widget.id} must not be born with a pinned face`);
 }
 const free=widgetStyle(defaultOverlay().widgets[0]);
 assert.equal('color' in free,false,'an unpinned layer must inherit --text');
 assert.equal('fontFamily' in free,false,'an unpinned layer must inherit the display face');
 const pinned=widgetStyle({...defaultOverlay().widgets[0],color:'#8ad4ff',font:'Oswald'});
 assert.equal(pinned.color,'#8ad4ff');assert.equal(pinned.fontFamily,"'Oswald', sans-serif");
 // A config saved before the fix carries the old defaults verbatim; they now mean "follow".
 const legacy=overlayWidgetSchema.parse({id:'legacy',kind:'text',name:'Legacy',color:'#f2eef5',font:'Barlow Condensed'});
 assert.equal(legacy.color,null);assert.equal(legacy.font,null);
 const chosen=overlayWidgetSchema.parse({id:'chosen',kind:'text',name:'Chosen',color:'#8ad4ff',font:'Oswald'});
 assert.equal(chosen.color,'#8ad4ff');assert.equal(chosen.font,'Oswald');
});

test('a theme change moves the rendered layers, not just the surfaces around them',()=>{
 const config:any=normalizeConfig({event:{name:'Theme check'},format:'bo3',mr:12,otMr:3,
  teams:[{id:'a',name:'Alpha',tag:'ALP',color:'#3ba7ff',players:[]},{id:'b',name:'Bravo',tag:'BRV',color:'#ff9f43',players:[]}],
  maps:[{name:'de_inferno',pick:'A',status:'live'}]});
 const theme={...THEME_PRESETS.find(item=>item.preset==='arena-cobalt')!};
 const html=renderToString(createElement(Hud,{
  state:demo as any,controls:defaultControls,config,sides:configSides(config),
  overlay:{...defaultOverlay(),theme},lastSeen:Date.now(),now:Date.now(),signal:false,demoMode:true,
 } as any));
 assert.ok(html.includes('--theme-panel'),'the themed canvas is present');
 for(const layer of ['hud-event','scoreboard','hud-footer']){
  const withStyle=html.match(new RegExp(`class="[^"]*${layer}[^"]*" style="([^"]*)"`));
  assert.ok(!withStyle||!/(^|;)color:/.test(withStyle[1]),`${layer} still pins its colour inline and would ignore the theme`);
 }
});

test('a changed palette moves every derived scene surface',()=>{
 const scout=overlayThemeStyle(THEME_PRESETS[0]);
 const cobalt=overlayThemeStyle(THEME_PRESETS.find(theme=>theme.preset==='arena-cobalt')!);
 for(const token of ['--theme-panel-deep','--theme-panel-deeper','--theme-stage-glow','--theme-map-tile-a','--theme-map-tile-b','--theme-card','--theme-raised','--theme-card-line','--theme-won','--theme-ink','--theme-scrim','--theme-accent-soft','--theme-accent-line','--theme-accent-glow','--theme-panel-solid'])
  assert.notEqual(scout[token],cobalt[token],`${token} ignored the palette change`);
 // The derived shades keep the palette's hue: Cobalt's panel is blue, so its deepest surface is too.
 const deep=String(cobalt['--theme-panel-deep']).match(/\d+/g)!.map(Number);
 assert.ok(deep[2]>deep[0]&&deep[2]>deep[1],`the panel shade should stay blue, got ${cobalt['--theme-panel-deep']}`);
 assert.equal(overlayThemeStyle({...scout as any}).name,undefined,'the style map carries tokens only');
});

test('the scene entrances follow the theme motion profile',async()=>{
 // framer-motion never reads CSS, so the theme's motion token has to reach the scenes as a prop: the
 // stylesheet's data-motion rule can only stop the HUD's own keyframes.
 const config:any=normalizeConfig({event:{name:'Theme check'},format:'bo3',mr:12,otMr:3,
  teams:[{id:'a',name:'Alpha',tag:'ALP',color:'#d970c2',players:[]},{id:'b',name:'Bravo',tag:'BRV',color:'#e8c97e',players:[]}],
  maps:[{name:'de_inferno',pick:'A',status:'live'}]});
 for(const motion of ['cinematic','subtle','off'] as const){
  const html=renderToString(createElement(SceneStage,{scene:'matchup',config,swapped:false,players:[],nameOf:()=>'',breakEndsAt:null,now:Date.now(),motion} as any));
  assert.ok(html.includes('class="stage"')&&html.includes('st-head'),`the ${motion} profile still renders the whole scene`);
 }
 assert.match(await readFile(fileURLToPath(new URL('../src/hud.tsx',import.meta.url)),'utf8'),/motion=\{overlay\?\.theme\.motion\}/,'the HUD must hand the theme motion profile to SceneStage');
});

test('every scene renders inside the themed canvas',()=>{
 const config:any=normalizeConfig({event:{name:'Theme check',stage:'Grand final'},format:'bo3',mr:12,otMr:3,
  teams:[{id:'a',name:'Alpha',tag:'ALP',color:'#d970c2',players:[{name:'p1',steamid:'0'}]},{id:'b',name:'Bravo',tag:'BRV',color:'#e8c97e',players:[{name:'p2',steamid:'1'}]}],
  maps:[{name:'de_inferno',pick:'A',score:[8,6],status:'live'},{name:'de_nuke',pick:'decider',status:'upcoming'}]});
 const theme={...DEFAULT_THEME,panel:'#101726',accent:'#63a5ff',accentBright:'#b9d6ff',accentDeep:'#2865bd'};
 for(const scene of SCENE_IDS){
  const html=renderToString(createElement(Hud,{
   state:demo as any,controls:{...defaultControls,scene},config,sides:configSides(config),
   overlay:{...defaultOverlay(),theme},lastSeen:Date.now(),now:Date.now(),signal:false,demoMode:true,
  } as any));
  assert.ok(html.includes('--theme-stage-glow'),`${scene} must render inside the themed canvas`);
  assert.ok(html.includes('--theme-panel-deep'),`${scene} must carry the theme's scene surfaces`);
  assert.ok(html.includes('rgb(12,17,27)'),`${scene} must render its scene surfaces from the operator's panel colour`);
  if(scene==='live') assert.ok(html.includes('class="scoreboard"'),'live is still the in-game HUD');
  else assert.ok(html.includes('class="stage"'),`${scene} owns the full canvas`);
 }
});
