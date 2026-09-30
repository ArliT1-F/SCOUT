import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 PanelAuth,tokensMatch,isLoopbackAddress,normalizeHost,isLocalName,isIpLiteral,isRebindableHost,
 hostTrusted,toAllowedSet,originTrusted,cookieValue,sessionCookie,clearedCookie,requestIsSecure,
 generateToken,PANEL_COOKIE,MAX_SESSIONS,MAX_UNLOCK_FAILURES,LOCKOUT_MS,FAILURE_WINDOW_MS,SESSION_TTL_MS,
 type PanelSessionView,
} from '../server/auth';

// The operator panel is reachable from the whole venue network — that is the point of it — so these
// tests pin exactly who may change the broadcast: the machine the host runs on, and anybody holding
// the token. Everything else is a read.

const TOKEN='correct-horse-battery-staple';
const LAN='192.168.1.42';
// A clock the tests own, so lockouts and session expiry are exercised without waiting.
function clock(start=1_000_000){let now=start;return {now:()=>now,advance(ms:number){now+=ms}}}
const panel=(options:Record<string,unknown>={})=>new PanelAuth({token:TOKEN,now:clock().now,...options});

// ---------------------------------------------------------------- addresses and host names
test('loopback is recognised in the spellings a socket can report',()=>{
 for(const address of ['127.0.0.1','127.1.2.3','::1','::ffff:127.0.0.1','::FFFF:127.0.0.1','::ffff:7f00:1']) assert.equal(isLoopbackAddress(address),true,address);
 for(const address of [LAN,'169.254.0.21','10.0.0.9','::ffff:192.168.1.42','fe80::1','evil.com','',undefined]) assert.equal(isLoopbackAddress(address as any),false,String(address));
});

test('a host header is reduced to its name, whatever shape it arrives in',()=>{
 assert.equal(normalizeHost('127.0.0.1:8080'),'127.0.0.1');
 assert.equal(normalizeHost('[::1]:8080'),'::1');
 assert.equal(normalizeHost('SCOUT.LAN:80'),'scout.lan');
 assert.equal(normalizeHost('evil.com.'),'evil.com');
 assert.equal(normalizeHost('::1'),'::1','a bare IPv6 literal has no port to strip');
 assert.equal(normalizeHost('fe80::1'),'fe80::1');
 assert.equal(normalizeHost(undefined),'');
});

test('local names and public names are told apart',()=>{
 for(const host of ['localhost','scout.local','panel.internal','desk.lan','studio.home.arpa','observer-pc','[::1]']) assert.equal(hostTrusted(host),true,host);
 for(const host of ['evil.com','preview.example.dev','8080-abc.e2b.app']) assert.equal(hostTrusted(host),false,host);
 assert.equal(hostTrusted('8080-abc.e2b.app',['8080-abc.e2b.app']),true,'a listed name is the operator saying it is theirs');
 assert.equal(hostTrusted('8080-abc.e2b.app','8080-abc.e2b.app, scout.lan '),true,'the environment value is a comma-separated list');
 assert.equal(toAllowedSet('').size,0);
 assert.equal(hostTrusted(''),false,'a request without a Host header is not a local address');
 assert.equal(isRebindableHost('evil.com'),true);
 assert.equal(isRebindableHost('observer-pc'),false,'a bare host name is not a domain anyone can register');
 assert.equal(isRebindableHost('127.0.0.1'),false);
 assert.equal(isRebindableHost('scout.local'),false);
 assert.equal(isIpLiteral('[::1]'),true,'the brackets are stripped before the address is judged');
 assert.equal(isIpLiteral('::1'),true);
 assert.equal(isIpLiteral('localhost'),false);
 assert.equal(isLocalName('localhost'),true);
});

test('the same-origin check refuses exactly the cross-site shape',()=>{
 assert.equal(originTrusted(undefined,'127.0.0.1:8080'),true,'a browser-native client sends no Origin');
 assert.equal(originTrusted('http://127.0.0.1:8080','127.0.0.1:8080'),true);
 assert.equal(originTrusted('http://192.168.1.42:8080','192.168.1.42:8080'),true);
 assert.equal(originTrusted('https://evil.com',LAN+':8080'),false);
 assert.equal(originTrusted('https://evil.com','evil.com'),true,'the host itself was named that way; the local bypass is what refuses it');
 assert.equal(originTrusted('http://localhost:3000','127.0.0.1:8080'),true,'two spellings of the same local service');
 assert.equal(originTrusted('https://panel.example.com','127.0.0.1:8080',['panel.example.com']),true,'a proxy that rewrites Host needs the name listed');
 assert.equal(originTrusted('https://panel.example.com','127.0.0.1:8080'),false);
 assert.equal(originTrusted('null','127.0.0.1:8080'),false,'a sandboxed frame sends Origin: null — never trusted');
 assert.equal(originTrusted('not a url','127.0.0.1:8080'),false);
});

// ---------------------------------------------------------------- tokens and cookies
test('tokens are compared in constant time and never by shape',()=>{
 assert.equal(tokensMatch(TOKEN,TOKEN),true);
 assert.equal(tokensMatch(TOKEN+'x',TOKEN),false);
 assert.equal(tokensMatch('short',TOKEN),false,'a short candidate must not throw');
 assert.equal(tokensMatch('',TOKEN),false);
 const generated=generateToken();
 assert.equal(generated.length,32,'24 random bytes in base64url');
 assert.notEqual(generateToken(),generateToken());
});

test('the session cookie is HttpOnly, Strict and Secure only over TLS',()=>{
 const cookie=sessionCookie('abc123',SESSION_TTL_MS,false);
 assert.match(cookie,/^scout_panel=abc123; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
 assert.equal(cookie.includes('Secure'),false,'the panel runs plain HTTP on a LAN');
 assert.match(sessionCookie('abc123',SESSION_TTL_MS,true),/; Secure$/);
 assert.match(clearedCookie(true),/Max-Age=0; Secure$/);
 assert.equal(cookieValue(`other=1; ${PANEL_COOKIE}=xyz; scout_settings=2`,PANEL_COOKIE),'xyz');
 assert.equal(cookieValue(`${PANEL_COOKIE}="xyz"`,PANEL_COOKIE),'xyz');
 assert.equal(cookieValue(`${PANEL_COOKIE}=`,PANEL_COOKIE),undefined);
 assert.equal(cookieValue('scout_panelish=1',PANEL_COOKIE),undefined);
 assert.equal(cookieValue(undefined,PANEL_COOKIE),undefined);
 assert.equal(requestIsSecure({'x-forwarded-proto':'https'}),true);
 assert.equal(requestIsSecure({'x-forwarded-proto':'HTTPS, http'}),true);
 assert.equal(requestIsSecure({'x-forwarded-proto':'http'}),false);
 assert.equal(requestIsSecure({},true),true);
});

// ---------------------------------------------------------------- who may change the broadcast
test('the operator at the host machine needs no token, but only through a local address',()=>{
 const auth=panel();
 assert.deepEqual(pick(auth.authorize({address:'127.0.0.1',host:'127.0.0.1:8080'})),{ok:true,local:true,via:'local'});
 assert.deepEqual(pick(auth.authorize({address:'::ffff:127.0.0.1',host:'scout.local:8080'})),{ok:true,local:true,via:'local'});
 assert.deepEqual(pick(auth.authorize({address:'127.0.0.1',host:'observer-pc:8080'})),{ok:true,local:true,via:'local'});
 assert.deepEqual(pick(auth.authorize({address:'127.0.0.1',host:'192.168.1.42:8080'})),{ok:true,local:true,via:'local'},'the LAN address of this very machine is still this machine');
 // A proxy or tunnel running next to the host connects from 127.0.0.1 while carrying the public name
 // the visitor typed; a rebound domain looks the same. Neither may operate the panel for free.
 const proxied=auth.authorize({address:'127.0.0.1',host:'8080-abc.e2b.app'});
 assert.deepEqual({ok:proxied.ok,status:(proxied as any).status,code:(proxied as any).code},{ok:false,status:403,code:'untrusted-host'});
 const rebound=auth.authorize({address:'127.0.0.1',host:'evil.com:8080'});
 assert.equal((rebound as any).code,'untrusted-host');
 assert.match((rebound as any).message,/SCOUT_ALLOWED_HOSTS/);
 // ... unless the operator says the name is theirs.
 assert.equal(panel({allowedHosts:['8080-abc.e2b.app']}).authorize({address:'127.0.0.1',host:'8080-abc.e2b.app'}).ok,true);
});

test('another machine needs the token, by header or by session cookie',()=>{
 const auth=panel();
 const bare=auth.authorize({address:LAN,host:`${LAN}:8080`});
 assert.deepEqual({ok:bare.ok,status:(bare as any).status,code:(bare as any).code},{ok:false,status:401,code:'no-session'});
 assert.equal(auth.authorize({address:LAN,host:`${LAN}:8080`,headers:{'x-scout-token':TOKEN}}).ok,true);
 assert.equal(auth.authorize({address:LAN,host:`${LAN}:8080`,headers:{authorization:`Bearer ${TOKEN}`}}).ok,true);
 assert.equal(auth.authorize({address:LAN,host:`${LAN}:8080`,headers:{'x-scout-token':'nope'}}).ok,false);
 const attempt=auth.unlock({token:TOKEN,address:LAN,host:`${LAN}:8080`});
 assert.equal(attempt.ok,true);
 const id=(attempt as any).session.id;
 const withCookie=auth.authorize({address:'10.9.9.9',host:'10.9.9.9:8080',cookie:`${PANEL_COOKIE}=${id}`});
 assert.deepEqual(pick(withCookie),{ok:true,local:false,via:'cookie'});
 assert.equal(auth.authorize({address:'10.9.9.9',cookie:`${PANEL_COOKIE}=forged`}).ok,false,'an invented cookie is not a session');
 assert.match((attempt as any).cookie,/HttpOnly; SameSite=Strict/);
});

test('a host can require the token from its own machine too',()=>{
 const auth=panel({requireLocalToken:true});
 const decision=auth.authorize({address:'127.0.0.1',host:'127.0.0.1:8080'});
 assert.equal(decision.ok,false);
 assert.match((decision as any).message,/SCOUT_REQUIRE_TOKEN/);
 assert.equal(auth.authorize({address:'127.0.0.1',host:'127.0.0.1:8080',headers:{'x-scout-token':TOKEN}}).ok,true);
});

test('remote control can be switched off entirely',()=>{
 const auth=panel({remoteEnabled:false});
 for(const request of [{address:LAN,host:`${LAN}:8080`},{address:LAN,headers:{'x-scout-token':TOKEN}}])
  assert.equal((auth.authorize(request) as any).code,'remote-disabled',JSON.stringify(request));
 assert.equal((auth.authorize({address:'127.0.0.1',host:'evil.com'}) as any).code,'untrusted-host','a request that is neither local nor remote enough is refused for the reason it arrived with');
 assert.equal(auth.unlock({token:TOKEN,address:LAN}).ok,false,'a correct token cannot open a door that is shut');
 assert.equal(auth.unlock({token:'wrong',address:LAN}).ok,false);
 assert.equal(auth.authorize({address:'127.0.0.1',host:'127.0.0.1:8080'}).ok,true,'the observer machine still runs its own panel');
});

test('wrong tokens are throttled per address, and the lockout runs out',()=>{
 const time=clock();
 const auth=new PanelAuth({token:TOKEN,now:time.now});
 for(let attempt=1;attempt<=MAX_UNLOCK_FAILURES;attempt++){
  const result=auth.unlock({token:'guess-'+attempt,address:LAN});
  assert.equal(result.ok,false);
  assert.equal((result as any).status,attempt<MAX_UNLOCK_FAILURES?401:429,`attempt ${attempt}`);
  if(attempt<MAX_UNLOCK_FAILURES) assert.equal((result as any).attemptsLeft,MAX_UNLOCK_FAILURES-attempt);
 }
 assert.equal((auth.unlock({token:TOKEN,address:LAN}) as any).code,'throttled','the right token does not skip the lockout');
 assert.equal((auth.unlock({token:'x',address:LAN}) as any).retryAfterMs,LOCKOUT_MS);
 assert.equal(auth.unlock({token:TOKEN,address:'192.168.1.43'}).ok,true,'another machine is unaffected');
 time.advance(LOCKOUT_MS+1);
 assert.equal(auth.unlock({token:TOKEN,address:LAN}).ok,true,'the lockout is not a permanent ban');
 // A success clears the record, and failures that never reached the threshold expire on their own.
 assert.equal(auth.unlock({token:'wrong',address:'10.0.0.5'}).ok,false);
 time.advance(FAILURE_WINDOW_MS+1);
 assert.equal((auth.unlock({token:'wrong',address:'10.0.0.5'}) as any).attemptsLeft,MAX_UNLOCK_FAILURES-1);
});

test('sessions expire, are capped and can be closed',()=>{
 const time=clock();
 const auth=new PanelAuth({token:TOKEN,now:time.now});
 const first=(auth.unlock({token:TOKEN,address:LAN}) as any).session.id;
 assert.equal(auth.authorize({address:LAN,cookie:`${PANEL_COOKIE}=${first}`}).ok,true);
 time.advance(SESSION_TTL_MS+1);
 assert.equal(auth.authorize({address:LAN,cookie:`${PANEL_COOKIE}=${first}`}).ok,false,'an untouched session does not live forever');
 const second=(auth.unlock({token:TOKEN,address:LAN}) as any).session.id;
 assert.equal(auth.logout(second),true);
 assert.equal(auth.logout('never-existed'),false);
 assert.equal(auth.authorize({address:LAN,cookie:`${PANEL_COOKIE}=${second}`}).ok,false,'signing out ends that cookie');
 // One more session than the cap allows: the newest works, the least recently opened one is gone.
 let oldest='',newest='';
 for(let index=0;index<=MAX_SESSIONS;index++){
  const session=(auth.unlock({token:TOKEN,address:LAN}) as any).session.id;
  if(index===0) oldest=session;
  newest=session;
 }
 assert.equal(auth.sessionCount,MAX_SESSIONS,'the table never grows past the cap');
 assert.equal(auth.authorize({address:LAN,cookie:`${PANEL_COOKIE}=${oldest}`}).ok,false,'the least recently opened session gives way to the new one');
 assert.equal(auth.authorize({address:LAN,cookie:`${PANEL_COOKIE}=${newest}`}).ok,true);
 // Expiry is collected as traffic arrives: the view reports the live table, not a growing one.
 time.advance(SESSION_TTL_MS+1);
 assert.equal(auth.view({address:LAN}).sessions,0);
});

test('the panel view never carries the token',()=>{
 for(const token of [TOKEN,undefined]){
  const auth=new PanelAuth({token,now:clock().now});
  const view=auth.view({address:LAN,host:`${LAN}:8080`});
  const serialized=JSON.stringify(view);
  assert.equal(serialized.includes(auth.token),false);
  assert.equal(view.authenticated,false);
  assert.equal(view.local,false);
  assert.equal(view.via,null);
  assert.equal(view.tokenSource,token?'env':'generated');
  assert.equal(view.remoteEnabled,true);
  assert.equal(view.sessions,0);
  assert.deepEqual(view.allowedHosts,[]);
  const opened=auth.unlock({token:auth.token,address:LAN,host:`${LAN}:8080`,userAgent:'Mozilla/5.0'});
  assert.equal(opened.ok,true);
  const remote=auth.view({address:LAN,host:`${LAN}:8080`,cookie:`${PANEL_COOKIE}=${(opened as any).session.id}`});
  assert.deepEqual([remote.authenticated,remote.local,remote.via],[true,false,'cookie']);
  assert.equal(JSON.stringify(remote).includes(auth.token),false);
  assert.equal(remote.expiresAt!-remote.startedAt!,SESSION_TTL_MS);
  const local=auth.view({address:'127.0.0.1',host:'127.0.0.1:8080'});
  assert.deepEqual([local.authenticated,local.local,local.via],[true,true,'local']);
  assert.equal(local.expiresAt,null);
 }
});

function pick(decision:any){return decision.ok?{ok:decision.ok,local:decision.local,via:decision.via}:{ok:decision.ok,status:decision.status,code:decision.code}}
