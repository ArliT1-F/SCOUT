// Team portal UI (follow-up §3). Two halves in one file:
//   · PortalPage — what a captain sees behind a signed link. No account, no password: the link is the
//     credential, and the page says so. It only ever writes to the organiser's approval queue.
//   · PortalPanel — what the organiser sees in the panel: links to hand out, and the queue of rosters
//     waiting for a decision. Approving decides; applying writes the roster into the tournament.
import React,{useEffect,useMemo,useState} from 'react';
import {Check,ClipboardCopy,ExternalLink,Link2,Loader2,Plus,RotateCcw,Send,ShieldCheck,Trash2,Users,X} from 'lucide-react';
import {apiFetch} from './session';
import type {PortalLinkView,PortalQueueItem,PortalSubmission} from '../server/portal';

type PortalContext={
 status:'active'|'expired'|'revoked';
 label:string;expiresAt:number;
 event:{name:string;slug:string|null};
 team:{name:string;tag:string;players:Array<{nickname:string;role:string}>}|null;
 lastSubmission:{at:number;status:string}|null;
};
const ROLES=['','Rifler','AWPer','Entry','Support','IGL','Coach','Analyst'];
const emptyRow=(index:number)=>({nickname:'',role:index===0?'IGL':'',steamid:''});

export function PortalPage({token}:{token:string}){
 const [context,setContext]=useState<PortalContext|null>(null);
 const [state,setState]=useState<'loading'|'ready'|'missing'|'sent'|'closed'>('loading');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [form,setForm]=useState({teamName:'',tag:'',logo:'',note:'',x:'',twitch:'',website:'',discord:''});
 const [rows,setRows]=useState<Array<{nickname:string;role:string;steamid:string}>>([0,1,2,3,4].map(emptyRow));
 useEffect(()=>{
  let live=true;
  void (async()=>{
   try{
    const response=await fetch(`/api/public/portal/${encodeURIComponent(token)}`);
    const body=await response.json().catch(()=>({}));
    if(!live) return;
    if(!response.ok){setState('missing');setError(body?.error||'This link is not valid.');return}
    setContext(body);
    if(body.status!=='active'){setState('closed');return}
    const players=body.team?.players??[];
    setRows(players.length?players.map((player:any)=>({nickname:player.nickname,role:player.role||'',steamid:''})):[0,1,2,3,4].map(emptyRow));
    setForm(current=>({...current,teamName:body.team?.name??'',tag:body.team?.tag??''}));
    setState('ready');
   }catch{ if(live){setState('missing');setError('The page could not reach the organiser’s host. Check the link or try again.')} }
  })();
  return()=>{live=false};
 },[token]);
 const filled=useMemo(()=>rows.filter(row=>row.nickname.trim()),(rows));
 const send=async()=>{
  setBusy(true);setError('');
  try{
   const payload:PortalSubmission={teamName:form.teamName.trim(),tag:form.tag.trim(),logo:form.logo.trim(),note:form.note.trim(),socials:{x:form.x.trim(),twitch:form.twitch.trim(),website:form.website.trim(),discord:form.discord.trim()},players:filled.map(row=>({nickname:row.nickname.trim(),role:row.role,steamid:row.steamid.trim()}))};
   const response=await fetch(`/api/public/portal/${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const body=await response.json().catch(()=>({}));
   if(!response.ok){const retry=body?.retryAfterMs?` Try again in ${Math.ceil(body.retryAfterMs/1000)} s.`:'';throw Error(`${body?.error||'That submission was not accepted.'}${retry}`)}
   setState('sent');
  }catch(failure:any){setError(failure?.message||'That submission could not be sent.')}
  finally{setBusy(false)}
 };
 return <div className="portal-page">
  <header className="portal-head"><span className="portal-brand">SCOUT <i>TEAM PORTAL</i></span>{context?.event.name&&<span className="portal-event">{context.event.name}</span>}</header>
  <main className="portal-main">
   {state==='loading'&&<section className="panel portal-card"><Loader2 className="spin" size={18}/><p>Opening your link…</p></section>}
   {(state==='missing'||state==='closed')&&<section className="panel portal-card portal-closed">
    <ShieldCheck size={26}/>
    <h1>{state==='missing'?'This link is not valid':'This link is closed'}</h1>
    <p>{error||`This link ${context?.status==='expired'?'expired':'was cancelled'}. Ask the organiser for a new one — they can issue one in seconds from the SCOUT panel.`}</p>
   </section>}
   {state==='sent'&&<section className="panel portal-card portal-closed"><Check size={26}/><h1>Roster submitted</h1><p>The organiser has your roster, logo link and socials in the approval queue. Nothing goes on air until they approve it. If you need to correct something, open this link again and submit a new version — it replaces the old one.</p></section>}
   {state==='ready'&&context&&<>
    <section className="panel portal-card portal-intro">
     <div><span className="section-label">ROSTER SUBMISSION</span><h1>{form.teamName||'Your team'}</h1><p>Fill in your lineup the way you want it on the broadcast. The organiser reviews everything before it is used, and you can resubmit until the link expires on {new Date(context.expiresAt).toLocaleDateString()}.</p></div>
     <div className="portal-steps"><span><b>1</b>Your roster</span><span><b>2</b>Organiser review</span><span><b>3</b>On air</span></div>
    </section>
    <section className="panel portal-card">
     <h2>Team</h2>
     <div className="portal-grid">
      <label className="field"><span>TEAM NAME</span><input type="text" maxLength={40} value={form.teamName} onChange={event=>setForm({...form,teamName:event.target.value})} placeholder="Team name"/></label>
      <label className="field"><span>TAG</span><input type="text" maxLength={8} value={form.tag} onChange={event=>setForm({...form,tag:event.target.value})} placeholder="ABC"/></label>
      <label className="field portal-wide"><span>LOGO LINK</span><input type="url" maxLength={300} value={form.logo} onChange={event=>setForm({...form,logo:event.target.value})} placeholder="https://…/logo.png"/><small className="field-hint">A direct link to a transparent PNG. The organiser copies it into the panel — nothing is uploaded from this page.</small></label>
     </div>
    </section>
    <section className="panel portal-card">
     <div className="panel-heading"><h2>Lineup <span className="subtle-pill">{filled.length}</span></h2><button type="button" className="mini-button" disabled={rows.length>=10} onClick={()=>setRows([...rows,emptyRow(rows.length)])}><Plus size={12}/>Add player</button></div>
     <div className="portal-roster">
      <div className="portal-roster-head"><span>#</span><span>NAME</span><span>ROLE</span><span>STEAMID (OPTIONAL)</span><span/></div>
      {rows.map((row,index)=><div className="portal-roster-row" key={index}>
       <span className="portal-index">{String(index+1).padStart(2,'0')}</span>
       <input type="text" maxLength={32} value={row.nickname} placeholder="Player name" onChange={event=>setRows(rows.map((item,position)=>position===index?{...item,nickname:event.target.value}:item))}/>
       <select value={row.role} onChange={event=>setRows(rows.map((item,position)=>position===index?{...item,role:event.target.value}:item))}>{ROLES.map(role=><option key={role||'none'} value={role}>{role||'—'}</option>)}</select>
       <input type="text" maxLength={64} value={row.steamid} placeholder="STEAM_1:1:…" onChange={event=>setRows(rows.map((item,position)=>position===index?{...item,steamid:event.target.value}:item))}/>
       <button type="button" className="icon-button" aria-label={`Remove player ${index+1}`} disabled={rows.length<=1} onClick={()=>setRows(rows.filter((_,position)=>position!==index))}><X size={13}/></button>
      </div>)}
     </div>
    </section>
    <section className="panel portal-card">
     <h2>Socials</h2>
     <div className="portal-grid">
      {([['x','X / TWITTER'],['twitch','TWITCH'],['website','WEBSITE'],['discord','DISCORD INVITE']] as const).map(([key,label])=><label className="field" key={key}><span>{label}</span><input type="text" maxLength={200} value={form[key]} onChange={event=>setForm({...form,[key]:event.target.value})} placeholder={key==='discord'?'https://discord.gg/…':key==='x'?'@yourteam':'https://…'}/></label>)}
     </div>
     <label className="field portal-wide"><span>NOTE FOR THE ORGANISER</span><textarea maxLength={400} rows={3} value={form.note} onChange={event=>setForm({...form,note:event.target.value})} placeholder="Anything the broadcast team should know — name spellings, pronunciation, preferred colours."/></label>
    </section>
    {error&&<div className="portal-error" role="alert">{error}</div>}
    <div className="portal-submit"><span className="field-hint">The link works until {new Date(context.expiresAt).toLocaleString()} and is limited to five submissions an hour.</span><button type="button" className="button primary" disabled={busy||filled.length<1||form.teamName.trim().length<2} onClick={()=>void send()}>{busy?<Loader2 className="spin" size={14}/>:<Send size={14}/>}{busy?'Sending…':'Send to the organiser'}</button></div>
   </>}
  </main>
  <footer className="portal-foot">Sent through SCOUT · the organiser reviews every submission before it is broadcast.</footer>
 </div>;
}

export function PortalPanel({onNotice,canControl}:{onNotice:(message:string)=>void;canControl:boolean}){
 const [links,setLinks]=useState<PortalLinkView[]>([]);
 const [queue,setQueue]=useState<PortalQueueItem[]>([]);
 const [ttlDays,setTtlDays]=useState(14);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState('');
 const [teamId,setTeamId]=useState('');
 const [eventId,setEventId]=useState('');
 const [tournaments,setTournaments]=useState<Array<{id:string;name:string;teams:Array<{id:string;name:string}>}>>([]);
 async function refresh(){
  try{
   const [linksResponse,platformResponse]=await Promise.all([fetch('/api/portal/links'),apiFetch('/api/platform/status')]);
   if(linksResponse.ok){const body=await linksResponse.json();setLinks(body.links||[]);setQueue(body.queue||[]);if(body.ttlDays)setTtlDays(body.ttlDays)}
   if(platformResponse.ok){const body=await platformResponse.json();const list=body.tournaments||[];setTournaments(list.map((item:any)=>({id:item.id,name:item.name,teams:(item.teams||[]).map((team:any)=>({id:team.id,name:team.name}))})));if(!eventId&&list[0])setEventId(list[0].id)}
  }catch{}
 }
 useEffect(()=>{void refresh()},[]);
 const tournament=tournaments.find(item=>item.id===eventId)??null;
 const teamName=(id:string)=>tournament?.teams.find(team=>team.id===id)?.name??id;
 const create=async()=>{
  setBusy('create');setError('');
  try{
   const response=await apiFetch('/api/portal/links',{method:'POST',body:JSON.stringify({teamId,eventId,label:teamName(teamId)})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'The link could not be created.');
   await navigator.clipboard.writeText(`${location.origin}${body.url}`).catch(()=>{});
   onNotice('Link created and copied. Send it to the captain — it works without an account.');
   await refresh();
  }catch(failure:any){setError(failure?.message||'The link could not be created.')}
  finally{setBusy('')}
 };
 const act=async(path:string,method:string,label:string)=>{
  setBusy(path);setError('');
  try{
   const response=await apiFetch(path,{method});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||`${label} failed.`);
   onNotice(`${label} done.`);
   await refresh();
  }catch(failure:any){setError(failure?.message||`${label} failed.`)}
  finally{setBusy('')}
 };
 return <div className="portal-panel">
  <section className="panel">
   <div className="editor-head"><div className="section-label">SIGNED LINKS · NO ACCOUNTS</div><h2>Team portal</h2><p>Hand a captain a link instead of asking for their password. They submit a roster, a logo link and socials; you approve what reaches the broadcast. Links expire after {ttlDays} days and allow five submissions an hour.</p></div>
   <div className="portal-create">
    <label className="field"><span>TOURNAMENT</span><select value={eventId} onChange={event=>{setEventId(event.target.value);setTeamId('')}}>{tournaments.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label className="field"><span>TEAM</span><select value={teamId} onChange={event=>setTeamId(event.target.value)}><option value="">Choose a team…</option>{(tournament?.teams??[]).map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
    <button type="button" className="button primary" disabled={!canControl||!teamId||!eventId||busy==='create'} onClick={()=>void create()}><Link2 size={14}/>{busy==='create'?'Creating…':'Create link'}</button>
   </div>
   {error&&<div className="portal-error" role="alert">{error}</div>}
   {links.length>0?<table className="portal-table"><thead><tr><th>TEAM</th><th>LINK</th><th>STATUS</th><th>SUBMISSIONS</th><th/></tr></thead><tbody>{links.map(link=><tr key={link.id}>
    <td><b>{link.label}</b><small>{teamName(link.teamId)}</small></td>
    <td><code>{location.origin}{link.path}</code></td>
    <td>{link.revokedAt?'Revoked':link.expiresAt<Date.now()?'Expired':`Active · ${new Date(link.expiresAt).toLocaleDateString()}`}</td>
    <td>{link.total}{link.pending?<span className="subtle-pill">{link.pending} pending</span>:null}</td>
    <td className="portal-row-actions">
     <button type="button" className="mini-button" title="Copy link" onClick={()=>{void navigator.clipboard.writeText(`${location.origin}${link.path}`);onNotice('Link copied.')}}><ClipboardCopy size={12}/></button>
     <button type="button" className="mini-button" title="New link, same team (old one stops working)" disabled={!canControl} onClick={()=>void act(`/api/portal/links/${link.id}/rotate`,'POST','Rotate')}><RotateCcw size={12}/></button>
     <button type="button" className="mini-button danger" title="Revoke link (the captain sees a closed page)" disabled={!canControl} onClick={()=>void act(`/api/portal/links/${link.id}`,'DELETE','Revoked')}><Trash2 size={12}/></button>
    </td></tr>)}</tbody></table>:<p className="portal-empty">No links yet. Pick a team above — the captain does not need an account, a password or an invite email.</p>}
  </section>
  <section className="panel">
   <div className="panel-heading"><h2>Approval queue <span className="subtle-pill">{queue.length}</span></h2></div>
   {queue.length===0?<p className="portal-empty">Nothing waiting. Submissions appear here the moment a captain sends them.</p>:<div className="portal-queue">{queue.map(item=><article className="portal-queue-item" key={item.submissionId}>
    <header><div><b>{item.payload.teamName}</b> <span className="subtle-pill">{item.payload.tag||'—'}</span><small>{new Date(item.at).toLocaleString()}</small></div><span className="portal-queue-players"><Users size={12}/>{item.payload.players.length}</span></header>
    <ol className="portal-queue-roster">{item.payload.players.map((player,index)=><li key={index}><b>{player.nickname}</b><span>{player.role||'—'}</span>{player.steamid&&<code>{player.steamid}</code>}</li>)}</ol>
    {player_links(item.payload).length>0&&<div className="portal-queue-links">{player_links(item.payload).map(([label,url])=><a key={label} href={url} target="_blank" rel="noreferrer noopener">{label}<ExternalLink size={11}/></a>)}</div>}
    {item.payload.note&&<p className="portal-queue-note">{item.payload.note}</p>}
    <footer>
     <button type="button" className="button" disabled={!canControl} onClick={()=>void act(`/api/portal/links/${item.linkId}/submissions/${item.submissionId}/reject`,'POST','Rejected')}><X size={13}/>Reject</button>
     <button type="button" className="button" disabled={!canControl} onClick={()=>void act(`/api/portal/links/${item.linkId}/submissions/${item.submissionId}/approve`,'POST','Approved')}><Check size={13}/>Approve</button>
     <button type="button" className="button primary" disabled={!canControl} onClick={()=>void act(`/api/portal/links/${item.linkId}/submissions/${item.submissionId}/apply`,'POST','Applied')}><Send size={13}/>Approve &amp; apply to team</button>
    </footer>
   </article>)}</div>}
  </section>
 </div>;
}
function player_links(payload:PortalSubmission):Array<[string,string]>{
 const entries:Array<[string,string]>=[];
 if(payload.logo) entries.push(['Logo',payload.logo]);
 for(const [label,value] of [['X','x'],['Twitch','twitch'],['Website','website'],['Discord','discord']] as const){
  const url=payload.socials?.[value];
  if(url&&/^https?:\/\//i.test(url)) entries.push([label,url]);
 }
 return entries;
}
