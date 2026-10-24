import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAccountService,type AccountService} from '../server/account-service';
import {ACCOUNT_DB_SCHEMA_VERSION} from '../server/account-migrations';
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
 const emails:Array<{to:string;subject:string;text:string;html:string}>=[];
 service=await createAccountService({file,apiKey:KEY,port:0,host:'127.0.0.1',serviceName:'SCOUT accounts (test)',emailBaseUrl:'https://scout.example.test',emailEncryptionKey:Buffer.alloc(32,7),emailTransport:async message=>{emails.push(message)},...options});
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
  return {status:res.status,body:text?JSON.parse(text):null,setCookie,jar,requestId:res.headers.get('x-request-id')};
 };
 return {call,dir,jar,emails};
}
function seedPreMigrationDatabase(database:string,emails=['ada@example.com']){
 const legacy=new DatabaseSync(database);
 legacy.exec(`
  CREATE TABLE accounts (
   id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, organisation TEXT NOT NULL,
   country TEXT NOT NULL, use_case TEXT NOT NULL, events TEXT NOT NULL, status TEXT NOT NULL,
   password TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT NOT NULL DEFAULT '',
   invite_digest TEXT, invite_expires_at INTEGER, last_login_at INTEGER
  );
  CREATE TABLE events (at INTEGER NOT NULL, kind TEXT NOT NULL, account_id TEXT, detail TEXT NOT NULL DEFAULT '');
 `);
 const insert=legacy.prepare(`INSERT INTO accounts (id,email,display_name,organisation,country,use_case,events,status,password,created_at,decided_at,decided_by)
  VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,'')`);
 emails.forEach((email,index)=>insert.run(`legacy-${index}`,email,`Legacy ${index}`,'Old org','','','', 'pending',index+1));
 legacy.prepare('INSERT INTO events (at,kind,account_id,detail) VALUES (?,?,?,?)').run(1,'application','legacy-0','legacy detail');
 legacy.close();
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
 assert.equal(grant.value.verificationUrl,`http://panel.test:8080/login?link=${encodeURIComponent(grant.value.userCode)}`);
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
 const identity=await launcher.installationStatus({deviceId:poll.value.deviceId!,installationId:'inst-1',token:poll.value.installationToken!},{includeAccountId:true});
 assert.equal(identity.ok&&identity.value.accountId,decided.value.account.id,'only the authenticated host identity lookup includes accountId');
 const browserIdentity=await fetch(`${base}/license/check`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:poll.value.deviceId,installationId:'inst-1',token:poll.value.installationToken,resolveAccount:true})});
 assert.equal(browserIdentity.status,401,'the internal extension requires the service key, not just the installation token');
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
 const local=new LocalBetaService({dir,now:Date.now,host:'local',emailBaseUrl:'https://scout.example.test',emailEncryptionKey:Buffer.alloc(32,7),emailTransport:async()=>{},download:{url:'https://example.test/setup.exe',version:'SCOUT-Setup-0.1.0.exe',notes:'n'}}).load();
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
 // `reviewer` is hosted-only by design: the edge proxy reads it before forwarding desk routes with
 // the service key, while the local host computes reviewer access itself (see server/index.ts).
 const {reviewer:_,...remoteStatus}=(await call('/status',{cookie:true})).body;
 assert.equal(shape(await localService.status(activatedLocal.value.cookieId)),shape(remoteStatus),'BetaStatusView');
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

test('the owner settings desk drives the very next apply and env values are only an initial seed',async(t)=>{
 const {call}=await start({ownerEmail:'ada@example.com',applicationsOpen:true,reviewNote:'Initial wave'},t);
 const originalFile=file;
 assert.equal((await call('/settings')).status,401,'settings reads require the service key');
 const seeded=await call('/settings',{key:true});assert.equal(seeded.body.settings.reviewNote,'Initial wave');assert.equal(seeded.body.settings.applicationsOpen,true);
 assert.equal((await call('/settings',{method:'PUT',key:true,body:{applicationsOpen:false}})).status,401,'a service key cannot write settings instead of an owner session');
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const listed=await call('/applications',{key:true});const approved=await call(`/applications/${listed.body.applications[0].id}`,{key:true,body:{decision:'approve',decidedBy:'Owner'}});
 await call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'},cookie:true});
 const crossSite=await call('/settings',{method:'PUT',cookie:true,body:{applicationsOpen:false},headers:{Origin:'https://evil.test'}});assert.equal(crossSite.status,403);
 const saved=await call('/settings',{method:'PUT',cookie:true,body:{applicationsOpen:false,reviewNote:'Wave closed',maxTournamentsPerUser:1,betaReviewers:['ada@example.com'],futureSetting:true}});
 assert.equal(saved.status,200);assert.equal(saved.body.settings.version,2);assert.equal(saved.body.settings.updatedBy,'ada@example.com');
 const rolesDb=new DatabaseSync(originalFile);try{assert.equal(Number((rolesDb.prepare("SELECT COUNT(*) AS n FROM account_roles WHERE account_id = ? AND role = 'beta_reviewer'").get(listed.body.applications[0].id) as any).n),1,'reviewer settings synchronize transactionally to account roles')}finally{rolesDb.close()}
 const status=await call('/status',{cookie:true});assert.equal(status.body.applicationsOpen,false);assert.equal(status.body.reviewNote,'Wave closed');
 const refused=await call('/apply',{body:{...application,email:'next@example.com',address:'203.0.113.8'}});assert.equal(refused.status,403);assert.equal(refused.body.code,'applications-closed');
 assert.equal((await call('/login',{body:{email:'ada@example.com',password:'a-long-enough-password'}})).status,200,'closing applications never closes existing accounts');
 assert.equal((await call('/device/start',{body:{label:'PC',platform:'windows'}})).status,200);
 await service.close();
 const reopened=await createAccountService({file:originalFile,apiKey:KEY,ownerEmail:'ada@example.com',applicationsOpen:true,reviewNote:'Changed env seed',port:0,host:'127.0.0.1'});
 try{const persisted=await (await fetch(reopened.url+'/settings',{headers:{Authorization:`Bearer ${KEY}`}})).json();assert.equal(persisted.settings.applicationsOpen,false);assert.equal(persisted.settings.reviewNote,'Wave closed');assert.equal(persisted.settings.version,2)}finally{await reopened.close()}
});

test('an approved non-owner session cannot write the account service settings',async(t)=>{
 const {call}=await start({ownerEmail:'different-owner@example.com'},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});const apps=await call('/applications',{key:true});const approved=await call(`/applications/${apps.body.applications[0].id}`,{key:true,body:{decision:'approve',decidedBy:'Owner'}});
 await call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'},cookie:true});
 const denied=await call('/settings',{method:'PUT',cookie:true,body:{applicationsOpen:false}});assert.equal(denied.status,403);assert.equal(denied.body.code,'not-platform-owner');assert.equal((await call('/settings',{key:true})).body.settings.applicationsOpen,true);
});

test('account migrations adopt legacy data, add audit foundations and apply once',async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-account-'));
 const database=path.join(dir,'accounts.sqlite');
 seedPreMigrationDatabase(database);
 service=await createAccountService({file:database,apiKey:KEY,port:0,host:'127.0.0.1'});
 live.push({service,dir});t.after(stopAll);
 const rows=service.db.list();
 assert.equal(rows.length,1,'legacy account survives migration');
 assert.equal(rows[0].email,'ada@example.com');
 const check=new DatabaseSync(database);
 try{
  assert.equal(Number((check.prepare('PRAGMA user_version').get() as any).user_version),ACCOUNT_DB_SCHEMA_VERSION);
  for(const table of ['account_roles','password_recovery_tokens','email_outbox'])assert.equal(Number((check.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type=\'table\' AND name=?').get(table) as any).n),1,`${table} added by migration 3`);
  assert.equal(Number((check.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as any).n),0,'legacy event history is preserved in events; migration does not fabricate audit actors retroactively');
  assert.equal(Number((check.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n),1,'legacy event history remains intact');
  assert.equal(Number((check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='accounts_email_normalized'").get() as any).n),1);
  assert.equal(check.prepare('SELECT normalized_email FROM accounts WHERE id = ?').get('legacy-0')?.normalized_email,'ada@example.com','migration backfills the API-normalized email value');
 }finally{check.close()}
 // Idempotent startup: no duplicate schema or data and the migration version stays put.
 await service.close();
 service=await createAccountService({file:database,apiKey:KEY,port:0,host:'127.0.0.1'});
 live.push({service,dir});
 assert.equal(service.db.list().length,1);
});

test('API errors carry a generated request ID without breaking the legacy error contract',async(t)=>{
 const {call}=await start({},t);
 const invalid=await call('/apply',{body:{...application,email:'invalid',address:'203.0.113.7'},headers:{'X-Request-Id':'attacker-controlled'}});
 assert.equal(invalid.status,400);
 assert.equal(invalid.body.code,'bad-email');
 assert.equal(invalid.body.error,'That does not look like an email address.');
 assert.match(invalid.requestId||'',/^[0-9a-f-]{36}$/);
 assert.equal(invalid.body.requestId,invalid.requestId);
 assert.notEqual(invalid.requestId,'attacker-controlled','request IDs are generated by the service');
 const healthy=await call('/healthz');
 assert.match(healthy.requestId||'',/^[0-9a-f-]{36}$/);
});

test('audit records are durable, attributable and exclude free-form PII details',async(t)=>{
 const {call,dir}=await start({},t);
 const submitted=await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const id=submitted.body.account.id;
 const database=new DatabaseSync(path.join(dir,'accounts.sqlite'));
 try{
  const row=database.prepare('SELECT * FROM audit_logs WHERE action = ?').get('application') as any;
  assert.ok(row);
  assert.equal(row.actor_type,'anonymous');
  assert.equal(row.actor_id,null);
  assert.equal(row.target_type,'account');
  assert.equal(row.target_id,id);
  assert.equal(row.request_id,submitted.requestId);
  assert.equal(row.metadata,'{}');
  assert.equal(JSON.stringify(row).includes('ada@example.com'),false,'audit metadata never copies email or legacy event details');
 }finally{database.close()}
});

test('a normalized-email migration conflict fails closed and rolls back without deleting accounts',async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-account-'));
 const database=path.join(dir,'accounts.sqlite');
 seedPreMigrationDatabase(database,['ada@example.com','ADA@example.com']);
 t.after(async()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(()=>createAccountService({file:database,apiKey:KEY,port:0,host:'127.0.0.1'}),/resolve duplicate emails after trimming and case normalization/);
 const unchanged=new DatabaseSync(database);
 try{
  assert.equal(Number((unchanged.prepare('PRAGMA user_version').get() as any).user_version),1,'failed migration version was not committed');
  assert.equal(Number((unchanged.prepare('SELECT COUNT(*) AS n FROM accounts').get() as any).n),2,'no legacy account was removed');
  assert.equal(Number((unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='audit_logs'").get() as any).n),0,'the failed migration transaction created no partial audit schema');
 }finally{unchanged.close()}
});

test('approval fails visibly without mail configuration and leaves the application pending',async(t)=>{
 const {call}=await start({emailTransport:undefined,emailEncryptionKey:undefined,emailBaseUrl:undefined},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const listed=await call('/applications',{key:true}),id=listed.body.applications[0].id;
 const denied=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 assert.equal(denied.status,503);assert.equal(denied.body.code,'email-not-configured');
 const remains=await call('/applications',{key:true});
 assert.equal(remains.body.applications[0].status,'pending');
 assert.equal(Object.keys(remains.body.invitations).length,0,'no fake invite or outbox delivery was recorded');
});

test('expired invitations can be replaced, but the old token remains unusable',async(t)=>{
 let clock=1_700_000_000_000;
 const {call}=await start({now:()=>clock,invitationTtlMs:1_000},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const id=(await call('/applications',{key:true})).body.applications[0].id;
 const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 assert.equal(approved.body.invitationDelivery.status,'sent');
 const oldInvite=approved.body.invite;
 clock+=1_001;
 const expired=await call('/activate',{body:{invite:oldInvite,password:'a-long-enough-password'}});
 assert.equal(expired.status,401);assert.equal(expired.body.code,'expired-invite');
 const resent=await call(`/applications/${id}/resend-invitation`,{key:true,body:{requestedBy:'owner@example.com'}});
 assert.equal(resent.status,200);assert.notEqual(resent.body.invite,oldInvite);assert.equal(resent.body.invitationDelivery.status,'sent');
 const oldAgain=await call('/activate',{body:{invite:oldInvite,password:'a-long-enough-password'}});
 assert.equal(oldAgain.body.code,'bad-invite');
 const accepted=await call('/activate',{body:{invite:resent.body.invite,password:'a-long-enough-password'}});
 assert.equal(accepted.status,200);
});

test('concurrent acceptance of one invitation activates exactly once',async(t)=>{
 const {call}=await start({},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const id=(await call('/applications',{key:true})).body.applications[0].id;
 const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 const attempts=await Promise.all([
  call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'}}),
  call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'}}),
 ]);
 assert.deepEqual(attempts.map(result=>result.status).sort(),[200,401]);
 assert.equal((await call('/applications',{key:true})).body.invitations[id].activated,true);
});

test('password recovery is non-enumerating, expires, is single-use, and revokes old sessions',async(t)=>{
 const delivered:Array<{to:string;subject:string;text:string;html:string}>=[];let blockDelivery=false,deliveryEntered=false,releaseDelivery=()=>{};
 const {call}=await start({emailTransport:async message=>{delivered.push(message);if(blockDelivery)await new Promise<void>(resolve=>{deliveryEntered=true;releaseDelivery=resolve})}},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const id=(await call('/applications',{key:true})).body.applications[0].id;
 const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 await call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'},cookie:true});
 const unknown=await call('/password-recovery',{body:{email:'unknown@example.com'}});
 blockDelivery=true;
 const known=await call('/password-recovery',{body:{email:'ada@example.com'}});
 assert.equal(unknown.status,200);assert.deepEqual(unknown.body,known.body,'known and unknown accounts receive byte-for-byte equivalent responses');
 assert.equal(deliveryEntered,true,'the API returns without waiting for the mail provider');releaseDelivery();await new Promise<void>(resolve=>setImmediate(resolve));
 const email=delivered.find(message=>message.subject==='Reset your SCOUT password');assert.ok(email);
 const resetLink=email.text.match(/https?:\/\/[^\s]+/)?.[0];assert.ok(resetLink);
 const token=new URL(resetLink!).searchParams.get('reset');assert.ok(token);
 const changed=await call('/password-recovery/complete',{body:{token,password:'a-new-long-password'}});
 assert.equal(changed.status,200);
 const reused=await call('/password-recovery/complete',{body:{token,password:'another-long-password'}});
 assert.equal(reused.status,400);assert.equal(reused.body.code,'invalid-recovery-token');
 assert.equal((await call('/status',{cookie:true})).body.signedIn,false,'reset revokes all old sessions');
 assert.equal((await call('/login',{body:{email:'ada@example.com',password:'a-long-enough-password'}})).status,401);
 assert.equal((await call('/login',{body:{email:'ada@example.com',password:'a-new-long-password'}})).status,200);
});

test('revoking an approved account cuts sessions, launchers and sign-in',async(t)=>{
 const {call,dir}=await start({},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const listed=await call('/applications',{key:true});
 const id=listed.body.applications[0].id;
 const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 await call('/activate',{body:{invite:approved.body.invite,password:'a-long-enough-password'},cookie:true});
 const grant=await call('/device/start',{body:{label:'pc',platform:'win32',origin:'http://panel.test:8080'}});
 await call('/device/approve',{body:{userCode:grant.body.userCode},cookie:true});
 const poll=await call('/device/poll',{body:{deviceCode:grant.body.deviceCode}});
 const licence=await call('/license/check',{body:{deviceId:poll.body.deviceId,installationId:'inst-1',token:poll.body.installationToken}});
 assert.equal(licence.body.status,'active');
 const revoked=await call(`/applications/${id}`,{key:true,body:{decision:'revoke',decidedBy:'owner@example.com',reason:'exploited the beta build'}});
 assert.equal(revoked.status,200);
 assert.equal(revoked.body.account.status,'revoked');
 assert.equal(revoked.body.account.revokedReason,'exploited the beta build');
 assert.deepEqual(revoked.body.account.devices,[],'launchers lose entitlement with the account');
 assert.equal((await call('/status',{cookie:true})).body.signedIn,false,'revocation signs the account out everywhere');
 const signIn=await call('/login',{body:{email:'ada@example.com',password:'a-long-enough-password'}});
 assert.equal(signIn.status,403);assert.equal(signIn.body.code,'revoked');
 const reapply=await call('/apply',{body:{...application,address:'203.0.113.8'}});
 assert.equal(reapply.status,403);assert.equal(reapply.body.code,'revoked');
 const check=await call('/license/check',{body:{deviceId:poll.body.deviceId,installationId:'inst-1',token:poll.body.installationToken}});
 assert.equal(check.body.status,'revoked');
 const again=await call(`/applications/${id}`,{key:true,body:{decision:'revoke',decidedBy:'owner@example.com'}});
 assert.equal(again.status,409);assert.equal(again.body.code,'already-decided');
 const reopen=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 assert.equal(reopen.status,409);assert.equal(reopen.body.code,'already-decided');
 const eventsDb=new DatabaseSync(path.join(dir,'accounts.sqlite'));
 try{
  const kinds=(eventsDb.prepare('SELECT kind FROM events WHERE account_id = ?').all(id) as Array<{kind:string}>).map(row=>row.kind);
  assert.ok(kinds.includes('account.revoked'),kinds.join(','));
 }finally{eventsDb.close()}
});

test('a revocation reason longer than the desk allows is refused, and pending accounts cannot be revoked',async(t)=>{
 const {call}=await start({},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const id=(await call('/applications',{key:true})).body.applications[0].id;
 const early=await call(`/applications/${id}`,{key:true,body:{decision:'revoke',decidedBy:'owner@example.com'}});
 assert.equal(early.status,409);assert.equal(early.body.code,'invalid-decision');
 await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 const tooLong=await call(`/applications/${id}`,{key:true,body:{decision:'revoke',decidedBy:'owner@example.com',reason:'x'.repeat(281)}});
 assert.equal(tooLong.status,400);assert.equal(tooLong.body.code,'invalid-reason');
 assert.equal((await call('/applications',{key:true})).body.applications[0].status,'approved','a refused revocation changes nothing');
});

test('a refused invitation delivery is diagnosed on the desk and on /healthz',async(t)=>{
 const {call}=await start({emailTransport:async()=>{throw Object.assign(new Error('refused'),{status:403,providerCode:'validation_error'})}},t);
 await call('/apply',{body:{...application,address:'203.0.113.7'}});
 const id=(await call('/applications',{key:true})).body.applications[0].id;
 const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
 const delivery=approved.body.invitationDelivery;
 assert.equal(delivery.status,'pending');
 assert.equal(delivery.errorCode,'provider-rejected');
 assert.equal(delivery.errorStatus,403);
 assert.equal(delivery.providerError,'validation_error');
 assert.ok(delivery.guidance.includes('resend.com/domains'),delivery.guidance);
 assert.ok(delivery.nextAttemptAt>Date.now()-60_000);
 const listed=await call('/applications',{key:true});
 assert.equal(listed.body.invitations[id].providerError,'validation_error');
 const health=await call('/healthz');
 assert.equal(health.body.emailOutboxRejected,1);
 assert.equal(health.body.emailLastFailure.code,'provider-rejected');
 assert.equal(health.body.emailLastFailure.status,403);
 assert.ok(health.body.emailLastFailure.guidance.includes('resend.com/domains'));
 assert.equal(JSON.stringify(health.body).includes('ada@example.com'),false,'diagnostics never carry the recipient');
});

test('/status tells the edge whether the session belongs to a reviewer',async(t)=>{
 const {call,jar}=await start({ownerEmail:'owner@example.com'},t);
 const enroll=async(email:string)=>{
  await call('/apply',{body:{...application,email,address:'203.0.113.7'}});
  const id=(await call('/applications',{key:true})).body.applications.find((row:any)=>row.email===email).id;
  const approved=await call(`/applications/${id}`,{key:true,body:{decision:'approve',decidedBy:'owner@example.com'}});
  await call('/activate',{body:{invite:approved.body.invite,password:`a-long-${email.split('@')[0]}-password`},cookie:true});
 };
 await enroll('owner@example.com');
 const ownerCookie=`scout_account=${jar.get('scout_account')}`;
 assert.equal((await call('/status',{cookie:true})).body.reviewer,true,'the owner may review');
 await enroll('reviewer@example.com');
 assert.equal((await call('/status',{cookie:true})).body.reviewer,false,'an ordinary account may not');
 const granted=await call('/settings',{method:'PUT',headers:{Cookie:ownerCookie},body:{betaReviewers:['reviewer@example.com']}});
 assert.equal(granted.status,200);
 assert.equal((await call('/status',{cookie:true})).body.reviewer,true,'a granted reviewer may review');
 const visitor=await call('/status');
 assert.equal(visitor.body.reviewer,false,'a visitor may not');
});
