import React,{useCallback,useEffect,useState} from 'react';
import {ArrowUpRight,Copy,Globe2,Lock,Radio,Settings2} from 'lucide-react';

// The organiser's side of the Tournament Hub (docs/LAUNCH-FEATURES.md §1). Publish is a per-tournament
// decision: unlisted by default (a link works, a crawler does not follow it), public flips it into the
// sitemap, private takes it offline without deleting anything. Rosters are off unless asked for.
interface TournamentRow {id:string;name:string;publication?:Publication|null}
interface Publication {slug:string;visibility:'public'|'unlisted'|'private';showRoster:boolean;showSchedule:boolean;stream:string;updatedAt:number}

export function PublishCard({onNotice}:{onNotice:(message:string)=>void}){
 const [tournaments,setTournaments]=useState<TournamentRow[]|null>(null);
 const [selected,setSelected]=useState('');
 const [draft,setDraft]=useState<Publication|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [visible,setVisible]=useState(true);
 const load=useCallback(async()=>{
  try{
   const response=await fetch('/api/platform/tournaments',{headers:{Accept:'application/json'}});
   if(!response.ok){setVisible(false);return}
   const body=await response.json();
   const list:TournamentRow[]=body.tournaments||[];
   setTournaments(list);
   setSelected(current=>current&&list.some(tournament=>tournament.id===current)?current:body.activeTournamentId||list[0]?.id||'');
  }catch{setVisible(false)}
 },[]);
 useEffect(()=>{void load()},[load]);
 const current=tournaments?.find(tournament=>tournament.id===selected)??null;
 useEffect(()=>{setDraft(current?.publication?{...current.publication}:null)},[current?.id,current?.publication?.updatedAt]);
 if(!visible) return null;
 const save=async(published:boolean)=>{
  if(!current) return;
  setBusy(true);setError('');
  try{
   const payload=published?{published:true,slug:draft?.slug||current.name,visibility:draft?.visibility??'unlisted',showRoster:draft?.showRoster??false,showSchedule:draft?.showSchedule??true,stream:draft?.stream??''}:{published:false};
   const response=await fetch(`/api/platform/tournaments/${encodeURIComponent(current.id)}/publication`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'The publication settings could not be saved.');
   setDraft(body.publication?{...body.publication}:null);
   onNotice(published?`Published at /t/${body.publication.slug} — ${body.publication.visibility}.`:'Tournament page unpublished.');
   void load();
  }catch(failure:any){setError(failure?.message||'The publication settings could not be saved.')}
  finally{setBusy(false)}
 };
 const copy=async()=>{
  if(!draft) return;
  const url=`${location.origin}/t/${draft.slug}`;
  try{await navigator.clipboard.writeText(url);onNotice('Public link copied.')}catch{onNotice(`Copy manually: ${url}`)}
 };
 return <section className="panel hub-card">
  <div className="panel-heading">
   <h2><Globe2 size={16}/> Tournament page</h2>
   {tournaments&&tournaments.length>1&&<select aria-label="Choose a tournament" value={selected} onChange={event=>setSelected(event.target.value)}>{tournaments.map(tournament=><option key={tournament.id} value={tournament.id}>{tournament.name}</option>)}</select>}
  </div>
  {error&&<p className="unlock-error" role="alert">{error}</p>}
  {!tournaments?.length?<p className="field-hint">Create a tournament to publish a page for it.</p>:current&&<>
   <p className="field-hint">A public page with the bracket, map results and fixtures — the link you can put in Discord, on a sponsor page, or in a stream overlay. Unlisted links work but stay out of search and the sitemap.</p>
   <div className="hub-row">
    <label className="field"><span>ADDRESS</span><div className="hub-slug"><span>{location.origin.replace(/^https?:\/\//,'')}/t/</span><input type="text" maxLength={48} value={draft?.slug??current.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')} disabled={busy} onChange={event=>setDraft({...(draft??defaults(current)),slug:event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g,'-')})}/></div></label>
    <label className="field"><span>VISIBILITY</span><select disabled={busy} value={draft?.visibility??'unlisted'} onChange={event=>setDraft({...(draft??defaults(current)),visibility:event.target.value as Publication['visibility']})}><option value="unlisted">Unlisted — link only</option><option value="public">Public — listed and indexed</option><option value="private">Private — offline</option></select></label>
   </div>
   <div className="hub-row">
    <label className="field"><span>STREAM LINK (OPTIONAL)</span><input type="url" maxLength={300} placeholder="https://twitch.tv/yourchannel" value={draft?.stream??''} disabled={busy} onChange={event=>setDraft({...(draft??defaults(current)),stream:event.target.value})}/></label>
    <label className="toggle-row"><div><b>Show player names</b><small>Names and roles only — never Steam IDs, real names or photos</small></div><button type="button" role="switch" aria-checked={draft?.showRoster??false} aria-label="Show player names" className={'toggle '+((draft?.showRoster??false)?'enabled':'')} onClick={()=>setDraft({...(draft??defaults(current)),showRoster:!(draft?.showRoster??false)})}><i/></button></label>
   </div>
   <div className="hub-actions">
    <button type="button" className="button primary" disabled={busy} onClick={()=>void save(true)}><Radio size={14}/>{draft?'Save page':'Publish page'}</button>
    {draft&&<>
     <button type="button" className="mini-button" onClick={()=>void copy()}><Copy size={13}/>Copy link</button>
     <a className="mini-button" href={`/t/${draft.slug}`} target="_blank" rel="noreferrer"><ArrowUpRight size={13}/>Open</a>
     <a className="mini-button" href={`/embed/${draft.slug}`} target="_blank" rel="noreferrer"><Settings2 size={13}/>Embed</a>
     <button type="button" className="mini-button danger" disabled={busy} onClick={()=>void save(false)}><Lock size={13}/>Unpublish</button>
    </>}
   </div>
  </>}
 </section>;
}
function defaults(row:TournamentRow):Publication{
 return {slug:row.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'tournament',visibility:'unlisted',showRoster:false,showSchedule:true,stream:'',updatedAt:Date.now()};
}
