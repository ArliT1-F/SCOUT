import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {surfaceFromEnv,websitePathAllowed} from '../server/surface.js';
import {DEFAULT_PLATFORM_SETTINGS,sanitizeSettings} from '../server/platform.js';
import {MatchEditor} from '../src/admin.js';
import {ProfilePage,SiteFooter,isSiteRoute} from '../src/site.js';
import {platformHost,hostConfig} from './helpers/platform-host.js';
import {createAccountService} from '../server/account-service.js';

test('website boundary allows account/owner/device sync but not broadcast controls',()=>{
 assert.equal(surfaceFromEnv({}),'host');assert.equal(surfaceFromEnv({SCOUT_SURFACE:'site'}),'site');
 assert.throws(()=>surfaceFromEnv({SCOUT_SURFACE:'typo'}));
 for(const route of ['/profile','/admin','/api/beta/apply','/api/beta/device/approve','/api/platform/admin/settings','/api/platform/device/sync'])assert.equal(websitePathAllowed(route),true,route);
 for(const route of ['/app','/panel/','/obs','/game','/gsi','/ws','/api/config','/api/status','/api/upload','/api/session','/api/beta/link/start','/api/beta/license','/api/platform/tournaments'])assert.equal(websitePathAllowed(route),false,route);
});

test('real website redirects root, serves profile/admin, refuses host pages and mutations',async(t)=>{
 // The "real website" serves the production build (dist/). On a clean checkout `npm test` can run
 // before `npm run build` ever did, and every page 500s for missing assets — build once on demand
 // so the suite is self-contained instead of order-dependent (Phase 0 finding D1).
 if(!existsSync('dist/index.html')){
  const built=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{encoding:'utf8'});
  assert.equal(built.status,0,`surface test needs the production build and it failed:\n${built.stderr||built.stdout}`);
 }
 const site=await platformHost(t,{SCOUT_SURFACE:'site'});
 const root=await fetch(site.url+'/',{redirect:'manual'});assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/welcome');
 assert.deepEqual((await site.request('/api/surface')).body,{surface:'site'});
 for(const route of ['/profile','/admin','/welcome'])assert.equal((await site.request(route)).status,200,route);
 for(const route of ['/app','/panel/','/obs','/game','/api/config','/api/session'])assert.equal((await site.request(route)).status,404,route);
 assert.equal((await site.request('/gsi',{player:{}})).status,404);
 assert.equal((await site.request('/api/config',hostConfig(),{method:'PUT'})).status,404);
 assert.equal((await site.request('/api/beta/status')).status,200);
 assert.equal((await site.request('/api/platform/admin')).status,401);
 const host=await platformHost(t);
 assert.equal((await host.request('/api/config')).status,200);
 assert.deepEqual((await host.request('/api/surface')).body,{surface:'host'});
 assert.notEqual((await host.request('/API/config',hostConfig(),{method:'PUT'})).status,200,'case aliases must never bypass the operator gate');
});

test('rotation updates are versioned, deduplicated and reject unsafe/empty data',()=>{
 const next=sanitizeSettings({mapRotation:['de_train','de_mirage','de_train']},DEFAULT_PLATFORM_SETTINGS,'owner',100);
 assert.deepEqual(next.mapRotation,['de_train','de_mirage']);assert.equal(next.version,2);
 for(const mapRotation of [[],['../../x'],['https://evil.test'],[null]])assert.deepEqual(sanitizeSettings({mapRotation:mapRotation as any},next,'owner').mapRotation,next.mapRotation);
 assert.deepEqual(sanitizeSettings({reviewNote:'New wave'},next,'owner').mapRotation,next.mapRotation);
 const reviewerSettings=sanitizeSettings({betaReviewers:[' Reviewer@Example.com ','reviewer@example.com','not-an-email','other@example.org']},next,'owner');
 assert.deepEqual(reviewerSettings.betaReviewers,['reviewer@example.com','other@example.org'],'review roles are normalized, deduplicated and validated');
});

test('host map picker offers current rotation but keeps a map already in the series',()=>{
 const html=renderToString(createElement(MatchEditor,{config:hostConfig(),mapRotation:['de_train'],onChange:()=>{}}));
 assert.match(html.replace(/<!--.*?-->/g,''),/de_mirage \(outside current rotation\)/);assert.match(html,/value="de_train"/);
 assert.doesNotMatch(html,/value="de_dust2"/);assert.doesNotMatch(html,/<input list=/);
});

test('website has a profile, not links to broadcast output or local panel',()=>{
 assert.equal(isSiteRoute('/profile'),true);assert.match(renderToString(createElement(ProfilePage)),/User profile/);
 const footer=renderToString(createElement(SiteFooter));assert.match(footer,/href="\/profile"/);assert.match(footer,/href="\/admin"/);
 assert.doesNotMatch(footer,/href="\/(obs|game|panel|app)"/);
});

test('packaging refuses console-only installers before doing any build work',()=>{
 const run=spawnSync(process.execPath,['scripts/build-installer.mjs','--no-shell'],{encoding:'utf8'});
 assert.equal(run.status,1);assert.match(run.stderr,/Windows installers must include the GUI/);
 const build=readFileSync('scripts/build-installer.mjs','utf8');assert.doesNotMatch(build,/allowFailure:true/);
 const iss=readFileSync('installer/scout.iss','utf8');assert.match(iss,/#error "Missing scout-shell.exe/);
 const main=readFileSync('src-tauri/src/main.rs','utf8');assert.match(main,/command.creation_flags\(0x0800_0000\)/);assert.match(main,/"app dashboard"/);
 for(const line of iss.split('\n').filter(line=>/Name: "\{(?:group|autodesktop)\}\\SCOUT";/.test(line)))assert.match(line,/Filename: "\{app\}\\host\\scout-shell.exe"/);
});


test('beta application review is owner/reviewer-only and never exposes invite secrets',async(t)=>{
 const site=await platformHost(t,{SCOUT_SURFACE:'site',SCOUT_BETA_AUTO_APPROVE:'1'});
 const apply=async(name:string,email:string)=>{
  const result=await site.request('/api/beta/apply',{name,email,organisation:'Test club',country:'AL',useCase:'Run weekly events',events:'Two per month'});
  assert.equal(result.status,200);
  assert.equal(result.body.inviteUrl,null);
  const message=site.emails.find((entry:any)=>(entry.to===email||entry.to?.includes(email))&&entry.subject==='Your SCOUT closed-beta invitation');
  assert.ok(message,`an invitation email was delivered to ${email}`);
  const invite=new URL(message.text.match(/https?:\/\/[^\s]+/)![0]).searchParams.get('invite');
  assert.ok(invite);
  return {id:result.body.application.id,invite};
 };
 const ownerApplication=await apply('Owner','owner@example.com');
 assert.equal((await site.request('/api/beta/applications')).status,401);
 assert.equal((await site.request(`/api/beta/applications/${ownerApplication.id}`,{decision:'approve'})).status,401,'an anonymous applicant cannot approve');
 const owner=await site.request('/api/beta/activate',{invite:ownerApplication.invite,password:'a-long-owner-password'});
 assert.equal(owner.status,200);
 const saved=await site.request('/api/platform/admin/settings',{betaReviewers:['reviewer@example.com']},{method:'PUT',cookie:owner.cookie});
 assert.equal(saved.status,200);
 const reviewerApplication=await apply('Reviewer','reviewer@example.com');
 const reviewer=await site.request('/api/beta/activate',{invite:reviewerApplication.invite,password:'a-long-reviewer-password'});
 assert.equal(reviewer.status,200);
 const queue=await site.request('/api/beta/applications',undefined,{cookie:reviewer.cookie});
 assert.equal(queue.status,200);
 assert.ok(queue.body.applications.some((account:any)=>account.email==='reviewer@example.com'));
 const otherApplication=await apply('Other','other@example.com');
 const other=await site.request('/api/beta/activate',{invite:otherApplication.invite,password:'a-long-other-password'});
 assert.equal(other.status,200);
 assert.equal((await site.request('/api/beta/applications',undefined,{cookie:other.cookie})).status,403,'an ordinary account cannot review');
 assert.equal((await site.request('/api/platform/admin/settings',{betaReviewers:[]},{method:'PUT',cookie:reviewer.cookie})).status,403,'reviewers cannot change their own authorization');
 const forbiddenDecision=await site.request(`/api/beta/applications/${otherApplication.id}`,{decision:'approve'});
 assert.equal(forbiddenDecision.status,401);
 assert.equal(forbiddenDecision.body.code,'no-account');
});


test('an authorized website reviewer approves a pending hosted application through the mail outbox',async(t)=>{
 const key='hosted-review-flow-test-key';let clock=Date.now();const delivered:any[]=[];
 const accounts=await createAccountService({file:':memory:',apiKey:key,ownerEmail:'owner@example.com',port:0,host:'127.0.0.1',now:()=>clock,emailBaseUrl:'https://scout.example.test',emailEncryptionKey:Buffer.alloc(32,5),emailTransport:async message=>{delivered.push(message)},log:()=>{}});
 t.after(()=>accounts.close());
 const api=async(route:string,body?:unknown,cookie?:string)=>{
  const response=await fetch(accounts.url+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null,cookie:(response.headers.getSetCookie?.()??[]).map(value=>value.split(';')[0]).join('; ')};
 };
 const createAccount=async(email:string,activate:boolean)=>{
  const created=await api('/apply',{name:email.split('@')[0],email,organisation:'Test club',country:'AL',useCase:'Run events',events:'Monthly'});
  assert.equal(created.status,200);
  const id=created.body.account.id;
  if(!activate)return id;
  const decision=await fetch(accounts.url+`/applications/${id}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({decision:'approve',decidedBy:'owner@example.com'})});
  assert.equal(decision.status,200);
  const approval=await decision.json();
  const signed=await api('/activate',{invite:approval.invite,password:`a-long-${email.split('@')[0]}-password`});
  assert.equal(signed.status,200);
  return {id,cookie:signed.cookie};
 };
 const owner=await createAccount('owner@example.com',true);clock+=60*60*1000+1;
 const reviewer=await createAccount('reviewer@example.com',true);clock+=60*60*1000+1;
 const applicantId=await createAccount('pending@example.com',false);
 const central=await platformHost(t,{SCOUT_SURFACE:'site',SCOUT_BETA_API_URL:accounts.url,SCOUT_BETA_API_KEY:key});
 assert.equal((await central.request('/api/beta/applications')).status,401);
 assert.equal((await central.request(`/api/beta/applications/${applicantId}`,{decision:'approve'})).status,401);
 const updated=await central.request('/api/platform/admin/settings',{betaReviewers:['reviewer@example.com']},{method:'PUT',cookie:owner.cookie});
 assert.equal(updated.status,200);
 assert.equal((await central.request('/api/beta/applications',undefined,{cookie:reviewer.cookie})).status,200);
 assert.equal((await central.request(`/api/beta/applications/${applicantId}`,{decision:'approve'},{cookie:reviewer.cookie})).status,200);
 const forbidden=await central.request(`/api/beta/applications/${applicantId}`,{decision:'reject'});
 assert.equal(forbidden.status,401,'the application has now been approved, but anonymous requests remain forbidden');
 const browserDecision=await central.request(`/api/beta/applications/${applicantId}`,{decision:'reject'},{cookie:reviewer.cookie});
 assert.equal(browserDecision.status,200,'an authorized reviewer can revoke an approved account');
 assert.equal(browserDecision.body.application.status,'rejected');
 const browserBody=await central.request('/api/beta/applications',undefined,{cookie:reviewer.cookie});
 assert.equal(browserBody.body.applications.find((row:any)=>row.id===applicantId).status,'rejected');
 assert.ok(delivered.some(message=>message.to==='pending@example.com'&&message.subject==='Your SCOUT closed-beta invitation'));
 assert.equal(JSON.stringify(browserBody.body).includes('invite'),false,'review pages receive delivery metadata, never invitation tokens');
});

test('website owner settings reach a real linked host without exposing any central broadcast dashboard',async(t)=>{
 const {Installation}=await import('../server/beta.js');
 const path=await import('node:path');const {readFile}=await import('node:fs/promises');
 const site=await platformHost(t,{SCOUT_SURFACE:'site',SCOUT_BETA_AUTO_APPROVE:'1'});
 const applied=await site.request('/api/beta/apply',{name:'Owner',email:'owner@example.com'});assert.equal(applied.status,200);assert.equal(applied.body.inviteUrl,null,'invitation secrets are never returned to the browser');
 const inviteText=site.emails.find((email:any)=>email.subject==='Your SCOUT closed-beta invitation')?.text as string;
 assert.ok(inviteText,'automatic approval delivers a real email through the test transport');
 const inviteLink=inviteText.match(/https?:\/\/[^\s]+/)?.[0];assert.ok(inviteLink);
 const signed=await site.request('/api/beta/activate',{invite:new URL(inviteLink!).searchParams.get('invite'),password:'long-enough-password'});const cookie=signed.cookie;
 const saved=await site.request('/api/platform/admin/settings',{mapRotation:['de_train']},{method:'PUT',cookie});assert.equal(saved.status,200);
 const grant=await site.request('/api/beta/device/start',{label:'Observer',platform:'windows'});assert.equal(grant.status,200);
 assert.equal((await site.request('/api/beta/device/approve',{userCode:grant.body.userCode},{cookie})).status,200);
 const poll=await site.request('/api/beta/device/poll',{deviceCode:grant.body.deviceCode});assert.equal(poll.status,200);
 const venue=await platformHost(t,{SCOUT_PLATFORM_URL:site.url},async directory=>{
  const installation=await new Installation(path.join(directory,'config','beta','installation.json')).load();assert.equal(installation.completeLink(poll.body),true);await installation.save();
 });
 assert.equal((await venue.request('/api/beta/link/apply',{})).status,200);
 assert.deepEqual((await venue.request('/api/status')).body.platform.settings.mapRotation,['de_train']);
 const changed=await site.request('/api/platform/admin/settings',{mapRotation:['de_ancient','de_nuke']},{method:'PUT',cookie});assert.equal(changed.status,200);
 await venue.request('/api/beta/link/apply',{});
 assert.deepEqual((await venue.request('/api/status')).body.platform.settings.mapRotation,['de_ancient','de_nuke']);
 const persisted=JSON.parse(await readFile(path.join(venue.directory,'config','platform','store.json'),'utf8'));
 assert.deepEqual(persisted.settings.mapRotation,['de_ancient','de_nuke']);
 assert.equal((await site.request('/api/status')).status,404);
 assert.equal((await site.request('/api/platform/admin/settings',{mapRotation:['de_dust2']},{method:'PUT'})).status,401);
});
