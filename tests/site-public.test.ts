import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {ANALYTICS_EVENT_ALLOWLIST,LandingPage,ApplyPage,DownloadPage,PAGE_META,PrivacyPage,SITE_ROUTES,validateApplication} from '../src/site';

// Phase 1 (INSTRUCTIONS 3.1–3.6): the public pages say the right thing, private pages stay out of
// search indexes, the application form validates like the server and reports errors accessibly, and
// the privacy page is the honest analytics policy — no third-party trackers, an explicit first-party
// event allowlist, and nothing collected that is not on it.

const clean=(html:string)=>html.replace(/<!-- -->/g,'');

test('every site route has document metadata, and only public pages may be indexed',()=>{
 assert.deepEqual(Object.keys(PAGE_META).sort(),[...SITE_ROUTES].sort(),'the metadata map covers the router exactly');
 for(const route of SITE_ROUTES){
  const meta=PAGE_META[route];
  assert.ok(meta.title.length>0&&meta.description.length>0,route);
  assert.ok(meta.robots==='index, follow'||meta.robots==='noindex, follow',route);
 }
 for(const route of ['/welcome','/apply','/privacy'] as const)assert.equal(PAGE_META[route].robots,'index, follow',`${route} is a public page`);
 for(const route of ['/login','/download','/profile'] as const)assert.equal(PAGE_META[route].robots,'noindex, follow',`${route} is account state and must not be indexed`);
});

test('the landing hero carries the recommended message and CTAs that lead somewhere real',()=>{
 const html=clean(renderToString(createElement(LandingPage)));
 assert.match(html,/A better broadcast for every CS2 tournament/,'the recommended primary message is on the first screen');
 assert.match(html,/Join the Closed Beta/,'the primary action names the closed beta');
 assert.match(html,/href="\/apply"/);
 assert.match(html,/href="#scenes"/,'the demo link jumps to the real scene tour, not a dead video');
 assert.match(html,/Windows 10 or 11/,'requirements are stated accurately');
 // The scene tour is rendered by the product's own renderer (tests/site-preview.test.ts); the page
 // must not advertise a recorded demo it does not have.
 assert.equal(html.includes('Watch demo'),false);
});

test('the application form validates like the server and reports errors accessibly',()=>{
 assert.deepEqual(validateApplication({name:'Ada',email:'ada@example.com',organisation:'',country:'',useCase:'cups',events:'Monthly'}),{});
 assert.deepEqual(validateApplication({name:'',email:'nope',organisation:'',country:'',useCase:'',events:'Monthly'}),{name:'Enter the name we should put on the application.',email:'Enter a valid email address — the invite link goes there.'});
 assert.deepEqual(validateApplication({name:'  A  ',email:'a@b.co',organisation:'',country:'',useCase:'',events:'Monthly'}),{name:'Enter the name we should put on the application.'},'the name rule mirrors server/beta.ts (≥ 2 characters)');
 const html=clean(renderToString(createElement(ApplyPage)));
 assert.match(html,/novalidate/,'the form owns its messages instead of browser bubbles');
 assert.match(html,/required/,'screen readers hear that name and email are required');
 assert.match(html,/aria-describedby="apply-usecase-hint"/,'optional fields explain themselves');
 assert.match(html,/Send application/);
});

test('the download page never advertises the host-only app dashboard',()=>{
 // /app 404s on the public website (server/surface.ts). The link is gated on /api/surface at run
 // time; server-rendered markup must never carry it unconditionally.
 const html=clean(renderToString(createElement(DownloadPage)));
 assert.equal(html.includes('href="/app"'),false,'the website links only pages that exist on the website');
});

test('the privacy page is the analytics contract: allowlisted events, no third-party trackers',()=>{
 const html=clean(renderToString(createElement(PrivacyPage)));
 assert.match(html,/No third-party trackers/);
 assert.match(html,/never leave/i,'the local-first promise is explicit');
 assert.match(html,/Deletion/i,'deletion is explained');
 assert.match(html,/Retention/i,'retention is explained');
 for(const row of ANALYTICS_EVENT_ALLOWLIST){
  assert.ok(html.includes(row.event),`${row.event} is documented`);
  assert.equal(row.collected,false,`${row.event} is not collected while no analytics backend exists — flip this only with the backend`);
 }
 assert.match(html,/not collected/);
});

test('index.html ships social metadata and public indexing defaults',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/property="og:title"/);
 assert.match(html,/property="og:description"/);
 assert.match(html,/property="og:image" content="\/logo\/scout-tile.png"/);
 assert.match(html,/name="twitter:card" content="summary"/);
 assert.match(html,/name="robots" content="index, follow"/,'the public shell is indexable by default; private routes flip this client-side');
 assert.match(html,/rel="canonical"/);
 assert.match(html,/rel="icon" href="\/favicon\.svg"/);
});
