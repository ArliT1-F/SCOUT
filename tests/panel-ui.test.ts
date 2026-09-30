import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {UnlockScreen,SessionPill,apiFetch,authInit,rememberToken,storedToken,forgetToken,setDeniedHandler} from '../src/session';
import {PanelAuth,PANEL_COOKIE,type PanelSessionView} from '../server/auth';

// What the panel does about the host's decision. Rendered to HTML, so the two states that matter are
// pinned without a browser: the front door a remote visitor sees, and the chip that tells an operator
// which session is driving the broadcast. The token handling is exercised with a sessionStorage stub,
// because that fallback only exists for browsers that refuse the cookie.

const auth=new PanelAuth({token:'the-panel-token'});
const localView=()=>auth.view({address:'127.0.0.1',host:'127.0.0.1:8080'});
const remoteLockedView=()=>auth.view({address:'192.168.1.42',host:'192.168.1.42:8080'});
function remoteOpenView():PanelSessionView{
 const opened=auth.unlock({token:'the-panel-token',address:'192.168.1.42',host:'192.168.1.42:8080',userAgent:'Mozilla/5.0'});
 if(!opened.ok) throw Error('fixture session did not open');
 return auth.view({address:'192.168.1.42',host:'192.168.1.42:8080',cookie:`${PANEL_COOKIE}=${opened.session.id}`});
}

test('a remote visitor without a session gets the unlock form, not the dashboard',()=>{
 const html=renderToString(createElement(UnlockScreen,{session:remoteLockedView(),onUnlocked:()=>{}}));
 assert.match(html,/Operator panel locked/);
 assert.match(html,/type="password"/,'the token is typed into a masked field');
 assert.match(html,/Unlock panel/);
 assert.match(html,/192\.168\.1\.42/,'the visitor is told which address they reached');
 assert.match(html,/SCOUT_PANEL_TOKEN/,'the hint says how to keep one token across restarts');
 assert.equal(html.includes('Save configuration'),false,'no operator controls are rendered behind the form');
});

test('a host with remote control switched off offers no form at all',()=>{
 const off=new PanelAuth({token:'the-panel-token',remoteEnabled:false});
 const html=renderToString(createElement(UnlockScreen,{session:off.view({address:'192.168.1.42',host:'192.168.1.42:8080'}),onUnlocked:()=>{}}));
 assert.match(html,/Remote control is switched off/);
 assert.equal(html.includes('type="password"'),false,'there is no token to enter when the door is shut');
 assert.equal(html.includes('Unlock panel'),false);
});

test('a refusal is shown on the form with the host’s own words',()=>{
 const html=renderToString(createElement(UnlockScreen,{session:remoteLockedView(),message:'That panel session has ended. Unlock again with the token the host printed.',onUnlocked:()=>{}}));
 assert.match(html,/That panel session has ended/);
 assert.match(html,/unlock-error/);
});

// React separates adjacent text nodes with comment markers when it renders to HTML, which is noise
// for assertions written against what an operator reads.
const clean=(html:string)=>html.replace(/<!-- -->/g,'');

test('the header chip names the session, and only a remote one can be signed out',()=>{
 const local=clean(renderToString(createElement(SessionPill,{session:localView(),onLogout:()=>{}})));
 assert.match(local,/LOCAL SESSION/);
 assert.equal(local.includes('Sign out'),false,'the observer machine has no session to end');
 const locked=clean(renderToString(createElement(SessionPill,{session:remoteLockedView(),onLogout:()=>{}})));
 assert.match(locked,/REMOTE · LOCKED/);
 const remote=clean(renderToString(createElement(SessionPill,{session:remoteOpenView(),onLogout:()=>{}})));
 assert.match(remote,/REMOTE · SESSION · 192\.168\.1\.42/);
 assert.match(remote,/Sign out/);
 const before=clean(renderToString(createElement(SessionPill,{session:null,onLogout:()=>{}})));
 assert.match(before,/LOCAL SESSION/,'the chip assumes nothing until the host says otherwise');
});

test('a stored token rides along on every mutation, and a refusal reaches the panel',async()=>{
 const store=new Map<string,string>();
 (globalThis as any).sessionStorage={getItem:(key:string)=>store.has(key)?store.get(key)!:null,setItem:(key:string,value:string)=>{store.set(key,String(value))},removeItem:(key:string)=>{store.delete(key)}};
 const realFetch=globalThis.fetch;
 try{
  assert.equal(storedToken(),'');
  assert.equal(authInit({}).headers,undefined,'no token, no header');
  rememberToken('token-from-the-console');
  assert.equal(storedToken(),'token-from-the-console');
  assert.equal(new Headers(authInit({}).headers).get('X-Scout-Token'),'token-from-the-console');
  assert.equal(authInit({method:'PUT',headers:{'Content-Type':'application/json'}}).method,'PUT','the caller’s own request is untouched');
  let sent:any=null,notified:any=null;
  globalThis.fetch=async(_path:any,init:any)=>{sent=init;return {status:401,clone(){return this},json:async()=>({error:'That panel session has ended.',code:'bad-session'})} as any};
  setDeniedHandler((message,code)=>{notified={message,code}});
  const response=await apiFetch('/api/controls',{method:'PUT',body:'{}'});
  assert.equal(response.status,401);
  assert.equal(new Headers(sent.headers).get('X-Scout-Token'),'token-from-the-console');
  assert.deepEqual(notified,{message:'That panel session has ended.',code:'bad-session'});
  // A refusal that is not one of the host's denial codes (a plain 500, a dropped connection) must not
  // sign the operator out of their own panel.
  notified=null;
  globalThis.fetch=async()=>({status:500,clone(){return this},json:async()=>({error:'Could not save'})}) as any;
  await apiFetch('/api/controls',{method:'PUT',body:'{}'});
  assert.equal(notified,null);
  setDeniedHandler(null);
  forgetToken();
  assert.equal(storedToken(),'');
 } finally {
  globalThis.fetch=realFetch;
  delete (globalThis as any).sessionStorage;
 }
});
