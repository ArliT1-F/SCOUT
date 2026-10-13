import React,{useCallback,useEffect,useState} from 'react';
import {Check,Loader2,Plus,RefreshCw,Shield,Trash2,Trophy} from 'lucide-react';
// /admin — the SCOUT platform owner's desk, and the whitelisted user's tournament card.
// The server decides who the owner is (SCOUT_OWNER_EMAIL, server/platform.ts); these components
// only render what /api/platform/* answers, so a non-owner never sees admin data by hiding UI.
async function api(path:string,init:RequestInit={}){
 const res=await fetch(path,{headers:{'Content-Type':'application/json',...(init.headers||{})},...init});
 return {res,body:await res.json().catch(()=>({}) as any)};
}
export function PlatformAdminPage(){
 const [data,setData]=useState<any>(null);const [error,setError]=useState('');const [settings,setSettings]=useState<any>(null);const [busy,setBusy]=useState('');const [notice,setNotice]=useState('');
 const load=useCallback(async()=>{
  const {res,body}=await api('/api/platform/admin');
  if(!res.ok){setError(body?.error||'The SCOUT owner could not be verified.');setData(null);return}
  setData(body);setSettings(body.settings);setError('');
 },[]);
 useEffect(()=>{void load();const t=setInterval(()=>void load(),15000);return()=>clearInterval(t)},[load]);
 async function decide(id:string,decision:'approve'|'reject'){
  setBusy(id);const {res,body}=await api(`/api/beta/applications/${id}`,{method:'POST',body:JSON.stringify({decision})});setBusy('');
  if(!res.ok){setNotice(body?.error||'That decision could not be saved.');return} setNotice(`${body.application?.email||'Applicant'} ${decision==='approve'?'approved — send them the invite link from the console/panel':'rejected'}.`);void load();
 }
 async function saveSettings(){
  setBusy('settings');const {res,body}=await api('/api/platform/admin/settings',{method:'PUT',body:JSON.stringify(settings)});setBusy('');
  if(!res.ok){setNotice(body?.error||'Settings could not be saved.');return} setSettings(body.settings);setNotice(`Settings v${body.settings.version} saved — open panels receive them in real time.`);void load();
 }
 if(error) return <div className="site"><main className="site-main site-narrow"><section className="site-card site-done"><span className="site-card-icon"><Shield size={17}/></span><h2>SCOUT admin is owner-only</h2><p className="site-card-lead">{error} Sign in with the account named by <code>SCOUT_OWNER_EMAIL</code>, then reload. Whitelisted users host their tournaments from their <a href="/dashboard">dashboard</a> instead.</p><div className="site-cta"><a className="button primary" href="/login">Sign in</a><a className="button" href="/dashboard">My dashboard</a></div></section></main></div>;
 if(!data) return <div className="site"><main className="site-main site-narrow"><p className="site-loading"><Loader2 className="spin" size={16}/>Loading the SCOUT admin…</p></main></div>;
 const accounts=data.users||[];
 return <div className="site"><main className="site-main">
  <div className="site-dash-head"><div><span className="site-section-eyebrow">SCOUT PLATFORM ADMIN</span><h1>Owner desk</h1><p>Whitelisting, per-user tournaments, match-log metrics and settings that reach every open panel in real time.</p></div><button className="button" onClick={()=>void load()}><RefreshCw size={13}/>Refresh</button></div>
  {notice&&<p className="info-note">{notice}</p>}
  <div className="site-dash-grid">
   <section className="site-card"><h3><Trophy size={15}/> Platform totals</h3><div className="feed-counters">
    {[['Kills',data.totals.kills],['Headshots',data.totals.headshots],['Grenades exploded',data.totals.grenades],['Rounds',data.totals.rounds],['Maps',data.totals.maps],['Matches',data.totals.matches],['Tournaments',data.tournaments.length]].map(([l,v]:any)=><div className="feed-counter" key={l}><b>{v}</b><small>{String(l).toUpperCase()}</small></div>)}
   </div><p className="site-fineprint">Aggregated from every user&apos;s tournament match logs. Enable “Public stats” below to show these totals on /welcome.</p></section>
   <section className="site-card"><h3>Platform settings <span className="site-count">v{settings?.version}</span></h3>
    <label className="field"><span>MAX TOURNAMENTS PER USER (BETA 3 · RELEASE 1)</span><input type="number" min={1} max={25} value={settings?.maxTournamentsPerUser??3} onChange={e=>setSettings({...settings,maxTournamentsPerUser:Number(e.target.value)})}/></label>
    <label className="field"><span>REVIEW NOTE SHOWN TO APPLICANTS</span><input value={settings?.reviewNote||''} onChange={e=>setSettings({...settings,reviewNote:e.target.value})}/></label>
    <div className="toggle-row"><div><b>Whitelist applications open</b><small>When off, /apply refuses new applications; existing accounts keep working.</small></div><button className={'toggle '+(settings?.applicationsOpen?'enabled':'')} aria-pressed={!!settings?.applicationsOpen} onClick={()=>setSettings({...settings,applicationsOpen:!settings.applicationsOpen})}><i/></button></div>
    <div className="toggle-row"><div><b>Public stats on /welcome</b><small>Show the platform totals (kills, headshots, grenades…) publicly.</small></div><button className={'toggle '+(settings?.publicStatsEnabled?'enabled':'')} aria-pressed={!!settings?.publicStatsEnabled} onClick={()=>setSettings({...settings,publicStatsEnabled:!settings.publicStatsEnabled})}><i/></button></div>
    <button className="button primary" disabled={busy==='settings'} onClick={()=>void saveSettings()}>{busy==='settings'?<Loader2 className="spin" size={13}/>:<Check size={13}/>}Save &amp; push to everyone</button>
   </section>
   <section className="site-card site-devices"><h3>Whitelisted users &amp; their tournaments</h3>
    {accounts.length?<ul className="site-device-list">{accounts.map((u:any)=><li key={u.accountId}><div><b>{u.email}</b><small>{u.status} · {u.tournaments} tournament(s) · {u.totals.kills} kills · {u.totals.headshots} HS · {u.totals.grenades} grenades · {u.totals.matches} matches{u.lastActiveAt?` · last active ${new Date(u.lastActiveAt).toLocaleString()}`:''}</small></div></li>)}</ul>:<p className="site-card-lead">No whitelisted user has created a tournament yet.</p>}
    <p className="site-fineprint">Approve/reject applications below (or in the panel&apos;s Beta applications tab — both are owner-only now).</p>
    <AdminApplications onDecide={decide} busy={busy}/>
   </section>
   <section className="site-card site-devices"><h3>Recent match log</h3>
    {data.recentLogs?.length?<ul className="site-device-list">{data.recentLogs.slice(0,30).map((log:any,i:number)=><li key={i}><div><b>{log.kind} ×{log.count}</b><small>{log.map||''} {log.detail||''} · {new Date(log.at).toLocaleString()}</small></div></li>)}</ul>:<p className="site-card-lead">No match events collected yet. They are recorded automatically from the live GSI feed of whichever tournament is active, and can be posted to <code>/api/platform/tournaments/:id/metrics</code>.</p>}
   </section>
  </div>
 </main></div>;
}
function AdminApplications({onDecide,busy}:{onDecide:(id:string,d:'approve'|'reject')=>void;busy:string}){
 const [apps,setApps]=useState<any[]>([]);
 useEffect(()=>{void (async()=>{const {res,body}=await api('/api/beta/applications');if(res.ok)setApps(body.applications||[])})()},[busy]);
 if(!apps.length) return <p className="site-fineprint">No applications waiting or recorded.</p>;
 return <div className="beta-list">{apps.map((a:any)=><article key={a.id} className={'beta-row '+a.status}><div className="beta-who"><b>{a.displayName}</b><small>{a.email}{a.organisation?` · ${a.organisation}`:''}</small></div><span className="site-status">{a.status}</span><div className="beta-actions">{a.status!=='approved'&&<button className="button primary" disabled={busy===a.id} onClick={()=>onDecide(a.id,'approve')}>Approve</button>}{a.status!=='rejected'&&<button className="button danger-button" disabled={busy===a.id} onClick={()=>onDecide(a.id,'reject')}>Reject</button>}</div></article>)}</div>;
}
// The whitelisted user's own desk, shown on /dashboard.
export function TournamentsCard(){
 const [list,setList]=useState<any[]>([]);const [limit,setLimit]=useState(3);const [active,setActive]=useState<string|null>(null);const [name,setName]=useState('');const [error,setError]=useState('');const [notice,setNotice]=useState('');const [visible,setVisible]=useState(true);
 const load=useCallback(async()=>{const {res,body}=await api('/api/platform/tournaments');if(!res.ok){setVisible(false);return}setList(body.tournaments||[]);setLimit(body.limit||3);setActive(body.activeTournamentId||null)},[]);
 useEffect(()=>{void load();const t=setInterval(()=>void load(),15000);return()=>clearInterval(t)},[load]);
 async function create(){setError('');const {res,body}=await api('/api/platform/tournaments',{method:'POST',body:JSON.stringify({name:name||'My tournament'})});if(!res.ok){setError(body?.error||'Could not create it.');return}setName('');setNotice('Tournament created — it is yours alone; no other user can see or edit it.');void load()}
 async function act(id:string,action:'activate'|'delete'){setError('');const {res,body}=await api(`/api/platform/tournaments/${id}${action==='activate'?'/activate':''}`,{method:action==='activate'?'POST':'DELETE'});if(!res.ok){setError(body?.error||'That did not work.');return}setNotice(action==='activate'?'Tournament is live: its teams, bracket and scenes now drive your overlay.':'Tournament deleted.');void load()}
 if(!visible) return null;
 return <section className="site-card site-devices"><span className="site-card-icon"><Trophy size={17}/></span>
  <h3>My tournaments <span className="site-count">{list.length}/{limit}</span></h3>
  <p className="site-card-lead">Host your own tournament independently: your teams, bracket, scenes and match stats are separate from every other whitelisted user. Activating one loads it into the live overlay.</p>
  {error&&<p className="unlock-error">{error}</p>}{notice&&<p className="site-fineprint">{notice}</p>}
  {list.length?<ul className="site-device-list">{list.map(t=><li key={t.id}><div><b>{t.name}{active===t.id?' · LIVE':''}</b><small>{t.hasConfig?'configured':'no config yet'} · {t.totals?.kills||0} kills · {t.totals?.headshots||0} HS · {t.totals?.grenades||0} grenades · updated {new Date(t.updatedAt).toLocaleString()}</small></div><span><button className="mini-button" disabled={active===t.id} onClick={()=>void act(t.id,'activate')}>Activate</button>{' '}<button className="mini-button danger" onClick={()=>void act(t.id,'delete')}><Trash2 size={11}/>Delete</button></span></li>)}</ul>:<p className="site-card-lead">None yet — create your first below.</p>}
  <label className="field"><span>NEW TOURNAMENT NAME</span><input value={name} onChange={e=>setName(e.target.value)} placeholder="Spring Cup"/></label>
  <button className="button primary" disabled={list.length>=limit} onClick={()=>void create()}><Plus size={13}/>Create tournament{list.length>=limit?` (limit ${limit} reached)`:''}</button>
 </section>;
}
export function PublicStats(){
 const [stats,setStats]=useState<any>(null);
 useEffect(()=>{void (async()=>{const {res,body}=await api('/api/platform/stats');if(res.ok&&body.enabled)setStats(body)})()},[]);
 if(!stats) return null;
 return <section className="site-card"><h3>Live on SCOUT so far</h3><div className="feed-counters">{[['Kills',stats.totals.kills],['Headshots',stats.totals.headshots],['Grenades exploded',stats.totals.grenades],['Rounds',stats.totals.rounds],['Matches',stats.totals.matches]].map(([l,v]:any)=><div className="feed-counter" key={l}><b>{v}</b><small>{String(l).toUpperCase()}</small></div>)}</div></section>;
}
