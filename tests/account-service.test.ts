import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAccountService,type AccountService} from '../server/account-service';
import {HostedBetaService,LocalBetaService,createBetaService,type BetaContext,type BetaResult} from '../server/beta';

// The hosted account service (server/account-service.ts), driven the way a deployment is driven:
// over a socket, with cookies, by the same host code that talks to it in production
// (`HostedBetaService`). The point of these tests is parity — the pages were written against the
// local store, and a hosted deployment must not change one field of what they receive.
const KEY='a-service-key-for-tests';
const context=(address='203.0.113.7'):BetaContext=>({address,userAgent:'node-test',origin:'http://panel.test:8080',secure:false});
const application={name:'Ada Operator',email:'ada@example.com',organisation:'Durres LAN',country:'AL',useCase:'Weekly cups',events:'2 per month'};
let file:string;
let service:AccountService;
let base:string;
// Every service a test starts is closed by that test's `after` hook, so a failed assertion can never
// leave a listener behind and hang the runner.
const live:Array<{service:AccountService;dir:string}>=[];
async function stopAll(){
 for(const entry of live.splice(0)){await entry.service.close().catch(()=>{});await rm(entry.dir,{recursive:true,force:true}).catch(()=>{})}
}
async function start(options:Parameters<typeof createAccountService>[0]={},t?:{after:(fn:()=>Promise<void>)=>void}){
 const dir=await mkdtemp(path.join(tmpdir(),'scout-account-'));
 file=path.join(dir,'accounts.sqlite');
 service=await createAccountService({file,apiKey:KEY,port:0,host:'127.0.0.1',serviceName:'SCOUT accounts (test)',...options});
 base=service.url;
 // A cookie jar, because fetch in Node does not keep one and the flow is cookie-based on purpose.
 const jar=new Map<string,string>();
 live.push({service,dir});
 t?.after(stopAll);
 const call=async(route:string,init:{method?:string;body?:unknown;key?:boolean;cookie?:boolean;headers?:Record<string,string>}={})=>{
  const headers:Record<string,string>={'Content-Type':'application/json',...init.headers};
  if(init.key) headers.Authorization=`Bearer ${KEY}`;
  if(init.cookie&&jar.size) headers.Cookie=[...jar.entries()].map(([name,value])=>`${name}=${value}`).join('; ');
  const res=await fetch(base+route,{method:init.method||(init.body===undefined?'GET':'POST'),headers,body:init.body===undefined?undefined:JSON.stringify(init.body)});
  const setCookie=res.headers.getSetCookie?.()??[];
  for(const cookie of setCookie){
   const [pair]=cookie.split(';');
   const index=pair.indexOf('=');
   const name=pair.slice(0,index);const value=pair.slice(index+1);
   if(value) jar.set(name,value);else jar.delete(name);
  }
  const text=await res.text();
  return {status:res.status,body:text?JSON.parse(text):null,setCookie,jar};
 };
 return {call,dir,jar};
}


test('the service implements the documented contract, cookies and all',async(t)=>{
 const {call}=await start({},t);
 // status before anybody signs in
 const visitor=await call('/status',{cookie:true});
 assert.equal(visitor.status,200);
 assert.equal(visitor.body.mode,'hosted');
 assert.equal(visitor.body.signedIn,false);
 assert.equal(visitor.body.account,null);
 assert.equal(visitor.body.download,null,'a visitor is not offered the launcher');
 assert.equal(visitor.body.applicationsOpen,true);
 assert.equal(visitor.body.host,'SCOUT accounts (test)');

 // apply
 const applied=await call('/apply',{body:{...application,address:'203.0.113.7'}});
 assert.equal(applied.status,200);
 assert.equal(applied.body.account.status,'pending');
 assert.equal(applied.body.account.email,'ada@example.com');
 assert.equal(applied.body.account.useCase,'Weekly cups');
 assert.equal(applied.body.invite,null,'only an approval mints an invite');
 const duplicate=await call('/apply',{body:{...application,address:'203.0.113.9'}});
 assert.equal(duplicate.status,409);
 assert.equal(duplicate.body.code,'already-applied');
 const badEmail=await call('/apply',{body:{...application,email:'nope',address:'203.0.113.9'}});
 assert.equal(badEmail.body.code,'bad-email');

 // A pending account has no password yet, so signing in is bad credentials — the same answer the
 // local store gives, and deliberately not a hint that the address is known and in review.
 const pendingSignIn=await call('/login',{body:{email:'ada@example.com',password:'whatever-long'}});
 assert.equal(pendingSignIn.status,401);
 assert.equal(pendingSignIn.body.code,'bad-credentials');

 // the owner lists and approves with the service key
 assert.equal((await call('/applications')).status,401,'the owner routes are closed without the service key');
 assert.equal((await call('/applications',{headers:{Authorization:'Bearer wrong'}})).status,401);
 const listed=await call('/applications',{key:true});
 assert.equal(listed.body.applications.length,1);
 const id=listed.body.applications[0].id;
 const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'Ada'}});
 assert.equal(approved.body.account.status,'approved');
 assert.ok(approved.body.invite&&approved.body.invite.length>20,'the invite value is handed to the operator once');

 // the applicant sets a password through the invite and is signed in with a cookie
 const activated=await call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'},cookie:true});
 assert.equal(activated.status,200);
 assert.equal(activated.body.account.status,'approved');
 assert.equal(activated.body.account.email,'ada@example.com');
 assert.ok(activated.setCookie.some(cookie=>/scout_account=/.test(cookie)&&/HttpOnly/.test(cookie)&&/SameSite=Lax/.test(cookie)),activated.setCookie.join(' | '));
 const signedIn=await call('/status',{cookie:true});
 assert.equal(signedIn.body.signedIn,true);
 assert.equal(signedIn.body.download.version.startsWith('SCOUT-Setup-'),true,'an approved account is offered the installer');
 assert.equal(signedIn.body.download.url.includes('releases/latest'),true);

 // the invite is single use
 const reused=await call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'}});
 assert.equal(reused.status,401);
 assert.equal(reused.body.code,'bad-invite');

 // sign out clears the cookie and the session
 const out=await call('/logout',{body:{},cookie:true});
 assert.equal(out.body.ok,true);
 assert.equal((await call('/status',{cookie:true})).body.signedIn,false);

 // and sign back in
 const again=await call('/login',{body:{email:'ada@example.com',password:'a-long-enough-password'},cookie:true});
 assert.equal(again.status,200);
 assert.equal(again.body.account.devices.length,0);
 const wrong=await call('/login',{body:{email:'ada@example.com',password:'not-the-password'}});
 assert.equal(wrong.status,401);
 assert.equal(wrong.body.code,'bad-credentials');

 // an unknown route is a documented refusal, not a stack trace
 const unknown=await call('/nope');
 assert.equal(unknown.status,404);
 assert.equal(unknown.body.code,'not-found');
});

test('the launcher half works through the host client, unchanged',async(t)=>{
 const {dir}=await start({},t);
 // The host in hosted mode: this is exactly what a deployment runs (SCOUT_BETA_API_URL).
 const launcher=new HostedBetaService(base,KEY);
 const applied=await fetch(`${base}/apply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...application,address:'203.0.113.7'})});
 assert.equal(applied.status,200);
 const apps=await launcher.applications();
 assert.equal(apps.length,1);
 const decided=await launcher.decide(apps[0].id,'approve','Ada');
 assert.equal(decided.ok,true);
 if(!decided.ok) return;
 // the account's own browser session approves the code; here that is a fetch with the cookie
 const activated=await fetch(`${base}/activate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite:decided.value.invite,password:'a-long-enough-password'})});
 const cookie=(activated.headers.getSetCookie?.()??[]).map(value=>value.split(';')[0]).join('; ');
 const grant=await launcher.deviceStart({label:'observer-pc',platform:'win32'},context());
 assert.equal(grant.ok,true);
 if(!grant.ok) return;
 assert.match(grant.value.userCode,/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
 assert.equal(grant.value.verificationUrl,`http://panel.test:8080/dashboard?link=${encodeURIComponent(grant.value.userCode)}`);
 assert.equal(grant.value.interval>0,true);
 const before=await launcher.devicePoll({deviceCode:grant.value.deviceCode});
 assert.equal(before.ok&&before.value.status,'pending');
 const approve=await fetch(`${base}/device/approve`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({userCode:grant.value.userCode})});
 assert.equal(approve.status,200);
 const poll=await launcher.devicePoll({deviceCode:grant.value.deviceCode});
 assert.equal(poll.ok,true);
 if(!poll.ok) return;
 assert.equal(poll.value.status,'approved');
 assert.ok(poll.value.installationToken,'the launcher receives its token');
 assert.equal(poll.value.account?.email,'ada@example.com');
 // exactly once: the second poll has the device id but no token
 const second=await launcher.devicePoll({deviceCode:grant.value.deviceCode});
 assert.equal(second.ok&&second.value.status,'approved');
 assert.equal(second.ok?second.value.installationToken:undefined,undefined,'the token is handed over once');
 assert.equal(second.ok?second.value.deviceId:undefined,poll.value.deviceId);

 // the licence check the shell runs
 const active=await launcher.installationStatus({deviceId:poll.value.deviceId!,installationId:'inst-1',token:poll.value.installationToken!});
 assert.equal(active.ok,true);
 if(active.ok) assert.deepEqual(active.value,{status:'active',email:'ada@example.com',displayName:'Ada Operator'});
 const wrongToken=await launcher.installationStatus({deviceId:poll.value.deviceId!,installationId:'inst-1',token:'not-the-token'});
 assert.equal(wrongToken.ok&&wrongToken.value.status,'revoked','a wrong token is a refusal, not an error');
 const unknownDevice=await launcher.installationStatus({deviceId:'no-such-device',installationId:'inst-1',token:'x'});
 assert.equal(unknownDevice.ok&&unknownDevice.value.status,'unknown','an unknown device is a re-link, not a revocation');

 // unlink from the dashboard
 const revoked=await fetch(`${base}/devices/revoke`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({deviceId:poll.value.deviceId})});
 assert.equal(revoked.status,200);
 const after=await launcher.installationStatus({deviceId:poll.value.deviceId!,installationId:'inst-1',token:poll.value.installationToken!});
 assert.equal(after.ok&&after.value.status,'revoked');
 const apps2=await launcher.applications();
 assert.equal(apps2[0].devices.length,0,'a revoked launcher leaves the account view');
});

test('the answers have the same shape as the local store — field for field',async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-parity-'));
 const local=new LocalBetaService({dir,now:Date.now,host:'local',download:{url:'https://example.test/setup.exe',version:'SCOUT-Setup-0.1.0.exe',notes:'n'}}).load();
 const localService=await local;
 const {call}=await start({download:{url:'https://example.test/setup.exe',version:'SCOUT-Setup-0.1.0.exe',notes:'n'}},t);
 const shape=(value:unknown):string=>{
  const walk=(node:any):any=>{
   if(Array.isArray(node)) return node.length?[walk(node[0])]:[];
   if(node&&typeof node==='object') return Object.fromEntries(Object.entries(node).sort().map(([key,value])=>[key,walk(value)]));
   return typeof node;
  };
  return JSON.stringify(walk(value));
 };
 const localApplied=await localService.apply(application,context());
 const remoteApplied=await call('/apply',{body:{...application,address:'203.0.113.7'}});
 assert.equal(localApplied.ok,true);
 const localView=localApplied.ok?localApplied.value.account:null;
 assert.equal(shape(localView),shape(remoteApplied.body.account),'AccountView');
 const localId=localView!.id;
 const localDecided=await localService.decide(localId,'approve','Ada');
 const remoteList=await call('/applications',{key:true});
 const remoteDecided=await call(`/applications/${remoteList.body.applications[0].id}`,{key:true,body:{decision:'approve',decidedBy:'Ada'}});
 assert.ok(localDecided.ok);
 const localInvite=localDecided.ok?localDecided.value.invite:null;
 const activatedLocal=await localService.activate({invite:localInvite!,password:'a-long-enough-password'},context());
 const activatedRemote=await call('/activate',{body:{invite:remoteDecided.body.invite,password:'a-long-enough-password'}});
 assert.ok(activatedLocal.ok);
 if(!activatedLocal.ok) return;
 assert.equal(shape(activatedLocal.value.account),shape(activatedRemote.body.account),'AccountView after activation');
 assert.equal(shape(await localService.status(activatedLocal.value.cookieId)),shape((await call('/status',{cookie:true})).body),'BetaStatusView');
 assert.equal(shape((await localService.status(activatedLocal.value.cookieId)).account),shape((await call('/status',{cookie:true})).body.account),'the signed-in AccountView');
 // the launcher half, both implementations, same fields
 const localGrant=await localService.deviceStart({label:'pc',platform:'win32'},context());
 const remoteGrant=await call('/device/start',{body:{label:'pc',platform:'win32',origin:'http://panel.test:8080'}});
 assert.ok(localGrant.ok);
 if(!localGrant.ok) return;
 const localPoll=await localService.devicePoll({deviceCode:localGrant.value.deviceCode});
 assert.equal(shape(localPoll.ok?localPoll.value:null),shape((await call('/device/poll',{body:{deviceCode:remoteGrant.body.deviceCode}})).body),'DevicePollView');
 assert.equal(shape(await localService.applications()),shape((await call('/applications',{key:true})).body.applications),'the application list is the same shape');
 assert.equal(shape(localGrant.value),shape(remoteGrant.body),'DeviceGrantView');
 await rm(dir,{recursive:true,force:true});
});

test('no plaintext secret is written to the database file',async(t)=>{
 const {call,dir}=await start({},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const listed=await call('/applications',{key:true});
 const approved=await call(`/applications/${listed.body.applications[0].id}`,{key:true,body:{decision:'approve',decidedBy:'Ada'}});
 const password='a-very-memorable-password';
 await call('/activate',{body:{invite:approved.body.invite,password},cookie:true});
 const grant=await call('/device/start',{body:{label:'pc',platform:'win32',origin:'http://panel.test:8080'}});
 await call('/device/approve',{body:{userCode:grant.body.userCode},cookie:true});
 const poll=await call('/device/poll',{body:{deviceCode:grant.body.deviceCode}});
 const token=poll.body.installationToken as string;
 await service.close(); // close first so nothing is buffered
 const bytes=(await readFile(file)).toString('latin1');
 for(const secret of [password,approved.body.invite as string,grant.body.deviceCode as string,token]){
  assert.ok(!bytes.includes(secret),'the database must not hold a usable secret');
 }
 // the salted scrypt digest and the token digests are there, as the digest table in docs/BETA.md says
 assert.match(bytes,/[0-9a-f]{128}/,'the scrypt digest (64 bytes, hex) is what stands in for the password');
 assert.match(bytes,/[0-9a-f]{64}/,'and the tokens are SHA-256 digests');
 assert.ok(bytes.includes('ada@example.com'),'the account itself is of course readable');
 await rm(dir,{recursive:true,force:true});
});

test('applications are rate limited per address, and the service says so in the local store\'s words',async(t)=>{
 const {call,dir}=await start({},t);
 const from='198.51.100.44';
 const noName=await call('/apply',{body:{...application,email:'x@example.com',name:'A',address:from}});
 assert.equal(noName.status,400);
 assert.equal(noName.body.code,'bad-name');
 for(const index of [0,1,2]){
  const sent=await call('/apply',{body:{...application,email:`applicant${index}@example.com`,address:from}});
  assert.equal(sent.status,200,`application ${index+1}`);
 }
 const fourth=await call('/apply',{body:{...application,email:'applicant4@example.com',address:from}});
 assert.equal(fourth.status,429);
 assert.equal(fourth.body.code,'throttled');
 assert.ok(service.db.list().length===3,'the refused application was not stored');
});

test('a hosted deployment is selected by SCOUT_BETA_API_URL and has no local site half',async()=>{
 const runtime=createBetaService({apiUrl:'https://accounts.example.test',apiKey:'k'});
 assert.equal(runtime.mode,'hosted');
 assert.equal(runtime.site,null,'the browser talks to the service through the host proxy');
 assert.equal(runtime.local,null);
 const runtimeLocal=createBetaService({dir:'config/beta'});
 assert.equal(runtimeLocal.mode,'local');
 assert.ok(runtimeLocal.local&&runtimeLocal.site);
});

test('the service refuses an owner route without a configured key instead of leaving it open',async(t)=>{
 const {call}=await start({apiKey:''},t);
 const listed=await call('/applications',{key:true});
 assert.equal(listed.status,503);
 assert.equal(listed.body.code,'service-key-required');
});

test('a closed beta stops taking applications but keeps the accounts it has',async(t)=>{
 const {call}=await start({applicationsOpen:false},t);
 const refused=await call('/apply',{body:{...application,address:'203.0.113.7'}});
 assert.equal(refused.status,403);
 assert.equal(refused.body.code,'applications-closed');
 assert.equal((await call('/status')).body.applicationsOpen,false);
});

test('the launcher-link revocation flow leaves no error behind for an unknown code',async(t)=>{
 const {call}=await start({},t);
 const unknown=await call('/device/poll',{body:{deviceCode:'never-issued'}});
 assert.equal(unknown.status,404);
 assert.equal(unknown.body.code,'unknown-code');
 const noSession=await call('/device/approve',{body:{userCode:'ABCD-EFGH'}});
 assert.equal(noSession.status,401);
 assert.equal(noSession.body.code,'no-session');
});