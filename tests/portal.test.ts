import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PORTAL_MAX_PER_WINDOW,PORTAL_MIN_GAP_MS,PORTAL_TTL_MS,PortalStore,normalizeSubmission,safeSocial} from '../server/portal.js';

// Team portal: the link is the credential. These tests pin the parts that matter when a link leaks —
// expiry, revocation, rate limits, and the fact that nothing a captain types is trusted as a URL.
const T0=1_700_000_000_000;
const file=async()=>join(await mkdtemp(join(tmpdir(),'scout-portal-')),'links.json');
const roster=(over:Record<string,unknown>={})=>({teamName:'Nova Esports',tag:'NOV',logo:'',socials:{x:'@nova',twitch:'',website:'',discord:''},players:[{nickname:'s1mple',role:'AWPer',steamid:''},{nickname:'b1t',role:'Rifler',steamid:''}],note:'',...over});

test('a link is scoped to one team, expires, and can be revoked',async()=>{
 const store=await new PortalStore(await file()).load();
 const created=await store.create({teamId:'t1',eventId:'evt_1',label:'Nova'},T0);
 assert.match(created.url,/^\/portal\/[A-Za-z0-9_-]{32}$/);
 const resolved=store.resolve(created.token,T0+1000);
 assert.equal(resolved?.status,'active');
 assert.equal(resolved?.teamId,'t1');
 assert.equal(store.resolve(created.token,T0+PORTAL_TTL_MS+1)?.status,'expired');
 await store.revoke(created.link.id,T0+2000);
 assert.equal(store.resolve(created.token,T0+3000)?.status,'revoked');
 assert.equal(store.resolve('not-a-token',T0),null);
});

test('rotating a link stops the old one immediately',async()=>{
 const store=await new PortalStore(await file()).load();
 const created=await store.create({teamId:'t1',eventId:'evt_1',label:'Nova'},T0);
 const rotated=await store.rotate(created.link.id,T0+10);
 assert.ok(rotated);
 assert.notEqual(rotated!.token,created.token);
 assert.equal(store.resolve(created.token,T0+20),null,'the link sent to the wrong captain must die');
 assert.equal(store.resolve(rotated!.token,T0+20)?.status,'active');
});

test('submitting is rate-limited per link, with a retry hint',async()=>{
 const store=await new PortalStore(await file()).load();
 const created=await store.create({teamId:'t1',eventId:'evt_1',label:'Nova'},T0);
 const first=await store.submit(created.token,roster(),T0+1000);
 assert.equal(first.ok,true);
 const quick=await store.submit(created.token,roster(),T0+1000+PORTAL_MIN_GAP_MS-1);
 assert.equal(quick.ok,false);
 assert.equal(quick.ok===false?quick.reason:'','too-soon');
 let now=T0+1000;
 for(let index=0;index<PORTAL_MAX_PER_WINDOW;index++){now+=PORTAL_MIN_GAP_MS;await store.submit(created.token,roster({teamName:`Nova ${index}`}),now)}
 const blocked=await store.submit(created.token,roster(),now+PORTAL_MIN_GAP_MS);
 assert.equal(blocked.ok,false);
 assert.equal(blocked.ok===false?blocked.reason:'','rate-limited');
 const retry=blocked.ok===false?blocked.retryAfterMs??0:0;
 assert.ok(retry>0,'the page shows a retry time instead of a dead button');
});

test('a resubmission replaces the previous pending version',async()=>{
 const store=await new PortalStore(await file()).load();
 const created=await store.create({teamId:'t1',eventId:'evt_1',label:'Nova'},T0);
 await store.submit(created.token,roster({teamName:'Nova One'}),T0+1000);
 await store.submit(created.token,roster({teamName:'Nova Two'}),T0+1000+PORTAL_MIN_GAP_MS);
 const queue=store.queue();
 assert.equal(queue.length,1,'one row in the approval queue, not two');
 assert.equal(queue[0].payload.teamName,'Nova Two');
});

test('an operator decision is recorded once and a second approval does not overwrite it',async()=>{
 const store=await new PortalStore(await file()).load();
 const created=await store.create({teamId:'t1',eventId:'evt_1',label:'Nova'},T0);
 const submitted=await store.submit(created.token,roster(),T0+1000);
 assert.ok(submitted.ok);
 const id=(submitted as any).submission.id as string;
 const approved=await store.review(created.link.id,id,'approved','owner',T0+2000);
 assert.equal(approved?.status,'approved');
 assert.equal(approved?.reviewedBy,'owner');
 await store.submit(created.token,roster({teamName:'Nova Again'}),T0+1000+PORTAL_MIN_GAP_MS);
 const queue=store.queue();
 assert.equal(queue.length,1,'a new submission after an approval is still reviewable');
 await store.review(created.link.id,id,'rejected','owner',T0+3000);
 assert.equal(store.queue().length,1,'re-reviewing the approved version must not touch the newer one');
});

test('nothing a captain types becomes a link unless it is http(s)',()=>{
 assert.equal(safeSocial('javascript:alert(1)'),'');
 assert.equal(safeSocial('data:text/html,<script>'),'');
 assert.equal(safeSocial('@nova'),'@nova','a handle stays text');
 assert.equal(safeSocial('https://x.com/nova'),'https://x.com/nova');
 const normalized=normalizeSubmission(roster({logo:'javascript:alert(1)',socials:{x:'https://x.com/nova',twitch:'javascript:x',website:'',discord:''}}));
 assert.equal(normalized?.logo,'');
 assert.equal(normalized?.socials.twitch,'');
 assert.equal(normalized?.socials.x,'https://x.com/nova');
});

test('malformed rosters are refused rather than half-accepted',()=>{
 assert.equal(normalizeSubmission({teamName:'N',players:[]}),null,'at least one player');
 assert.equal(normalizeSubmission({teamName:'Nova',players:[{nickname:''}]}),null,'a blank name is not a player');
 assert.equal(normalizeSubmission({teamName:'Nova',players:Array.from({length:11},(_,index)=>({nickname:`p${index}`}))}),null,'ten players is the ceiling');
 assert.ok(normalizeSubmission(roster()));
});

test('links survive a restart and never keep a revoked state in memory only',async()=>{
 const path=await file();
 const first=await new PortalStore(path).load();
 const created=await first.create({teamId:'t1',eventId:'evt_1',label:'Nova'},T0);
 await first.submit(created.token,roster(),T0+1000);
 await first.revoke(created.link.id,T0+5000);
 const second=await new PortalStore(path).load();
 const resolved=second.resolve(created.token,T0+6000);
 assert.equal(resolved?.status,'revoked');
 assert.equal(second.list().length,1);
});
