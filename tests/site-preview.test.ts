import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {LandingPage} from '../src/site';
import {HudStage} from '../src/showcase';
import {SCENE_IDS,SCENE_TITLES} from '../server/controls';
import {SCENE_LIST,PANEL_SECTIONS} from '../src/panel-catalog';
import {DEFAULT_WIDGETS} from '../server/overlay';

// The product page makes one promise that a test can hold it to: the frames on it are the product.
// They are rendered by src/showcase, which mounts the same `Hud` component the operator panel
// previews and the /obs output plays, so the page cannot drift away from what SCOUT looks like —
// no hand-drawn HUD, no invented teams, no scene list that describes a product nobody has. These
// tests render the page (and every scene behind its picker) to HTML and check exactly that.

const page=renderToString(createElement(LandingPage));

test('the landing page is drawn by the overlay itself, not by a picture of it',()=>{
 assert.match(page,/class="hud /,'the page mounts the same .hud root the broadcast output uses');
 assert.match(page,/class="scoreboard"/,'the live HUD scoreboard is the real one');
 assert.match(page,/class="radar with-image"/,'the radar draws the shipped overview, not a placeholder');
 assert.match(page,/class="killfeed"/,'the killfeed comes from server-derived events');
 assert.match(page,/class="roster roster-0"/,'the rosters are the product-built ones');
 assert.match(page,/DEMO FEED/,'a sample feed says that it is a sample feed');
 assert.match(page,/Vertex/);assert.match(page,/Parallax/);
 // The placeholder HUD this page used to draw named NAVI, Vitality and a pair of star players.
 for(const invented of ['NAVI','VITALITY','s1mple','ZywOo','MR12']) assert.equal(page.includes(invented),false,`the page must not invent a broadcast: ${invented}`);
});

test('every scene the tour offers is a scene the product renders',()=>{
 assert.deepEqual(SCENE_LIST.map(scene=>scene.id),[...SCENE_IDS],'the page lists the host scenes, in the host order');
 for(const scene of SCENE_IDS){
  assert.equal(page.includes(`>${SCENE_TITLES[scene]}<`),true,`${SCENE_TITLES[scene]} is offered by name`);
  const html=renderToString(createElement(HudStage,{scene}));
  assert.ok(html.includes('class="hud'),`${scene} renders through the overlay renderer`);
  if(scene==='live'){
   assert.ok(html.includes('scoreboard')&&html.includes('roster'),'the live scene is the in-game HUD');
  }else{
   assert.ok(html.includes('class="stage')&&html.includes('st-head')&&html.includes('st-foot'),`${scene} owns the full canvas`);
  }
 }
 // Each scene also has something to show, which is the point of previewing it at all.
 assert.ok(renderToString(createElement(HudStage,{scene:'matchup'})).includes('/thumbs/de_mirage.png'),'the matchup shows the shipped map pictures');
 assert.ok(renderToString(createElement(HudStage,{scene:'winner'})).includes('Series winners'),'the winner scene celebrates a finished series');
 assert.ok(renderToString(createElement(HudStage,{scene:'break'})).includes('st-countdown'),'the break scene runs the operator timer');
 assert.ok(renderToString(createElement(HudStage,{scene:'recap'})).includes('st-recap-winner'),'the recap shows a confirmed round result');
 assert.ok(renderToString(createElement(HudStage,{scene:'stats'})).includes('st-stat-row'),'the stats scene lists live K / D / A');
});

test('the hero says what an applicant needs on the same line as the call to action',()=>{
 const hero=page.slice(page.indexOf('site-hero'),page.indexOf('site-strip'));
 for(const need of ['Windows 10 or 11','Counter-Strike 2','OBS Studio','bundles its own runtime']) assert.ok(hero.includes(need),`the hero states: ${need}`);
 assert.ok(hero.indexOf('site-cta')<hero.indexOf('site-requirements'),'the requirements sit under the buttons, not somewhere else on the page');
});

test('the sections and layer names on the page are the panel’s own',()=>{
 // React escapes the ampersand in names like "Teams & players"; compare the text as rendered.
 const escaped=(text:string)=>text.replace(/&/g,'&amp;');
 for(const section of PANEL_SECTIONS) assert.ok(page.includes(escaped(section.name)),`the panel has a ${section.name} section, so the page may name it`);
 for(const widget of DEFAULT_WIDGETS.filter(widget=>widget.showOn.includes('live'))) assert.ok(page.includes(widget.name),`the live HUD layer ${widget.name} is named the way the Overlay Studio names it`);
});

test('the map pool is one strip of the nine shipped pictures',()=>{
 const maps=page.slice(page.indexOf('site-map-strip'),page.indexOf('site-section" id="beta"'));
 assert.equal((maps.match(/class="site-map-chip"/g)||[]).length,9,'nine tiles, one strip — the pool is a checklist, not a feature');
 for(const file of ['de_ancient','de_anubis','de_dust2','de_inferno','de_mirage','de_nuke','de_overpass','de_train','de_vertigo']) assert.ok(maps.includes(`/thumbs/site/${file}.jpg`),file);
});

test('the engineering detail sits below the product story',()=>{
 const order=['id="product"','id="scenes"','id="maps"','id="beta"','id="how"','id="faq"'];
 let cursor=-1;
 for(const marker of order){
  const at=page.indexOf(marker);
  assert.ok(at>0,`${marker} exists`);
  assert.ok(at>cursor,`${marker} comes after the section before it`);
  cursor=at;
 }
 const hood=page.slice(page.indexOf('UNDER THE HOOD'));
 for(const detail of ['GSI only, by architecture','no memory reading','1920 × 1080','no custom CSS','obs-websocket','config/radars.json','control lease']) assert.ok(hood.includes(detail),`the technical claim lives under the hood: ${detail}`);
});
