import React,{useState} from 'react';
import {KeyRound,LogOut,Monitor,ShieldCheck,Wifi} from 'lucide-react';
import type {PanelSessionView} from '../server/auth';
// The operator side of remote access. The host decides who may change the broadcast (server/auth.ts);
// this module is what the panel does about it: it shows a session, offers the unlock form when the
// host says this visitor has no authority, and attaches the token to every mutation.
//
// Two ways to hold the token. The normal one is the HttpOnly cookie the host sets when the panel is
// unlocked — nothing here has to know the value. The fallback is the token kept in sessionStorage and
// sent as a header, which is what makes the panel usable when a browser refuses the cookie (a panel
// embedded in another site's frame, third-party storage blocked) and what a script does.
const TOKEN_KEY='scout.panel.token';
const TOKEN_HEADER='X-Scout-Token';
export function storedToken(){try{return sessionStorage.getItem(TOKEN_KEY)||''}catch{return ''}}
export function rememberToken(token:string){try{sessionStorage.setItem(TOKEN_KEY,token)}catch{}}
export function forgetToken(){try{sessionStorage.removeItem(TOKEN_KEY)}catch{}}
// Every operator mutation goes through here, so the token rides along without each call site knowing
// about it. A 401/403 carrying one of the host's denial codes means authority was lost — the session
// expired, the token changed, remote control was switched off — and the panel should say so instead
// of showing a generic save failure.
type DeniedHandler=(message:string,code:string)=>void;
let denied:DeniedHandler|null=null;
export function setDeniedHandler(handler:DeniedHandler|null){denied=handler}
export function authInit(init:RequestInit={}):RequestInit{
 const token=storedToken();
 if(!token) return init;
 const headers=new Headers(init.headers);
 headers.set(TOKEN_HEADER,token);
 return {...init,headers};
}
export async function apiFetch(path:string,init:RequestInit={}):Promise<Response>{
 const res=await fetch(path,authInit(init));
 if(res.status===401||res.status===403){
  const body=await res.clone().json().catch(()=>({}) as any);
  const authenticationCodes=new Set(['no-session','bad-session','remote-disabled','untrusted-host','throttled']);
  // 403 is also used for valid lower-privilege roles. A capability denial must not erase an
  // authenticated designer/viewer session or push the user back to the token-unlock screen.
  if(body&&authenticationCodes.has(String(body.code))) denied?.(String(body.error||'The host refused that request.'),String(body.code));
 }
 return res;
}
const sessionError=(reason:any)=>reason?.message||'Could not reach the host.';
// The unlock form. The token is never in the page's URL after this: the host's printed link turns into
// a cookie and a redirect, and typing the token here exchanges it for a cookie as well.
export function UnlockScreen({session,message,onUnlocked}:{session:PanelSessionView|null;message?:string;onUnlocked:()=>void}){
 const [token,setToken]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const remoteEnabled=session?.remoteEnabled!==false;
 async function submit(event:React.FormEvent){
  event.preventDefault();
  const value=token.trim();
  if(!value){setError('Enter the token the host printed at startup.');return}
  setBusy(true);setError('');
  try{
   const res=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:value})});
   const body=await res.json().catch(()=>({}) as any);
   if(!res.ok) throw Error(body?.error||'The host refused that token.');
   // Hold it as well as the cookie: if the browser drops the cookie, the header keeps the panel working.
   rememberToken(value);
   onUnlocked();
  }catch(reason:any){setError(sessionError(reason))}
  finally{setBusy(false)}
 }
 return <div className="unlock-screen">
  <form className="unlock-card" onSubmit={submit}>
   <div className="unlock-brand"><span className="brand-symbol">✳</span> scout<span className="brand-dot">®</span></div>
   <h1>Operator panel locked</h1>
   <p className="unlock-lead">
    {remoteEnabled?<>This panel is served from <b>{session?.host||location.host}</b>, which is not this browser&apos;s own machine, so the host asks for the panel token before it accepts any change.</>
    :<>Remote control is switched off on <b>{session?.host||location.host}</b>. The overlay keeps working; the panel can only be operated on the observer machine.</>}
   </p>
   {remoteEnabled&&<>
    <label className="field"><span>PANEL TOKEN</span>
     <input type="password" value={token} autoFocus autoComplete="off" spellCheck={false} placeholder="paste the token from the host console" onChange={event=>setToken(event.target.value)}/>
    </label>
    <button className="button primary wide" type="submit" disabled={busy}><KeyRound size={15}/>{busy?'Checking…':'Unlock panel'}</button>
    <p className="unlock-hint">The host prints a ready-to-open link with the token in it when it starts. Protect that one-time console output. The token is never stored in configuration or returned by an API, and routine request/audit logs omit it. Set <code>SCOUT_PANEL_TOKEN</code> to keep one token across restarts.</p>
   </>}
   <div className="unlock-facts">
    <span><Monitor size={13}/>{session?.local?'This machine':'Another machine'}</span>
    <span><Wifi size={13}/>{session?.address||'unknown address'}</span>
    <span><ShieldCheck size={13}/>{session?.remoteEnabled?'token required':'remote control off'}</span>
   </div>
   {(error||message)&&<p className="unlock-error">{error||message}</p>}
  </form>
 </div>;
}
// The header chip: what this session is, where it came from, and the way out. A local session has
// nothing to sign out of, so the button only appears for a remote one.
export function SessionPill({session,onLogout}:{session:PanelSessionView|null;onLogout:()=>void}){
 if(!session) return <span className="local-pill"><span className="status-dot"/> LOCAL SESSION</span>;
 if(session.local) return <span className="local-pill" title={`Requests from this machine are trusted: the panel is open on ${session.host||'this host'}.`}><span className="status-dot"/> LOCAL SESSION · {session.role?.toUpperCase()||'OWNER'}</span>;
 if(!session.authenticated) return <span className="local-pill remote locked" title="This visitor has no panel authority."><span className="status-dot amber"/> REMOTE · LOCKED</span>;
 const until=session.expiresAt?new Date(session.expiresAt).toLocaleTimeString():null;
 return <span className={'local-pill remote role-'+(session.role||'viewer')} title={`${session.operator} · ${session.role?.toUpperCase()} · ${session.address}${until?` · session ends around ${until}`:''}`}>
  <span className="status-dot"/> REMOTE · {session.via==='header'?'TOKEN':'SESSION'} · {session.address||session.host} · {session.operator||'Operator'} · {session.role?.toUpperCase()||'VIEWER'}
  <button className="logout-button" onClick={onLogout}><LogOut size={11}/>Sign out</button>
 </span>;
}
