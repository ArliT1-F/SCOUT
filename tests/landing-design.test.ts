import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {LandingPage,SiteNav} from '../src/site';

const page=renderToString(createElement(LandingPage));
const css=await readFile(new URL('../src/landing.css',import.meta.url),'utf8');

test('the redesigned page preserves every shipped marketing image and map thumbnail',async()=>{
 const assets=['cs2.png','ak-47.png','cs2-t.png','cs2-ct.png','m4a1-s.png','oceanic-deag.png'];
 for(const asset of assets)assert.ok(page.includes(`/assets/${asset}`),asset);
 const images=[...page.matchAll(/src="(\/(?:assets|thumbs\/site)\/[^\"]+)"/g)];
 for(const [,path] of images)await access(new URL(`../public${path}`,import.meta.url));
 // The map showcase is a focused selection (four tiles + a reveal, INSTRUCTIONS 3.1), so the
 // rendered page shows four thumbs, not nine — the pool itself is checked against disk here.
 assert.ok(images.length>=10,'the real repository artwork is reused, not replaced by external stock');
 for(const file of ['de_ancient','de_anubis','de_dust2','de_inferno','de_mirage','de_nuke','de_overpass','de_train','de_vertigo'])
  await access(new URL(`../public/thumbs/site/${file}.jpg`,import.meta.url));
 assert.equal((page.match(/class="site-map-chip"/g)||[]).length,4,'four tiles by default');
 assert.match(page,/Show all nine maps/,'the rest of the pool is one click away');
});

test('the landing structure covers discovery, product, benefits, access, pricing and questions',()=>{
 for(const id of ['product','scenes','maps','benefits','beta','how','pricing','community','faq']){
  assert.equal((page.match(new RegExp(`id="${id}"`,'g'))??[]).length,1,`${id} has one unique anchor`);
 }
 assert.equal((page.match(/<h1\b/g)??[]).length,1,'there is one primary heading');
 assert.match(page,/href="#main-content"/);
 assert.match(page,/id="main-content" tabindex="-1"/);
 // The beta is still free, but the paid plans are published now: the landing page states the prices
 // and links the real pricing page instead of implying the product has no plans at all.
 assert.match(page,/href="\/pricing"/,'the landing page links the pricing page');
 assert.match(page,/€19\/month/,'the launch prices are stated where the beta offer is');
 assert.match(page,/Sample GSI feed/);
 assert.match(page,/before sharing customer stories/,'do not invent beta testimonials');
});

test('public navigation is an accessible disclosure with real page destinations',()=>{
 const nav=renderToString(createElement(SiteNav,{account:null}));
 assert.match(nav,/aria-label="Main navigation"/);
 assert.match(nav,/aria-expanded="false"/);
 assert.match(nav,/aria-label="Open navigation"/);
 const controls=nav.match(/aria-controls="([^"]+)"/)?.[1];
 assert.ok(controls&&nav.includes(`id="${controls}"`),'the mobile toggle names the actual navigation');
 assert.match(nav,/href="\/pricing"/,'pricing has its own page, not only an anchor on the landing page');
 assert.match(nav,/href="\/apply"/);
 assert.match(nav,/href="\/login"/);
});

test('motion is progressive and reduced-motion users never lose content',()=>{
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(css,/\.landing \.reveal-ready\{opacity:1;translate:none\}/);
 assert.match(css,/\.landing :is\(a,button,summary\):focus-visible/);
 assert.match(css,/@media\(max-width:359px\)/,'layout supports the narrowest phone width');
 assert.ok(!/(?:^|\})\s*(?:html|body|:root)\s*\{[^}]*background/m.test(css),'marketing backgrounds do not leak onto OBS output');
});

test('production typography is local, licensed and preloaded',async()=>{
 const globalCss=await readFile(new URL('../src/style.css',import.meta.url),'utf8');
 const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
 assert.ok(!globalCss.includes('fonts.googleapis.com'));
 assert.match(index,/rel="preload" href="\/fonts\/dm-sans-latin-variable.woff2"/);
 for(const font of [...globalCss.matchAll(/url\('\/fonts\/([^']+)'\)/g)])await access(new URL(`../public/fonts/${font[1]}`,import.meta.url));
 for(const licence of ['OFL-DM-Sans.txt','OFL-Barlow-Condensed.txt'])await access(new URL(`../public/fonts/${licence}`,import.meta.url));
});
