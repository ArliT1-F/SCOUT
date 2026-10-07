import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {
 LocalBetaService,Installation,createBetaService,newUserCode,normalizeUserCode,normalizeEmail,
 digestSecret,secretMatches,hashToken,accountView,ACCOUNT_TTL_MS,DEVICE_CODE_TTL_MS,MAX_APPLICATIONS_PER_HOUR,MAX_LOGIN_FAILURES,MIN_PASSWORD,
 type AccountView,BetaContext,
} from '../server/beta';
import {DownloadCard,isSiteRoute,LandingPage,ApplyPage,LoginPage} from '../src/site';

// The closed beta as it behaves, not as it is described: a stranger may apply and nothing else, an
// approved account sets its own password through a one-time invite, and a launcher only becomes
// "linked" when the account owner approves the code the launcher is showing. Every test that writes
// gets its own temporary directory — the real config/beta/ is never touched by the suite.
const HOME='127.0.0.1';
const STRANGER='203.0.113.9';
const context=(address=HOME):BetaContext=>({address,userAgent:'node-test',origin:'http://127.0.0.1:8080',secure:false});
let dir='';
let service:LocalBetaService;
let clock:number;
async function fresh(){dir=await mkdtemp(path.join(tmpdir(),'scout-beta-'));clock=1_700_000_000_000;service=await new LocalBetaService({dir,download:{url:'https://example.test/Setup.exe',version:'SCOUT-Setup-9.9.9.exe',notes:'test build'},now:()=>clock}).load();return service}
const application={name:'Ada Operator',email:'Ada@Example.com',organisation:'Durres LAN',country:'AL',useCase:'weekly cups',events:'Every week'};

test('a stranger can apply, and only apply',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 assert.equal(created.ok,true,JSON.stringify(created));
 if(!created.ok) return;
 assert.equal(created.value.account.status,'pending','an application is not an approval');
 assert.equal(created.value.account.email,'ada@example.com','the address is normalized, so a second application cannot shadow the first');
 assert.equal(created.value.invite,null,'nothing is handed out before a human decides');
 const duplicate=await service.apply(application,context(STRANGER));
 assert.equal(duplicate.ok,false);
 if(!duplicate.ok) assert.equal(duplicate.code,'already-applied');
 const status=await service.status(undefined);
 assert.equal(status.signedIn,false);
 assert.equal(status.account,null,'an anonymous caller learns nothing about an applicant');
 assert.equal(status.download,null,'and certainly not the download');
});

test('an application is rate limited per address',async()=>{
 await fresh();
 for(let index=0;index<MAX_APPLICATIONS_PER_HOUR;index++){
  const result=await service.apply({...application,email:`operator${index}@example.com`},context(STRANGER));
  assert.equal(result.ok,true);
 }
 const blocked=await service.apply({...application,email:'one-too-many@example.com'},context(STRANGER));
 assert.equal(blocked.ok,false);
 if(!blocked.ok){assert.equal(blocked.status,429);assert.equal(blocked.code,'throttled')}
 assert.equal((await service.apply({...application,email:'other@example.com'},context(HOME))).ok,true,'another address is unaffected');
});

test('only an approval mints an invite, and only the invite sets a password',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 assert.equal(created.ok,true);
 const id=created.ok?created.value.account.id:'';
 const early=await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(HOME));
 assert.equal(early.ok,false,'a password cannot be chosen before the account exists');
 const pending=await service.decide(id,'reject','owner');
 assert.equal(pending.ok,true);
 if(pending.ok){assert.equal(pending.value.account.status,'rejected');assert.equal(pending.value.invite,null)}
 assert.equal((await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(HOME))).ok,false);
 const approved=await service.decide(id,'approve','owner');
 assert.equal(approved.ok,true,JSON.stringify(approved));
 const invite=approved.ok?approved.value.invite:'';
 assert.ok(invite&&invite.length>20,'an approval returns the one-time invite');
 assert.equal(JSON.stringify(await service.applications()).includes(invite!),false,'the invite value is never part of a listing');
 const weak=await service.activate({invite:invite!,password:'short'},context(HOME));
 assert.equal(weak.ok,false);
 if(!weak.ok) assert.equal(weak.code,'weak-password');
 const activated=await service.activate({invite:invite!,password:'a-long-enough-password'},context(HOME));
 assert.equal(activated.ok,true,JSON.stringify(activated));
 if(activated.ok) assert.equal(activated.value.account.status,'approved');
 const reused=await service.activate({invite:invite!,password:'another-long-password'},context(HOME));
 assert.equal(reused.ok,false,'an invite works exactly once');
 if(!reused.ok) assert.equal(reused.code,'bad-invite');
});

test('signing in hands out a session, and a wrong password is throttled',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 const id=created.ok?created.value.account.id:'';
 const approved=await service.decide(id,'approve','owner');
 const invite=approved.ok?approved.value.invite:'';
 await service.activate({invite:invite!,password:'a-long-enough-password'},context(HOME));
 const wrong=await service.signIn({email:'ada@example.com',password:'not-the-password'},context(STRANGER));
 assert.equal(wrong.ok,false);
 if(!wrong.ok){assert.equal(wrong.status,401);assert.equal(wrong.code,'bad-credentials')}
 for(let attempt=0;attempt<MAX_LOGIN_FAILURES+2;attempt++) await service.signIn({email:'ada@example.com',password:'not-the-password'},context(STRANGER));
 const throttled=await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(STRANGER));
 assert.equal(throttled.ok,false);
 if(!throttled.ok){assert.equal(throttled.status,429);assert.equal(throttled.code,'throttled')}
 const signedIn=await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(HOME));
 assert.equal(signedIn.ok,true);
 if(!signedIn.ok) return;
 const status=await service.status(signedIn.value.cookieId);
 assert.equal(status.signedIn,true);
 assert.equal(status.download?.url,'https://example.test/Setup.exe','an approved account is offered the launcher');
 await service.signOut(signedIn.value.cookieId);
 assert.equal((await service.status(signedIn.value.cookieId)).signedIn,false,'signing out ends the session');
});

test('the launcher flow needs the account owner, not just the code',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 const id=created.ok?created.value.account.id:'';
 const approved=await service.decide(id,'approve','owner');
 await service.activate({invite:approved.ok?approved.value.invite!:'',password:'a-long-enough-password'},context(HOME));
 const signedIn=await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(HOME));
 assert.equal(signedIn.ok,true);
 const start=await service.deviceStart({label:'observer-pc',platform:'win32'},context(HOME));
 assert.equal(start.ok,true);
 if(!start.ok) return;
 assert.match(start.value.userCode,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/,'the code is short, typo-resistant and readable aloud');
 assert.match(start.value.verificationUrl,/\/dashboard\?link=/,'the launcher tells the operator where to approve it');
 const pending=await service.devicePoll({deviceCode:start.value.deviceCode});
 assert.equal(pending.ok&&pending.value.status,'pending');
 const noSession=await service.deviceDecide(undefined,start.value.userCode,true);
 assert.equal(noSession.ok,false,'a code is useless without a signed-in account');
 if(!noSession.ok) assert.equal(noSession.code,'no-session');
 const strangerSession=await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(STRANGER));
 assert.equal(strangerSession.ok,true);
 const approved2=await service.deviceDecide(strangerSession.ok?strangerSession.value.cookieId:undefined,start.value.userCode,true);
 assert.equal(approved2.ok,true);
 if(approved2.ok) assert.equal(approved2.value.account.devices.length,1,'the device shows up on the account');
 const decided=await service.devicePoll({deviceCode:start.value.deviceCode});
 assert.equal(decided.ok&&decided.value.status,'approved');
 assert.ok(decided.ok&&decided.value.installationToken&&decided.value.installationToken.length>20,'the launcher receives its own token');
 const again=await service.deviceDecide(strangerSession.ok?strangerSession.value.cookieId:undefined,start.value.userCode,true);
 assert.equal(again.ok,false);
 if(!again.ok) assert.equal(again.code,'already-decided');
 const deviceId=decided.ok?decided.value.deviceId!:'';
 const revoked=await service.revokeDevice(strangerSession.ok?strangerSession.value.cookieId:undefined,deviceId);
 assert.equal(revoked.ok,true);
 if(revoked.ok) assert.equal(revoked.value.account.devices.length,0,'unlinking removes it from the account');
 const unknown=await service.deviceDecide(strangerSession.ok?strangerSession.value.cookieId:undefined,'ZZZZ-ZZZZ',true);
 assert.equal(unknown.ok,false);
 if(!unknown.ok) assert.equal(unknown.code,'unknown-code');
});

test('an expired code stops working',async()=>{
 await fresh();
 const start=await service.deviceStart({label:'pc',platform:'win32'},context(HOME));
 assert.equal(start.ok,true);
 if(!start.ok) return;
 clock+=DEVICE_CODE_TTL_MS+1000;
 const poll=await service.devicePoll({deviceCode:start.value.deviceCode});
 assert.equal(poll.ok,true);
 if(poll.ok) assert.equal(poll.value.status,'expired');
});

test('passwords are stored as scrypt digests and tokens as digests, never as values',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 const id=created.ok?created.value.account.id:'';
 const approved=await service.decide(id,'approve','owner');
 const invite=approved.ok?approved.value.invite!:'';
 const password='a-long-enough-password';
 const activated=await service.activate({invite,password},context(HOME));
 const cookieId=activated.ok?activated.value.cookieId:'';
 const start=await service.deviceStart({label:'pc',platform:'win32'},context(HOME));
 if(!start.ok) throw Error('no grant');
 const session=await service.signIn({email:'ada@example.com',password},context(HOME));
 await service.deviceDecide(session.ok?session.value.cookieId:undefined,start.value.userCode,true);
 const poll=await service.devicePoll({deviceCode:start.value.deviceCode});
 const raw=await readFile(path.join(dir,'store.json'),'utf8');
 assert.equal(raw.includes(password),false,'the password itself is never written');
 assert.equal(raw.includes(invite),false,'the invite is only stored as a digest');
 assert.equal(raw.includes(start.value.deviceCode),false,'neither is the device code');
 if(poll.ok&&poll.value.installationToken) assert.equal(raw.includes(poll.value.installationToken),false,'the installation token is stored as a digest');
 assert.equal(raw.includes(cookieId),false,'and so is the session id');
 const mode=(await stat(path.join(dir,'store.json'))).mode&0o777;
 assert.equal(mode,0o600,'the account store is not world-readable');
 assert.equal(secretMatches(password,digestSecret(password)),true);
 assert.equal(secretMatches('another-password',digestSecret(password)),false);
});

test('the store survives a restart, sessions included',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 const id=created.ok?created.value.account.id:'';
 const approved=await service.decide(id,'approve','owner');
 await service.activate({invite:approved.ok?approved.value.invite!:'',password:'a-long-enough-password'},context(HOME));
 const signedIn=await service.signIn({email:'ada@example.com',password:'a-long-enough-password'},context(HOME));
 assert.equal(signedIn.ok,true);
 if(!signedIn.ok) return;
 const reopened=await new LocalBetaService({dir,now:()=>clock}).load();
 const status=await reopened.status(signedIn.value.cookieId);
 assert.equal(status.signedIn,true,'a restart does not sign anybody out');
 assert.equal(status.account?.status,'approved');
 clock+=ACCOUNT_TTL_MS+1000;
 assert.equal((await reopened.status(signedIn.value.cookieId)).signedIn,false,'an abandoned session does expire');
});

test('one account is one account: a second application for an approved address is refused',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 const id=created.ok?created.value.account.id:'';
 await service.decide(id,'approve','owner');
 const again=await service.apply({...application,name:'Someone Else'},context(STRANGER));
 assert.equal(again.ok,false);
 if(!again.ok) assert.equal(again.code,'already-approved');
});

test('auto-approval is opt-in and hands back the invite',async()=>{
 const dirAuto=await mkdtemp(path.join(tmpdir(),'scout-beta-auto-'));
 const auto=await new LocalBetaService({dir:dirAuto,autoApprove:true}).load();
 const created=await auto.apply(application,context(STRANGER));
 assert.equal(created.ok,true);
 if(created.ok){assert.equal(created.value.account.status,'approved');assert.ok(created.value.invite)}
 await rm(dirAuto,{recursive:true,force:true});
});

test('the factory picks the hosted service from the environment, and never both',()=>{
 const local=createBetaService({dir:'/tmp/scout-beta-factory-test'});
 assert.equal(local.mode,'local');
 assert.ok(local.site&&local.local,'local mode serves the site itself');
 const hosted=createBetaService({apiUrl:'https://accounts.example.test/api/beta'});
 assert.equal(hosted.mode,'hosted');
 assert.equal(hosted.site,null,'hosted mode proxies the site calls instead of answering them here');
 assert.equal(hosted.local,null);
 assert.ok(hosted.launcher,'the launcher half is always real');
});

test('the installation file keeps the launcher identity, and can be unlinked',async()=>{
 const dirInstall=await mkdtemp(path.join(tmpdir(),'scout-install-'));
 const file=path.join(dirInstall,'installation.json');
 const installation=await new Installation(file,()=>clock).load();
 assert.equal(installation.view().linked,false);
 installation.beginLink({userCode:'ABCD-EFGH',deviceCode:'device-code',expiresAt:clock+DEVICE_CODE_TTL_MS});
 assert.equal(installation.view().pending?.userCode,'ABCD-EFGH');
 assert.equal(installation.completeLink({installationToken:'token-value',deviceId:'device-1',account:{email:'ada@example.com',displayName:'Ada'}}),true);
 await installation.save();
 assert.equal(installation.view().linked,true);
 assert.equal(installation.view().email,'ada@example.com');
 const mode=(await stat(file)).mode&0o777;
 assert.equal(mode,0o600,'the launcher token file is not world-readable');
 const reopened=await new Installation(file,()=>clock).load();
 assert.equal(reopened.view().linked,true,'a restart keeps the link');
 reopened.unlink();
 assert.equal(reopened.view().linked,false);
 await rm(dirInstall,{recursive:true,force:true});
});

test('a user code is unambiguous when it is read out loud',()=>{
 for(let index=0;index<200;index++){
  const code=newUserCode();
  assert.match(code,/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,code);
  assert.equal(/[0O1IL]/.test(code),false,code);
  assert.equal(normalizeUserCode(code.toLowerCase().replace('-',' ')),code.replace('-',''));
 }
 assert.equal(normalizeEmail('  Ada@Example.COM '),'ada@example.com');
});

// ---------------------------------------------------------------- the pages themselves
const clean=(html:string)=>html.replace(/<!-- -->/g,'');
const approvedAccount:AccountView={id:'a1',email:'ada@example.com',displayName:'Ada Operator',organisation:'Durres LAN',country:'AL',status:'approved',useCase:'weekly cups',events:'Every week',createdAt:1_700_000_000_000,decidedAt:1_700_000_100_000,devices:[]};
const pendingAccount:AccountView={...approvedAccount,status:'pending',decidedAt:null};

test('the site routes are the four public pages, and nobody else claims them',()=>{
 for(const route of ['/welcome','/login','/apply','/dashboard']) assert.equal(isSiteRoute(route),true,route);
 for(const route of ['/','/admin','/obs','/game','/api/beta/status','']) assert.equal(isSiteRoute(route),false,route);
});

test('the landing page sells the product without inventing a session',()=>{
 const html=clean(renderToString(createElement(LandingPage)));
 assert.match(html,/CLOSED BETA/);
 assert.match(html,/Apply for the closed beta/);
 assert.match(html,/No injection/);
 assert.match(html,/Game State Integration/);
 assert.match(html,/href="\/apply"/);
 assert.match(html,/href="\/login"/);
 const nav=html.slice(html.indexOf('<header'),html.indexOf('</header>'));
 assert.equal(nav.includes('href="/dashboard"'),false,'a visitor is not shown a dashboard they do not have');
});

test('the application form asks for what a review needs',()=>{
 const html=clean(renderToString(createElement(ApplyPage)));
 for(const field of ['YOUR NAME','EMAIL','TEAM OR ORGANISATION','COUNTRY','WHAT WILL YOU BROADCAST?']) assert.match(html,new RegExp(field),field);
 assert.match(html,/HOW OFTEN DO YOU BROADCAST\?/);
 assert.match(html,/Send application/);
});

test('the login page shows both doors, and names the code a launcher is waiting on',()=>{
 const html=clean(renderToString(createElement(LoginPage,{})));
 assert.match(html,/Welcome back/);
 assert.match(html,/Sign in/);
 assert.match(html,/PANEL TOKEN/,'the operator machine can still be unlocked from here');
 assert.match(html,/No account yet\?/,'a visitor is pointed at the application form');
 const waiting=clean(renderToString(createElement(LoginPage,{linkCode:'ABCD-EFGH'})));
 assert.match(waiting,/Approve a launcher/);
 assert.match(waiting,/ABCD-EFGH/);
 assert.match(waiting,/Link launcher ABCD-EFGH/,'the code travels with the sign-in, so it can be approved right after');
 const invite=clean(renderToString(createElement(LoginPage,{invite:'an-invite-token'})));
 assert.match(invite,/Set your password/);
 assert.match(invite,/REPEAT PASSWORD/);
});

test('the dashboard download is gated on approval',()=>{
 const pending=clean(renderToString(createElement(DownloadCard,{account:pendingAccount,download:null})));
 assert.match(pending,/Available after approval/);
 assert.match(pending,/IN REVIEW/);
 assert.equal(pending.includes('Download for Windows'),false,'a pending applicant cannot download the launcher');
 const approved=clean(renderToString(createElement(DownloadCard,{account:approvedAccount,download:{url:'https://example.test/SCOUT-Setup-9.9.9.exe',version:'SCOUT-Setup-9.9.9.exe',notes:'beta 4'}})));
 assert.match(approved,/Download for Windows/);
 assert.match(approved,/https:\/\/example\.test\/SCOUT-Setup-9\.9\.9\.exe/);
 assert.match(approved,/beta 4/);
 assert.equal(approved.includes('Available after approval'),false);
});

test('the listing view hides revoked devices and the secrets behind them',async()=>{
 await fresh();
 const created=await service.apply(application,context(STRANGER));
 const id=created.ok?created.value.account.id:'';
 const approved=await service.decide(id,'approve','owner');
 const account=approved.ok?approved.value.account:null;
 assert.ok(account);
 const view=accountView({id:'x',email:'a@b.co',displayName:'A',organisation:'',country:'',useCase:'',events:'',status:'approved',createdAt:0,decidedAt:null,decidedBy:'',password:{salt:'s',digest:'d'},invite:{digest:'i',expiresAt:0},devices:[{id:'dev',label:'pc',platform:'win32',createdAt:0,lastSeenAt:0,revokedAt:1,tokenDigest:'secret-digest'}]});
 assert.equal(JSON.stringify(view).includes('secret-digest'),false);
 assert.equal(JSON.stringify(view).includes('"d"'),false);
 assert.equal(view.devices.length,0,'a revoked device is gone from the account view');
 assert.equal(hashToken('abc').length,64);
});
