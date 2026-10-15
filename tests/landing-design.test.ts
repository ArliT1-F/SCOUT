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
 assert.ok(images.length>=15,'the real repository artwork is reused, not replaced by external stock');
});

test('the landing structure covers discovery, product, benefits, access, pricing and questions',()=>{
 for(const id of ['product','scenes','maps','benefits','beta','how','pricing','community','faq']){
  assert.equal((page.match(new RegExp(`id="${id}"`,'g'))??[]).length,1,`${id} has one unique anchor`);
 }
 assert.equal((page.match(/<h1\b/g)??[]).length,1,'there is one primary heading');
 assert.match(page,/href="#main-content"/);
 assert.match(page,/id="main-content" tabindex="-1"/);
 assert.match(page,/No paid plans are currently offered/);
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
 assert.match(nav,/href="\/welcome#pricing"/);
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

// ------------------------------------------------------------------ the five restraint rules
// The page can oversell in ways no screenshot review catches: copy that shrinks to 6px on a phone,
// tiles that look like buttons, an engineering section that outshouts the product, and — the worst
// one — a testimonial nobody gave. Each rule below is cheap to state and cheap to break, so each
// gets a test.
const SUPPORTING_COPY=['.site-card p','.site-section-head p','.landing-benefit p','.site-step p','.site-faq p','.landing-feedback p','.site-final p','.landing-price>p','.site-beta-cta p','.site-panel-map p','.site-host-card p','.site-layers>small','.site-how-card p','.landing-proof-real>small','.site-footer-brand p'];
const DECORATIVE_TINY=['.site-footer-cols b','.site-map-chip small','.site-requirements-label','.site-section-eyebrow','.landing-benefit-art>span','.landing-live','.landing-preview-bar','.landing-price-badge','.landing-price-top','.landing-proof>p','.landing-scroll'];

test('supporting copy keeps a reading size at every breakpoint, and tiny type is decorative only',()=>{
 for(const [,selector,body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  const size=body.match(/font-size:([\d.]+)px/);
  if(!size)continue;
  const px=Number(size[1]);
  for(const part of selector.split(',')){
   const sel=part.trim().replace(/^\.landing\s+/,'');
   if(SUPPORTING_COPY.includes(sel))assert.ok(px>=11,`${sel} reads at ${px}px — supporting copy keeps a floor of 11px`);
   if(px<9)assert.ok(DECORATIVE_TINY.some(decorative=>part.includes(decorative)),`${sel} sets ${px}px — type under 9px is for uppercase decoration and window chrome only`);
  }
 }
});

test('the map tiles are pictures with a chosen crop, not buttons with an arrow',()=>{
 const maps=page.slice(page.indexOf('site-map-strip'),page.indexOf('site-section landing-benefits'));
 assert.equal((maps.match(/class="site-map-chip"/g)??[]).length,9);
 assert.equal(maps.includes('<svg'),false,'a tile that does nothing must not carry an affordance');
 const chips=[...maps.matchAll(/<figure class="site-map-chip"[\s\S]*?<\/figure>/g)];
 assert.equal(chips.length,9);
 for(const [chip] of chips)assert.match(chip,/style="object-position:50% \d+%"/,'each tile names the band of the picture it shows');
 assert.match(css,/\.landing \.site-map-chip\{[^}]*aspect-ratio:/);
 assert.equal(/\.site-map-chip:hover\{[^}]*transform/.test(css),false,'no lift on hover: nothing happens when you press a tile');
 assert.match(css,/\.landing \.site-map-chip b\{[^}]*text-shadow/,'the label keeps its contrast over the picture');
 assert.match(css,/\.landing \.site-map-chip::after\{[^}]*linear-gradient/,'a scrim sits under the label');
});

test('under the hood leads with three answers and folds the rest into one disclosure',()=>{
 const hood=page.slice(page.indexOf('id="how"'),page.indexOf('id="pricing"'));
 const open=hood.indexOf('<details class="site-how-more"');
 assert.ok(open>0,'the deeper detail is expandable');
 const highlights=['GSI only, by architecture','Wired into OBS, not into the game','Several operators, one broadcast'];
 const deeper=['Radar calibration per map','Recording, archives and replay','Inside the operator panel'];
 for(const title of highlights){const at=hood.indexOf(title);assert.ok(at>0&&at<open,`${title} leads, above the disclosure`)}
 for(const title of deeper){const at=hood.indexOf(title);assert.ok(at>open,`${title} waits inside the disclosure`)}
 assert.equal((hood.match(/class="site-card site-how-card"/g)??[]).length,5,'three highlights plus two deeper cards, nothing more');
});

test('broadcast proof is opt-in: nothing publishes without a consented file a human wrote',async()=>{
 assert.equal(page.includes('landing-proof-real'),false,'the server-rendered page invents no proof');
 assert.match(page,/before sharing customer stories/);
 const site=await readFile(new URL('../src/site.tsx',import.meta.url),'utf8');
 assert.match(site,/fetch\('\/proof\/proof\.json'/,'proof comes from a file on the same origin, not from a hard-coded cloud');
 assert.match(site,/consent===true/,'an entry without recorded consent is skipped');
 const example=JSON.parse(await readFile(new URL('../public/proof/proof.example.json',import.meta.url),'utf8'));
 for(const entry of example.entries)assert.equal(entry.consent,false,'the shipped template cannot publish its placeholders');
 const readme=await readFile(new URL('../public/proof/README.txt',import.meta.url),'utf8');
 assert.match(readme,/consent/i,'the folder explains who may put proof on the page');
});
