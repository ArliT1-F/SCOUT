import React,{useEffect,useState} from 'react';
import {DownloadCard} from './site';
import {TournamentsCard} from './platform-admin';
import type {AccountView,DownloadView} from '../server/beta';

// The app's dashboard — `/app`, opened by the Tauri shell on the local host. This is the surface the
// old website dashboard became: account status, tournaments, the installer, linked launchers and the
// launcher-code approval. The website no longer serves any of it (src/site.tsx).
//
// The panel (`/`) is the other app window: teams, maps, scenes, OBS, Overlay Studio and every other
// broadcast setting. The static `src-tauri/ui/launcher.html` is only the splash before the host
// answers; it navigates here as soon as it can.
type BetaStatus={mode:string;account:AccountView|null;download:DownloadView|null;host:string;reviewNote:string};
type LinkView={linked:boolean;deviceId:string|null;email:string|null;displayName:string|null;linkedAt:number|null;pending:{userCode:string;deviceCode:string;expiresAt:number}|null;installationId:string};
type Licence={state:string;enforced?:boolean;email?:string;message?:string};
type LinkState={mode:string;link:LinkView;sync?:any};
const statusLabel=(status:string)=>status==='approved'?'APPROVED':status==='rejected'?'NOT APPROVED':status==='revoked'?'REVOKED':'IN REVIEW';
const statusTone=(status:string)=>status==='approved'?'ok':status==='rejected'||status==='revoked'?'bad':'warn';

export function AppHome(){
 const hostUrl=location.origin;
 const queryCode=new URLSearchParams(location.search).get('link')||'';
 const [hostOk,setHostOk]=useState<boolean|null>(null);
 const [gsi,setGsi]=useState<any>(null);
 const [beta,setBeta]=useState<BetaStatus|null>(null);
 const [licence,setLicence]=useState<Licence|null>(null);
 const [link,setLink]=useState<LinkState|null>(null);
 const [busy,setBusy]=useState<string|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [copied,setCopied]=useState<string|null>(null);
 const [code,setCode]=useState(queryCode);
 const refresh=React.useCallback(async()=>{
  const get=async(path:string)=>{try{const res=await fetch(hostUrl+path,{cache:'no-store',headers:{Accept:'application/json'}});return res.ok?await res.json():null}catch{return null}};
  const [health,status,betaStatus,licenceView,linkView]=await Promise.all([
   get('/healthz'),get('/api/status'),get('/api/beta/status'),get('/api/beta/license'),get('/api/beta/link'),
  ]);
  setHostOk(!!health?.ok);
  if(status) setGsi(status.gsi||null);
  if(betaStatus) setBeta(betaStatus);
  if(licenceView) setLicence(licenceView);
  if(linkView) setLink(linkView);
  if(!linkView?.link?.pending&&queryCode) setCode(queryCode);
 }, [hostUrl,queryCode]);
 useEffect(()=>{let stop=false;const tick=()=>{if(!stop)void refresh()};tick();const timer=setInterval(tick,3000);return()=>{stop=true;clearInterval(timer)}},[refresh]);
 // A pending code is the one thing an operator needs in front of them, so fill it in automatically.
 useEffect(()=>{if(link?.link?.pending?.userCode) setCode(current=>current||link.link.pending!.userCode)},[link]);
 const account=beta?.account??null;
 const receiving=!!(gsi?.accepted&&gsi?.lastPacketAt&&Date.now()-gsi.lastPacketAt<5000);
 const licenceState=licence?.state||'unknown';
 const licenceRunnable=['active','unknown','offline'].includes(licenceState);
 const pending=link?.link?.pending||null;
 const pill=(text:string,cls:string)=><span className={`pill ${cls}`}>{text}</span>;
 async function copy(text:string,key:string){try{await navigator.clipboard.writeText(text);setCopied(key);setTimeout(()=>setCopied(null),1200)}catch{}}
 async function post(path:string,body?:unknown){
  const res=await fetch(hostUrl+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const payload=await res.json().catch(()=>({}));
  return {ok:res.ok,status:res.status,body:payload as any};
 }
 async function startLink(){
  setBusy('start');setError('');setNotice('');
  const result=await post('/api/beta/link/start',{label:navigator.platform});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'Could not start a link.');return}
  setCode(result.body?.code||'');
  setNotice('Launcher code created. Approve it below with the account that owns this installation.');
  void refresh();
 }
 async function unlink(){
  setBusy('unlink');setError('');setNotice('');
  const result=await post('/api/beta/link/unlink',{});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'Could not unlink this installation.');return}
  setNotice('This installation was unlinked. Its token stops working immediately.');
  void refresh();
 }
 async function decide(next:boolean){
  if(!code.trim()){setError('Type the code the launcher is showing.');return}
  setBusy('device');setError('');setNotice('');
  const result=await post(`/api/beta/device/${next?'approve':'deny'}`,{userCode:code});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That code could not be used.');return}
  setNotice(next?'Launcher linked to your account.':'Launcher request refused.');
  void refresh();
 }
 async function revoke(deviceId:string,label:string){
  setBusy(deviceId);setError('');setNotice('');
  const result=await post('/api/beta/devices/revoke',{deviceId});
  setBusy(null);
  if(!result.ok){setError(result.body?.error||'That launcher could not be unlinked.');return}
  setNotice(`${label} was unlinked. Its token stops working immediately.`);
  void refresh();
 }
 // The launcher-link card has three states and each is a small block; keeping them out of the JSX
 // tree makes the three-way branch readable (and avoids nested ternaries in the markup).
 let linkCard: React.ReactNode;
 if(link?.link.linked){
  linkCard=<>
   <div className="lh-kv"><span>Linked to</span><b>{link.link.email}</b></div>
   <div className="lh-kv"><span>Device</span><b>{link.link.deviceId?.slice(0,8)||'—'}</b></div>
   <div className="lh-row" style={{marginTop:12}}><button className="lh-btn" disabled={busy==='unlink'} onClick={()=>void unlink()}>{busy==='unlink'?'Unlinking…':'Unlink this installation'}</button></div>
  </>;
 }else if(pending){
  linkCard=<>
   <p className="lh-small" style={{marginTop:0}}>Approve this code with your account. It expires {new Date(pending.expiresAt).toLocaleTimeString()}.</p>
   <div className="lh-code">{pending.userCode}</div>
   <div className="lh-row"><button className="lh-btn" onClick={()=>void copy(pending.userCode,'code')}>{copied==='code'?'Copied!':'Copy code'}</button></div>
   {account&&<>
    <input className="lh-code-input" style={{marginTop:10}} value={code} onChange={event=>setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" spellCheck={false}/>
    <div className="lh-row" style={{marginTop:8}}>
     <button className="lh-btn primary" disabled={busy==='device'} onClick={()=>void decide(true)}>{busy==='device'?'Working…':'Approve this launcher'}</button>
     <button className="lh-btn" disabled={busy==='device'} onClick={()=>void decide(false)}>Refuse</button>
    </div>
   </>}
   {!account&&<p className="lh-small">Sign in above to approve it. You can also approve it on the website&apos;s <a href={`/login?link=${encodeURIComponent(code||'')}&next=/app`}>login page</a>.</p>}
  </>;
 }else{
  linkCard=<>
   <p className="lh-small" style={{marginTop:0}}>This installation is not linked to an account yet. Linking it tells the platform which launcher is yours; the overlay itself works either way.</p>
   <button className="lh-btn primary" disabled={busy==='start'} onClick={()=>void startLink()}>{busy==='start'?'Starting…':'Start a link'}</button>
   {code&&<><input className="lh-code-input" style={{marginTop:10}} value={code} onChange={event=>setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" spellCheck={false}/>
    <div className="lh-row" style={{marginTop:8}}><button className="lh-btn primary" disabled={!account||busy==='device'} onClick={()=>void decide(true)}>Approve with this account</button></div>
    {!account&&<p className="lh-small">Sign in to approve the code.</p>}</>}
  </>;
 }
 async function signOut(){
  setBusy('signout');
  await fetch(hostUrl+'/api/beta/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});
  location.assign('/login?next=/app');
 }
 return (
  <div className="launcher-home">
   <style>{`
    .launcher-home{min-height:100vh;background:#0b0a0d;color:#f3eef8;font:14px/1.5 system-ui,Segoe UI,sans-serif}
    .launcher-home header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid #2a2632;background:#0f0e12}
    .launcher-home .pill{padding:5px 10px;border-radius:20px;border:1px solid #2a2632;font-size:11px;font-weight:700;letter-spacing:.04em}
    .launcher-home .pill.ok{color:#8ce0b4;background:#0e2a1f;border-color:#1b4a33} .launcher-home .pill.warn{color:#ffcf8a;background:#2f2110;border-color:#5a3a11} .launcher-home .pill.bad{color:#ff9aac;background:#2a0f18;border-color:#5a1a2a} .launcher-home .pill.live{color:#fff;background:#d970c2;border-color:#d970c2}
    .lh-body{padding:18px;max-width:1240px;margin:0 auto;display:grid;grid-template-columns:1fr 390px;gap:16px;background:radial-gradient(1200px 600px at 20% -10%, #20172a 0%, transparent 60%)}
    .lh-col{display:flex;flex-direction:column;gap:16px;min-width:0}
    .lh-card{background:#17141c;border:1px solid #2a2632;border-radius:14px;padding:16px;min-width:0}
    .lh-card h2{margin:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#f0a9e2}
    .lh-hero{grid-column:1/-1;background:linear-gradient(135deg,#1c1228,#2a1838);border:1px solid #3a2852}
    .lh-hero p{color:#c9b8dc;font-size:13px;margin:6px 0 0}
    .lh-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
    .lh-step{background:#1e1b24;border:1px solid #2a2632;border-radius:10px;padding:12px;display:flex;gap:10px;align-items:center}
    .lh-step b{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#2a2632;font-size:12px}
    .lh-step.done b{background:#3dd68c;color:#052e1c}
    .lh-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .lh-btn{appearance:none;border:1px solid #2a2632;background:#1e1b24;color:#f3eef8;border-radius:10px;padding:14px;text-align:left;cursor:pointer;display:flex;gap:12px;align-items:center;text-decoration:none;font:inherit}
    .lh-btn.primary{background:linear-gradient(135deg,#d970c2,#9b4fc0);border-color:transparent;color:#fff}
    .lh-btn i{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.08);font-style:normal}
    .lh-kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #1a1920;font-size:12px}
    .lh-kv span{color:#9a8eac}.lh-kv b{text-align:right;word-break:break-word}
    .lh-code{font:700 18px/1 monospace;letter-spacing:.1em;background:#0f0e12;border:1px dashed #3d3560;border-radius:8px;padding:10px;text-align:center;margin:8px 0}
    .lh-row{display:flex;gap:8px;flex-wrap:wrap}
    .lh-small{color:#9a8eac;font-size:11px;line-height:1.7}
    .lh-error{color:#ff9aac;font-size:12px;margin:8px 0 0}.lh-ok{color:#8ce0b4;font-size:12px;margin:8px 0 0}
    .lh-code-input{width:100%;background:#0f0e12;border:1px solid #3d3560;border-radius:8px;color:#f3eef8;padding:10px;font:700 15px/1.2 monospace;letter-spacing:.08em;text-transform:uppercase}
    .lh-devices{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
    .lh-devices li{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #2a2632;border-radius:8px;padding:9px 11px;background:#1e1b24}
    .lh-devices b{font-size:12px;display:block}.lh-devices small{color:#9a8eac;font-size:10px}
    .lh-mini{appearance:none;border:1px solid #2a2632;background:#0f0e12;color:#c9b8dc;border-radius:6px;padding:6px 9px;font-size:10px;cursor:pointer}
    .lh-mini:hover{border-color:#9b4fc0;color:#fff}
    .launcher-home .site-card{background:#17141c;border:1px solid #2a2632}
    @media(max-width:960px){.lh-body{grid-template-columns:1fr}.lh-steps{grid-template-columns:1fr}.lh-actions{grid-template-columns:1fr}}
   `}</style>

   <header>
    <img src="/logo/scout-mark.svg" alt="SCOUT" width={36} height={36} style={{flex:'0 0 auto'}}/>
    <div>
     <div style={{fontWeight:800,letterSpacing:'.02em'}}>scout<span style={{color:'#f0a9e2'}}>®</span> — Dashboard</div>
     <div style={{color:'#9a8eac',fontSize:12}}>This is the app. The website only handles access.</div>
    </div>
    <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
     {hostOk===null?pill('HOST …',''):hostOk?pill('HOST ONLINE','ok'):pill('HOST OFFLINE','bad')}
     {receiving?pill('CS2 LIVE','live'):pill('CS2 WAITING','warn')}
     {licence?pill((licenceState||'…').toUpperCase()+(licence.enforced?' · ENFORCED':''),licenceRunnable?'ok':'bad'):pill('ACCOUNT …','')}
     <a className="lh-btn" href="/" style={{padding:'8px 12px'}} title="Teams, maps, scenes and every overlay setting">Control panel</a>
     <a className="lh-btn" href="/welcome" style={{padding:'8px 12px'}}>Website</a>
    </div>
   </header>

   <div className="lh-body">
    <div className="lh-card lh-hero">
     <h2 style={{color:'#fff',fontSize:15,textTransform:'none',letterSpacing:0}}>Welcome, operator</h2>
     <p>Everything for the broadcast lives here and in the control panel. The transparent <code>/obs</code> overlay keeps working even when this window is closed.</p>
     <div className="lh-steps">
      <div className={`lh-step ${account?.status==='approved'?'done':''}`}><b>1</b><div><div style={{fontWeight:700,fontSize:12}}>{account?.status==='approved'?'✓ Account connected':account?.status==='revoked'?'Access revoked':account?'Application in review':'Sign in'}</div><div style={{color:'#9a8eac',fontSize:11}}>{account?.email||'Whitelisted accounts only'}</div></div></div>
      <div className={`lh-step ${hostOk?'done':''}`}><b>2</b><div><div style={{fontWeight:700,fontSize:12}}>Host running</div><div style={{color:'#9a8eac',fontSize:11}}>{hostOk?'Online':'Starting…'}</div></div></div>
      <div className={`lh-step ${receiving?'done':''}`}><b>3</b><div><div style={{fontWeight:700,fontSize:12}}>CS2 feed</div><div style={{color:'#9a8eac',fontSize:11}}>{receiving?'Receiving':'Waiting for /gsi push'}</div></div></div>
     </div>
    </div>

    <div className="lh-col">
     <div className="lh-card">
      <h2>Your account</h2>
      {account?<>
       <div className="lh-kv"><span>Signed in</span><b>{account.email}</b></div>
       <div className="lh-kv"><span>Status</span><b style={{color:account.status==='approved'?'#8ce0b4':account.status==='rejected'||account.status==='revoked'?'#ff9aac':'#ffcf8a'}}>{statusLabel(account.status)}</b></div>
       <div className="lh-kv"><span>Organisation</span><b>{account.organisation||'—'}</b></div>
       <div className="lh-row" style={{marginTop:12}}>
        <a className="lh-btn" href="/download" style={{padding:'9px 12px'}}>Download page</a>
        <button className="lh-btn" style={{padding:'9px 12px'}} disabled={busy==='signout'} onClick={()=>void signOut()}>{busy==='signout'?'Signing out…':'Sign out'}</button>
       </div>
      </>:<>
       <p className="lh-small" style={{marginTop:0}}>The dashboard is account-owned. Sign in with the address that was approved for the closed beta — or apply on the website first.</p>
       <div className="lh-row">
        <a className="lh-btn primary" href="/login?next=/app" style={{padding:'10px 14px'}}>Sign in</a>
        <a className="lh-btn" href="/apply" style={{padding:'10px 14px'}}>Apply for access</a>
       </div>
      </>}
      {notice&&<p className="lh-ok">{notice}</p>}
      {error&&<p className="lh-error">{error}</p>}
     </div>

     {account&&<div className="lh-card"><h2>Tournaments</h2><p className="lh-small" style={{marginTop:0}}>Each tournament is yours alone. Activating one loads its teams, bracket and scenes into this host.</p><TournamentsCard/></div>}

     {account&&<div className="lh-card"><h2>Linked launchers</h2>
      {account.devices.length?<ul className="lh-devices">{account.devices.map(device=><li key={device.id}><div><b>{device.label||'Launcher'}</b><small>{device.platform} · last seen {new Date(device.lastSeenAt).toLocaleString()}</small></div><button className="lh-mini" disabled={busy===device.id} onClick={()=>void revoke(device.id,device.label||'Launcher')}>{busy===device.id?'…':'Unlink'}</button></li>)}</ul>
       :<p className="lh-small" style={{marginTop:0}}>No launcher is linked to this account yet. Use the card on the right to link this installation.</p>}
     </div>}
    </div>

    <div className="lh-col">
     {account&&<DownloadCard account={account} download={beta?.download??null}/>}

     <div className="lh-card">
      <h2>Launcher link</h2>
      {linkCard}
      <p className="lh-small" style={{marginTop:10}}>Licence: <b style={{color:licenceRunnable?'#8ce0b4':'#ff9aac'}}>{licenceState.toUpperCase()}</b>{licence?.message?` · ${licence.message}`:''}</p>
     </div>

     <div className="lh-card">
      <h2>Broadcast</h2>
      <div className="lh-actions">
       <a className="lh-btn primary" href="/"><i>◧</i><div><b>Open control panel</b><div style={{color:'#fff',opacity:.85,fontSize:11}}>Teams, maps, scenes, overlay settings</div></div></a>
       <a className="lh-btn" href="/obs?checker=1" target="_blank" rel="noreferrer"><i>◎</i><div><b>Test overlay</b><div style={{color:'#9a8eac',fontSize:11}}>Checker proves transparency</div></div></a>
       <button className="lh-btn" onClick={()=>void copy(hostUrl+'/obs','obs')}><i>⧉</i><div><b>{copied==='obs'?'Copied!':'Copy OBS URL'}</b><div style={{color:'#9a8eac',fontSize:11}}>{hostUrl}/obs</div></div></button>
       <a className="lh-btn" href="/"><i>⚙</i><div><b>Setup guide</b><div style={{color:'#9a8eac',fontSize:11}}>CS2 cfg + OBS steps in the panel</div></div></a>
      </div>
      <div className="lh-kv" style={{marginTop:12}}><span>OBS source</span><b>{hostUrl}/obs</b></div>
      <div className="lh-kv"><span>CS2</span><b>{receiving?'Receiving':'Waiting'}</b></div>
      <div className="lh-kv"><span>Panel</span><b>{hostUrl}/</b></div>
      <p className="lh-small" style={{marginTop:10}}>Shortcuts: <b>F9</b> panel · <b>F8</b> overlay · <b>Ctrl+Shift+F8</b> quit</p>
     </div>
    </div>
   </div>

   <footer style={{padding:'10px 18px',borderTop:'1px solid #2a2632',display:'flex',justifyContent:'space-between',gap:10,color:'#9a8eac',fontSize:11,flexWrap:'wrap'}}>
    <span>GSI only · No injection · External overlay</span>
    <span><a href="/welcome" style={{color:'#f0a9e2'}}>scout website</a> · <a href="/" style={{color:'#f0a9e2'}}>control panel</a> · v0.1.0</span>
   </footer>
  </div>
 );
}
