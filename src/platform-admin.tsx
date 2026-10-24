import React,{useCallback,useEffect,useRef,useState} from 'react';
import {DEFAULT_MAP_ROTATION} from './map-rotation';
import {Activity,ArrowDownToLine,ArrowRight,ArrowUpRight,Check,ChevronLeft,ChevronRight,Clock3,LayoutDashboard,Loader2,Mail,Pause,Play,Plus,RefreshCw,Search,Settings2,Shield,Trash2,Trophy,Users,X} from 'lucide-react';
import {ScoutBrand} from './logo';
import type {ApplicationReviewView} from '../server/beta';
import type {PlatformSettings,PlatformStore} from '../server/platform';
import {downloadCsv,invitationState,matchesSearch} from './admin-model';
// The server authorizes every owner endpoint. No private data or sample accounts are embedded here.
async function api(path:string,init:RequestInit={}){
 const res=await fetch(path,{...init,signal:init.signal??AbortSignal.timeout(12000),headers:{'Content-Type':'application/json',...(init.headers||{})}});
 return {res,body:await res.json().catch(()=>({}) as any)};
}
type Summary=ReturnType<PlatformStore['adminSummary']>;
type DeskTab='overview'|'applications'|'users'|'activity'|'settings';
const tabs=[{id:'overview',label:'Overview',icon:LayoutDashboard},{id:'applications',label:'Applications',icon:Mail},{id:'users',label:'Users & tournaments',icon:Users},{id:'activity',label:'Match activity',icon:Activity},{id:'settings',label:'Platform settings',icon:Settings2}] as const;
const number=(n:number)=>n.toLocaleString();
const date=(at?:number|null)=>at?new Date(at).toLocaleString():'Not yet';

export function PlatformAdminPage(){
 const [data,setData]=useState<Summary|null>(null),[settings,setSettings]=useState<PlatformSettings|null>(null);
 const [review,setReview]=useState<ApplicationReviewView>({applications:[],invitations:{}});
 const [accessError,setAccessError]=useState(''),[loadError,setLoadError]=useState(''),[reviewError,setReviewError]=useState('');
 const [notice,setNotice]=useState(''),[actionError,setActionError]=useState(''),[busy,setBusy]=useState('');
 const [tab,setTab]=useState<DeskTab>('overview'),[auto,setAuto]=useState(true),[refreshing,setRefreshing]=useState(false),[updated,setUpdated]=useState<number|null>(null);
 const [reviewerText,setReviewerText]=useState('');
 const [dirty,setDirty]=useState(false);const dirtyRef=useRef(false),loading=useRef(false);
 const changeDirty=(value:boolean)=>{dirtyRef.current=value;setDirty(value)};
 useEffect(()=>{
  document.title='Owner desk — SCOUT';
  let tag=document.head.querySelector('meta[name="robots"]');
  if(!tag){tag=document.createElement('meta');tag.setAttribute('name','robots');document.head.append(tag)}
  tag.setAttribute('content','noindex, follow');
 },[]);
 useEffect(()=>{
  const protect=(e:BeforeUnloadEvent)=>{if(dirtyRef.current){e.preventDefault();e.returnValue=''}};
  window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);
 },[]);
 const load=useCallback(async()=>{
  if(loading.current)return;loading.current=true;setRefreshing(true);
  try{
   const {res,body}=await api('/api/platform/admin');
   if(!res.ok){
    if(res.status===401||res.status===403){setAccessError(body.error||'Sign in with the SCOUT owner account.');setData(null);setReview({applications:[],invitations:{}})}
    else setLoadError(body.error||'The platform could not be refreshed. Please retry.');
    return;
   }
   setAccessError('');setLoadError('');setData(body);if(!dirtyRef.current){setSettings(body.settings);setReviewerText((body.settings.betaReviewers||[]).join(', '))}setUpdated(Date.now());
   try{
    const result=await api('/api/beta/applications');
    if(!result.res.ok)throw new Error(result.body.error||'Applications could not be loaded.');
    setReview({applications:result.body.applications||[],invitations:result.body.invitations||{}});setReviewError('');
   }catch(e){setReviewError(e instanceof Error?e.message:'Applications could not be loaded.')}
  }catch{setLoadError('Connection interrupted. Displayed data may be out of date. Retry when you are back online.')}
  finally{loading.current=false;setRefreshing(false)}
 },[]);
 useEffect(()=>{void load()},[load]);
 useEffect(()=>{if(!auto)return;const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer)},[auto,load]);
 async function action(id:string,decision:'approve'|'reject'|'resend'){
  const app=review.applications.find(a=>a.id===id);
  if(decision==='reject'&&!window.confirm(`Reject ${app?.displayName||'this applicant'}? They will not receive an invitation.`))return;
  if(decision==='resend'&&!window.confirm(`Send a replacement invitation to ${app?.email||'this applicant'}? Any previous invitation link will stop working.`))return;
  setBusy(id);setNotice('');setActionError('');
  try{
   const {res,body}=await api(`/api/beta/applications/${encodeURIComponent(id)}${decision==='resend'?'/resend-invitation':''}`,{method:'POST',body:JSON.stringify(decision==='resend'?{}:{decision})});
   if(!res.ok)throw new Error(body.error||'The action could not be completed.');
   setNotice(decision==='reject'?`${app?.email||'Applicant'} rejected.`:`${decision==='resend'?'Replacement invitation':'Application approved — invitation'} ${body.invitationDelivery?.status==='pending'?'queued for delivery':'sent by email'}.`);
   await load();
  }catch(e){setActionError(e instanceof Error?e.message:'The action could not be completed.')}
  finally{setBusy('')}
 }
 function edit(patch:Partial<PlatformSettings>){changeDirty(true);setSettings(s=>s?{...s,...patch}:s)}
 async function saveSettings(){
  if(!settings)return;
  if(settings.betaReviewers.length>100||settings.betaReviewers.some(email=>email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))){setActionError('Enter valid reviewer email addresses, separated by commas (up to 100).');return}
  setBusy('settings');setNotice('');setActionError('');
  try{
   const {res,body}=await api('/api/platform/admin/settings',{method:'PUT',body:JSON.stringify(settings)});
   if(!res.ok)throw new Error(body.error||'Settings could not be saved.');
   changeDirty(false);setSettings(body.settings);setNotice(`Settings v${body.settings.version} saved. Online linked hosts refresh within 15 seconds; offline hosts retain their last settings.`);await load();
  }catch(e){setActionError(e instanceof Error?e.message:'Settings could not be saved.')}
  finally{setBusy('')}
 }
 const pending=review.applications.filter(a=>a.status==='pending').length;
 if(accessError||!data||!settings)return <div className="owner-desk"><div className="desk-gate"><ScoutBrand size={36}/><div className="desk-gate-icon"><Shield size={30}/></div><span className="desk-eyebrow">PRIVATE WORKSPACE</span><h1>{accessError?'Your platform. Owner access.':loadError?'Your platform is temporarily unavailable.':'Connecting to your platform'}</h1><p>{accessError||loadError||'Verifying your account and loading the SCOUT owner desk…'}</p>{accessError?<a className="desk-button primary" href="/login?next=/admin">Sign in as owner <ArrowRight size={16}/></a>:<button className="desk-button" disabled={refreshing} onClick={()=>void load()}>{refreshing?<Loader2 size={16} className="spin"/>:<RefreshCw size={16}/>} {refreshing?'Connecting…':'Try again'}</button>}<a className="desk-muted-link" href="/profile">Back to your profile</a></div></div>;
 const hs=data.totals.kills?Math.round(data.totals.headshots/data.totals.kills*100):0;
 return <div className="owner-desk">
  <aside className="desk-sidebar"><a href="/welcome" className="desk-brand" aria-label="SCOUT home"><ScoutBrand size={30}/></a><div className="desk-workspace"><span><Shield size={17}/></span><div><b>Owner workspace</b><small>SCOUT PLATFORM</small></div><span className="desk-dot"/></div><p className="desk-nav-label">MANAGEMENT</p><nav aria-label="Owner navigation">{tabs.map(item=><button key={item.id} aria-current={tab===item.id?'page':undefined} onClick={()=>setTab(item.id)}><item.icon size={18}/><span>{item.label}</span>{item.id==='applications'&&pending>0&&<b className="desk-nav-count">{pending}</b>}{item.id==='settings'&&dirty&&<i className="desk-dot amber"/>}</button>)}</nav><div className="desk-sidebar-bottom"><div className="desk-private"><Shield size={17}/><div><b>Private by design</b><p>Owner-only controls.<br/>Your broadcast stays yours.</p></div></div><a href="/profile"><span className="desk-avatar">SO</span><span><b>SCOUT owner</b><small>View your profile</small></span><ArrowUpRight size={16}/></a></div></aside>
  <div className="desk-body"><header className="desk-topbar"><span>Workspace <ChevronRight size={13}/> <b>{tabs.find(t=>t.id===tab)?.label}</b></span><div><span className="desk-access"><Shield size={12}/>Owner access</span><a href="/welcome">View website <ArrowUpRight size={14}/></a></div></header>
   <main className="desk-main" id="desk-main"><div className="desk-page-head"><div><span className="desk-eyebrow">SCOUT CONTROL CENTER</span><h1>{tab==='overview'?'A clear view of your platform.':tabs.find(t=>t.id===tab)?.label}</h1><p>{({overview:'Your community, your broadcasts, and everything in between.',applications:'Build your community. Review access and keep invitations moving.',users:'The organisers bringing their broadcasts to life.',activity:'A closer look at the events behind your platform totals.',settings:'Fine-tune access, map availability and the host experience.'})[tab]}</p></div><div className="desk-head-actions"><button className="desk-icon-button" aria-label={auto?'Pause automatic refresh':'Resume automatic refresh'} title={auto?'Pause automatic refresh':'Resume automatic refresh'} onClick={()=>setAuto(!auto)}>{auto?<Pause size={15}/>:<Play size={15}/>}</button><button className="desk-button" disabled={refreshing} onClick={()=>void load()}><RefreshCw size={14} className={refreshing?'spin':''}/>Refresh</button></div></div>
   <div className="desk-sync"><span className={'desk-dot '+(!auto?'amber':'')}/>{auto?'Auto-refresh every 15 seconds':'Auto-refresh paused'}<span>·</span><span>Last updated {updated?new Date(updated).toLocaleTimeString():'—'}</span></div>
   {(loadError||reviewError||actionError)&&<div className="desk-alert error" role="alert">{[loadError,reviewError,actionError].filter(Boolean).join(' ')}<button onClick={()=>void load()}>Retry refresh</button></div>}
   {notice&&<div className="desk-alert" role="status"><Check size={17}/><span>{notice}</span><button aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={16}/></button></div>}
   {tab==='overview'&&<>
    <section className="desk-hero"><div><span className="desk-eyebrow">THE BIG PICTURE</span><h2>Great broadcasts start<br/>with a great community.</h2><p>{reviewError?'Application data is temporarily unavailable. Refresh to check the review queue.':pending?`${pending} application${pending===1?' is':'s are'} waiting for your review. Your next organiser could be one of them.`:'You’re all caught up. Keep an eye on your community as the next broadcast takes shape.'}</p><button className="desk-button primary" onClick={()=>setTab('applications')}>Review applications <ArrowRight size={15}/></button></div><div className="desk-hero-art" aria-hidden="true"><div className="desk-orbit orbit-two"/><div className="desk-orbit"/><div className="desk-hero-mark"><Trophy size={47} strokeWidth={1.2}/></div><span className="desk-orbit-tag"><span className="desk-dot"/> BUILT FOR BROADCAST</span></div></section>
    <section className="desk-stats" aria-label="Platform statistics">{[{label:'Whitelisted users',value:data.users.length,icon:Users,note:'Organisers with platform access'},{label:'Tournaments',value:data.tournaments.length,icon:Trophy,note:'Across all owner workspaces'},{label:'Matches recorded',value:data.totals.matches,icon:Activity,note:`${number(data.totals.maps)} maps · ${number(data.totals.rounds)} rounds`},{label:'Awaiting review',value:pending,icon:Mail,note:reviewError?'Application data unavailable':'Closed-beta applications'}].map((s,i)=><article className={'desk-stat stat-'+i} key={s.label}><div><span>{s.label}</span><s.icon size={17}/></div><b>{i===3&&reviewError?'—':number(s.value)}</b><small>{s.note}</small></article>)}</section>
    <div className="desk-overview-grid"><section className="desk-panel"><PanelHead title="Broadcast performance" subtitle="All-time totals from tournament match logs" icon={Activity}/><div className="desk-performance"><div><span>Total kills recorded</span><strong>{number(data.totals.kills)}</strong><small>{number(data.totals.grenades)} grenades exploded</small></div><div className="desk-hs"><b>{hs}<small>%</small></b><span>Headshot rate</span></div></div><div className="desk-progress" role="progressbar" aria-label="Headshot rate" aria-valuenow={hs} aria-valuemin={0} aria-valuemax={100}><i style={{width:`${Math.min(hs,100)}%`}}/></div><div className="desk-panel-foot"><span>{number(data.totals.headshots)} headshots · {number(data.totals.rounds)} rounds</span><button onClick={()=>setTab('activity')}>Explore activity <ArrowRight size={14}/></button></div></section>
    <section className="desk-panel"><PanelHead title="Platform at a glance" subtitle="Your current access and configuration" icon={Shield}/><div className="desk-health"><div><span>Beta applications</span><Badge tone={data.settings.applicationsOpen?'green':'amber'}>{data.settings.applicationsOpen?'Accepting applications':'Paused'}</Badge></div><div><span>Public statistics</span><b>{data.settings.publicStatsEnabled?'Visible on website':'Private'}</b></div><div><span>Available maps</span><b>{data.settings.mapRotation.length} in rotation</b></div><div><span>Tournaments per user</span><b>{data.settings.maxTournamentsPerUser}</b></div></div><div className="desk-panel-foot"><span>Configuration v{data.settings.version}</span><button onClick={()=>setTab('settings')}>Manage settings <ArrowRight size={14}/></button></div></section></div>
    <section className="desk-panel"><PanelHead title="Recent match activity" subtitle="The latest events reported by linked hosts" icon={Activity} action={<button className="desk-text-button" onClick={()=>setTab('activity')}>View all activity <ArrowRight size={14}/></button>}/><LogRows logs={data.recentLogs.slice(0,5)}/></section>
   </>}
   {tab==='applications'&&!(reviewError&&!review.applications.length)&&<Applications review={review} busy={busy} onAction={action}/>}
   {tab==='users'&&<Members users={data.users}/>}
   {tab==='activity'&&<ActivityLog logs={data.recentLogs}/>}
   {tab==='settings'&&<section className="desk-panel desk-settings"><PanelHead title="Platform settings" subtitle={`Configuration v${settings.version} · Last saved ${date(settings.updatedAt)}`} icon={Settings2}/><fieldset disabled={busy==='settings'}><div className="desk-settings-section"><h3>Access & community</h3><p>Decide who can join and what they see while waiting.</p><SettingToggle label="Accept beta applications" description="When paused, new applications are refused. Existing accounts keep working." value={settings.applicationsOpen} onChange={v=>edit({applicationsOpen:v})}/><label className="desk-field">Applicant review note<textarea maxLength={400} rows={3} value={settings.reviewNote} onChange={e=>edit({reviewNote:e.target.value})}/><small>Shown to applicants · {settings.reviewNote.length}/400</small></label><label className="desk-field">Authorized beta reviewers<textarea rows={3} value={reviewerText} placeholder="reviewer@organisation.gg" onChange={e=>{setReviewerText(e.target.value);edit({betaReviewers:e.target.value.split(/[;,\n]/).map(v=>v.trim()).filter(Boolean)})}}/><small>Separate email addresses with commas. Reviewers can approve, reject and resend invitations, but cannot change settings.</small></label></div><div className="desk-settings-section"><h3>Host experience</h3><p>Changes reach online linked hosts within 15 seconds. Offline hosts keep their last settings.</p><label className="desk-field">Maximum tournaments per user<input type="number" min={1} max={25} step={1} value={settings.maxTournamentsPerUser} onChange={e=>edit({maxTournamentsPerUser:Number(e.target.value)})}/><small>Between 1 and 25 tournaments per organiser.</small></label><SettingToggle label="Publish platform statistics" description="Show aggregate broadcast totals publicly on /welcome. Individual user data stays private." value={settings.publicStatsEnabled} onChange={v=>edit({publicStatsEnabled:v})}/><h4>Available map rotation</h4><p>Select at least one map. Existing match series are not changed.</p><div className="desk-maps">{Array.from(new Set([...DEFAULT_MAP_ROTATION,...settings.mapRotation])).map(name=><label key={name} className={settings.mapRotation.includes(name)?'selected':''}><input type="checkbox" checked={settings.mapRotation.includes(name)} onChange={e=>edit({mapRotation:e.target.checked?[...settings.mapRotation,name]:settings.mapRotation.filter(m=>m!==name)})}/>{name.replace('de_','')}<Check size={14}/></label>)}</div></div></fieldset><div className="desk-save-bar"><div><span className={'desk-dot '+(dirty?'amber':'')}/>{dirty?'You have unsaved changes':'All changes saved'}</div><button className="desk-button" disabled={!dirty||!!busy} onClick={()=>{setSettings(data.settings);setReviewerText(data.settings.betaReviewers.join(', '));changeDirty(false)}}>Discard</button><button className="desk-button primary" disabled={!dirty||!!busy||!settings.mapRotation.length||!Number.isInteger(settings.maxTournamentsPerUser)||settings.maxTournamentsPerUser<1||settings.maxTournamentsPerUser>25} onClick={()=>void saveSettings()}>{busy==='settings'?<Loader2 className="spin" size={15}/>:<Check size={15}/>}Save & push to hosts</button></div></section>}
   <footer className="desk-footer"><ScoutBrand size={16} suffix={false}/><span>Made for the people behind the broadcast.</span><span>Private owner workspace <Shield size={12}/></span></footer>
   </main>
  </div>
 </div>;
}
function PanelHead({title,subtitle,icon:Icon,action}:{title:string;subtitle:string;icon:typeof Activity;action?:React.ReactNode}){return <div className="desk-panel-head"><div className="desk-panel-title"><span><Icon size={17}/></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>{action}</div>}
function Badge({children,tone='muted'}:{children:React.ReactNode;tone?:string}){return <span className={'desk-badge '+tone}>{children}</span>}
function Empty({title,detail}:{title:string;detail:string}){return <div className="desk-empty"><Search size={25}/><h3>{title}</h3><p>{detail}</p></div>}
function SearchBox({value,onChange,placeholder}:{value:string;onChange:(v:string)=>void;placeholder:string}){return <label className="desk-search"><Search size={16}/><input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}/></label>}
function Pager({page,total,size=10,onChange}:{page:number;total:number;size?:number;onChange:(page:number)=>void}){const last=Math.max(0,Math.ceil(total/size)-1);return <div className="desk-pagination"><span>{total?`${page*size+1}–${Math.min(total,(page+1)*size)} of ${total}`:'0 results'}</span><div><button className="desk-icon-button" aria-label="Previous page" disabled={page===0} onClick={()=>onChange(page-1)}><ChevronLeft size={16}/></button><span>Page {page+1} of {last+1}</span><button className="desk-icon-button" aria-label="Next page" disabled={page>=last} onClick={()=>onChange(page+1)}><ChevronRight size={16}/></button></div></div>}
function Applications({review,busy,onAction}:{review:ApplicationReviewView;busy:string;onAction:(id:string,action:'approve'|'reject'|'resend')=>void}){
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[sort,setSort]=useState('newest'),[page,setPage]=useState(0);
 const filtered=review.applications.filter(a=>(filter==='all'||a.status===filter)&&matchesSearch(query,a.displayName,a.email,a.organisation,a.country)).sort((a,b)=>sort==='oldest'?a.createdAt-b.createdAt:b.createdAt-a.createdAt);
 const safePage=Math.min(page,Math.max(0,Math.ceil(filtered.length/10)-1));
 return <section className="desk-panel"><PanelHead title="Beta application inbox" subtitle={`${review.applications.length} applications · Review each organiser before granting access`} icon={Mail} action={<button className="desk-button" disabled={!filtered.length} onClick={()=>downloadCsv('applications',['Name','Email','Organisation','Country','Status','Invitation','Applied at'],filtered.map(a=>[a.displayName,a.email,a.organisation,a.country,a.status,invitationState(a,review.invitations[a.id]),new Date(a.createdAt).toISOString()]))}><ArrowDownToLine size={14}/>Export CSV</button>}/><div className="desk-toolbar"><SearchBox value={query} onChange={v=>{setQuery(v);setPage(0)}} placeholder="Search name, email, organisation…"/><select aria-label="Application sort order" value={sort} onChange={e=>{setSort(e.target.value);setPage(0)}}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div><div className="desk-filter-tabs" aria-label="Application status">{['all','pending','approved','rejected'].map(f=><button key={f} aria-pressed={filter===f} onClick={()=>{setFilter(f);setPage(0)}}>{f==='all'?'All applications':f}<span>{review.applications.filter(a=>f==='all'||a.status===f).length}</span></button>)}</div>
 {filtered.length?<div className="desk-applications">{filtered.slice(safePage*10,safePage*10+10).map(a=>{const invite=review.invitations[a.id],state=invitationState(a,invite);return <article className="desk-application" key={a.id}><div className="desk-app-main"><span className="desk-avatar">{a.displayName.slice(0,2).toUpperCase()}</span><div className="desk-app-who"><h3>{a.displayName}</h3><p>{a.email}</p><small>{[a.organisation,a.country].filter(Boolean).join(' · ')||'Independent organiser'}</small></div><Badge tone={a.status==='approved'?'green':a.status==='pending'?'amber':'muted'}>{a.status}</Badge></div><div className="desk-app-details"><span><Clock3 size={12}/>Applied {date(a.createdAt)}</span><span><Mail size={12}/>{state}</span></div><details><summary>Application details</summary><div><b>How they plan to use SCOUT</b><p>{a.useCase||'No use case provided.'}</p><b>Events & experience</b><p>{a.events||'No event details provided.'}</p>{a.decidedAt&&<p>Reviewed {date(a.decidedAt)}</p>}{invite?.expiresAt&&!invite.activated&&<p>Invitation expires {date(invite.expiresAt)}</p>}{invite?.errorCode&&<p>Delivery needs attention. Retry is queued; {invite.attempts||0} delivery attempt(s).</p>}</div></details><div className="desk-app-actions">{a.status==='pending'?<><button className="desk-button danger" disabled={!!busy} onClick={()=>onAction(a.id,'reject')}>Reject</button><button className="desk-button primary" disabled={!!busy} onClick={()=>onAction(a.id,'approve')}>{busy===a.id?<Loader2 size={14} className="spin"/>:<Check size={14}/>}Approve & invite</button></>:a.status==='approved'&&!invite?.activated?<button className="desk-button" disabled={!!busy} onClick={()=>onAction(a.id,'resend')}><Mail size={14}/>Resend invitation</button>:<span className="desk-muted">{invite?.activated?'Account activated':'Application reviewed'}</span>}</div></article>})}</div>:<Empty title={review.applications.length?'No matching applications':'Your inbox is clear'} detail={review.applications.length?'Try another search or status filter.':'Applications will appear here when organisers request beta access.'}/>}
 <Pager page={safePage} total={filtered.length} onChange={setPage}/></section>;
}
function Members({users}:{users:Summary['users']}){
 const [query,setQuery]=useState(''),[sort,setSort]=useState('active'),[page,setPage]=useState(0);
 const rows=users.filter(u=>matchesSearch(query,u.email,u.status)).sort((a,b)=>sort==='kills'?b.totals.kills-a.totals.kills:sort==='tournaments'?b.tournaments-a.tournaments:sort==='email'?a.email.localeCompare(b.email):(b.lastActiveAt||0)-(a.lastActiveAt||0));
 const safePage=Math.min(page,Math.max(0,Math.ceil(rows.length/10)-1));
 return <section className="desk-panel"><PanelHead title="Your broadcast community" subtitle={`${users.length} whitelisted organisers · Account-owned tournaments`} icon={Users} action={<button className="desk-button" disabled={!rows.length} onClick={()=>downloadCsv('users',['Email','Status','Tournaments','Kills','Headshots','Matches','Last active'],rows.map(u=>[u.email,u.status,u.tournaments,u.totals.kills,u.totals.headshots,u.totals.matches,u.lastActiveAt?new Date(u.lastActiveAt).toISOString():'']))}><ArrowDownToLine size={14}/>Export CSV</button>}/><div className="desk-toolbar"><SearchBox value={query} onChange={v=>{setQuery(v);setPage(0)}} placeholder="Search users by email or status…"/><select aria-label="User sort order" value={sort} onChange={e=>{setSort(e.target.value);setPage(0)}}><option value="active">Recently active</option><option value="email">Email A–Z</option><option value="tournaments">Most tournaments</option><option value="kills">Most kills</option></select></div>{rows.length?<div className="desk-table-scroll"><table className="desk-table"><thead><tr><th>Organiser</th><th>Tournaments</th><th>Kills / HS</th><th>Matches</th><th>Last active</th></tr></thead><tbody>{rows.slice(safePage*10,safePage*10+10).map(u=><tr key={u.accountId}><td><b>{u.email}</b><Badge tone="green">{u.status}</Badge></td><td>{u.tournaments}</td><td>{number(u.totals.kills)} <small>/ {number(u.totals.headshots)}</small></td><td>{number(u.totals.matches)}</td><td>{date(u.lastActiveAt)}</td></tr>)}</tbody></table></div>:<Empty title="No organisers to show" detail={users.length?'Try a different email or status.':'Whitelisted accounts and their tournaments will appear here.'}/>}<Pager page={safePage} total={rows.length} onChange={setPage}/></section>;
}
function LogRows({logs}:{logs:Summary['recentLogs']}){return logs.length?<div className="desk-log-list">{logs.map((log,i)=><div className="desk-log" key={log.id||`${log.at}-${i}`}><span className={'desk-log-icon '+log.kind}><Activity size={16}/></span><div><b>{log.kind}<span>×{number(log.count)}</span></b><p>{[log.map,log.detail].filter(Boolean).join(' · ')||'Tournament event'}</p></div><time dateTime={new Date(log.at).toISOString()}>{date(log.at)}</time></div>)}</div>:<Empty title="The next broadcast starts here" detail="Match events appear automatically when linked hosts report tournament activity."/>}
function ActivityLog({logs}:{logs:Summary['recentLogs']}){
 const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[page,setPage]=useState(0);
 const rows=logs.filter(l=>(kind==='all'||l.kind===kind)&&matchesSearch(query,l.map,l.detail,l.kind));const safePage=Math.min(page,Math.max(0,Math.ceil(rows.length/10)-1));
 return <section className="desk-panel"><PanelHead title="Match event feed" subtitle="Latest 100 platform events · Newest first · Not a complete archive" icon={Activity} action={<button className="desk-button" disabled={!rows.length} onClick={()=>downloadCsv('activity',['Time','Event','Count','Map','Detail'],rows.map(l=>[new Date(l.at).toISOString(),l.kind,l.count,l.map,l.detail]))}><ArrowDownToLine size={14}/>Export CSV</button>}/><div className="desk-toolbar"><SearchBox value={query} onChange={v=>{setQuery(v);setPage(0)}} placeholder="Search map or event details…"/><select aria-label="Event type" value={kind} onChange={e=>{setKind(e.target.value);setPage(0)}}>{['all','kill','headshot','grenade','round','map','match'].map(k=><option key={k} value={k}>{k==='all'?'All event types':k}</option>)}</select></div>{rows.length?<LogRows logs={rows.slice(safePage*10,safePage*10+10)}/>:<Empty title="No events to show" detail="Try another filter, or wait for a linked host to report match activity."/>}<Pager page={safePage} total={rows.length} onChange={setPage}/></section>;
}
function SettingToggle({label,description,value,onChange}:{label:string;description:string;value:boolean;onChange:(value:boolean)=>void}){return <div className="desk-setting-toggle"><div><b>{label}</b><p>{description}</p></div><button type="button" role="switch" aria-label={label} aria-checked={value} className={'desk-switch '+(value?'on':'')} onClick={()=>onChange(!value)}><i/></button></div>}
// The whitelisted user's own desk, shown in the app dashboard (/app). The website does not
// render it any more; the panel and the download page are the only other places it is reachable.
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
 useEffect(()=>{
  let mounted=true;
  const load=async()=>{try{const {res,body}=await api('/api/platform/stats');if(mounted&&res.ok)setStats(body.enabled?body:null)}catch{}};
  void load();const timer=setInterval(()=>void load(),15000);return()=>{mounted=false;clearInterval(timer)};
 },[]);
 if(!stats) return null;
 return <section className="site-card"><h3>Live on SCOUT so far</h3><div className="feed-counters">{[['Kills',stats.totals.kills],['Headshots',stats.totals.headshots],['Grenades exploded',stats.totals.grenades],['Rounds',stats.totals.rounds],['Matches',stats.totals.matches]].map(([l,v]:any)=><div className="feed-counter" key={l}><b>{v}</b><small>{String(l).toUpperCase()}</small></div>)}</div></section>;
}
