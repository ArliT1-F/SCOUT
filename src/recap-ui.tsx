import React,{useEffect,useMemo,useState} from 'react';
import {ArrowDownToLine,ClipboardCopy,Image as ImageIcon,Send,Trophy,Users} from 'lucide-react';
import type {ArchiveSummary} from '../server/recordings';
import type {Recap} from '../server/recap';
import {formatDuration} from '../server/recap';
import {CARD_SIZES,recapCaption,type CardSize} from '../server/recap-card';

// Recap Kit (docs/LAUNCH-FEATURES.md §4). The numbers come from /api/archive/:id/recap, the card is
// the host's own SVG (so the panel and the delivered image are the same document), and the PNG is
// produced in this browser with a canvas — no image service, no upload of match data.
async function fetchSvg(archiveId:string,size:CardSize):Promise<string>{
 const response=await fetch(`/api/archive/${encodeURIComponent(archiveId)}/recap.svg?size=${size}`,{cache:'no-store'});
 if(!response.ok) throw new Error('The recap card could not be rendered.');
 return response.text();
}
function downloadBlob(blob:Blob,name:string){
 const url=URL.createObjectURL(blob);
 const anchor=document.createElement('a');
 anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();
 setTimeout(()=>URL.revokeObjectURL(url),2000);
}
export async function svgToPng(svg:string,size:CardSize,scale=2):Promise<Blob>{
 const {width,height}=CARD_SIZES[size];
 const image=new Image();
 const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
 try{
  await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('The card could not be drawn as an image.'));image.src=url});
  const canvas=document.createElement('canvas');
  canvas.width=width*scale;canvas.height=height*scale;
  const context=canvas.getContext('2d');
  if(!context) throw new Error('This browser cannot render the card as a PNG.');
  context.scale(scale,scale);
  context.drawImage(image,0,0,width,height);
  return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('The PNG could not be created.')),'image/png'));
 }finally{URL.revokeObjectURL(url)}
}

export function RecapPanel({onNotice,canControl,onReplay}:{onNotice:(message:string)=>void;canControl:boolean;onReplay?:(at:number)=>void}){
 const [archives,setArchives]=useState<ArchiveSummary[]>([]);
 const [selected,setSelected]=useState<string>('');
 const [recap,setRecap]=useState<Recap|null>(null);
 const [size,setSize]=useState<CardSize>('feed');
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [webhook,setWebhook]=useState('');
 const [markers,setMarkers]=useState<Array<{id:string;at:number;offsetMs:number;label:string;kind:string;map:string;round:number|null}>>([]);
 const [markerLabel,setMarkerLabel]=useState('');
 const loadMarkers=async(id:string)=>{
  if(!id){setMarkers([]);return}
  try{const response=await fetch(`/api/archive/${encodeURIComponent(id)}/markers`);if(!response.ok)return;const body=await response.json();setMarkers(body.markers||[])}catch{}
 };
 const load=async()=>{
  try{
   const response=await fetch('/api/archive');
   if(!response.ok) return;
   const body=await response.json();
   const list:ArchiveSummary[]=body.archives||[];
   setArchives(list);
   setSelected(current=>current||list.find(archive=>archive.endedAt)?.id||list[0]?.id||'');
  }catch{}
 };
 useEffect(()=>{void load()},[]);
 useEffect(()=>{
  if(!selected){setRecap(null);return}
  let live=true;
  (async()=>{
   try{
    const response=await fetch(`/api/archive/${encodeURIComponent(selected)}/recap`);
    const body=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(body?.error||'That recap could not be loaded.');
    if(live) setRecap(body);
   }catch(failure:any){if(live){setError(failure?.message||'That recap could not be loaded.');setRecap(null)}}
  })();
  return()=>{live=false};
 },[selected]);
 useEffect(()=>{void loadMarkers(selected)},[selected]);
 const finished=useMemo(()=>archives.filter(archive=>archive.endedAt),[archives]);
 const current=archives.find(archive=>archive.id===selected);
 const addMarker=async(kind:'manual'|'kill'|'round'='manual')=>{
  if(!recap) return;
  setBusy('marker');setError('');
  try{
   const response=await fetch(`/api/archive/${encodeURIComponent(recap.archiveId)}/markers`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:Date.now(),label:markerLabel.trim(),kind})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'The marker could not be added.');
   setMarkers(body.markers||[]);setMarkerLabel('');onNotice('Marker added.');
  }catch(failure:any){setError(failure?.message||'The marker could not be added.')}
  finally{setBusy('')}
 };
 const removeMarker=async(markerId:string)=>{
  if(!recap) return;
  try{
   const response=await fetch(`/api/archive/${encodeURIComponent(recap.archiveId)}/markers/${encodeURIComponent(markerId)}`,{method:'DELETE'});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'The marker could not be removed.');
   setMarkers(body.markers||[]);
  }catch(failure:any){setError(failure?.message||'The marker could not be removed.')}
 };
 const timecode=(offsetMs:number)=>{
  const total=Math.max(0,Math.round(offsetMs));const pad=(value:number,width=2)=>String(value).padStart(width,'0');
  return `${pad(Math.floor(total/3_600_000),2)}:${pad(Math.floor((total%3_600_000)/60_000))}:${pad(Math.floor((total%60_000)/1000))}.${pad(total%1000,3)}`;
 };
 const copyCaption=async()=>{
  if(!recap) return;
  try{await navigator.clipboard.writeText(recapCaption(recap,location.origin));onNotice('Caption copied — paste it with the card.')}
  catch{onNotice('Could not copy automatically. Select the caption text below instead.')}
 };
 const download=(kind:'svg'|'png'|'csv')=>{
  if(!recap) return;
  setBusy(kind);
  (async()=>{
   try{
    if(kind==='csv'){location.href=`/api/archive/${encodeURIComponent(recap.archiveId)}/recap.csv`;return}
    const svg=await fetchSvg(recap.archiveId,size);
    if(kind==='svg'){downloadBlob(new Blob([svg],{type:'image/svg+xml'}),`scout-${recap.archiveId}-${size}.svg`);return}
    downloadBlob(await svgToPng(svg,size),`scout-${recap.archiveId}-${size}.png`);
   }catch(failure:any){setError(failure?.message||'The card could not be downloaded.')}
   finally{setBusy('')}
  })();
 };
 const deliver=async()=>{
  if(!recap) return;
  setBusy('deliver');setError('');
  try{
   const response=await fetch(`/api/archive/${encodeURIComponent(recap.archiveId)}/deliver`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:webhook})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'The recap could not be delivered.');
   onNotice(`Recap delivered (${body.delivery?.target||'webhook'}).`);
   void load();
  }catch(failure:any){setError(failure?.message||'The recap could not be delivered.')}
  finally{setBusy('')}
 };
 if(!archives.length) return <section className="panel detail-panel recap-panel"><div className="panel-heading"><h2>Recap Kit</h2></div><p className="field-hint">Recaps appear here once a session archive has recorded a match. Start one from the archive above, play the match, then finish it.</p></section>;
 return <section className="panel detail-panel recap-panel">
  <div className="panel-heading">
   <div><h2>Recap Kit <span className="subtle-pill">POST-MATCH</span></h2><p className="info-note">Numbers come from the session archive. Assists, MVPs and damage exist only when the host recorded round snapshots; an older archive says so instead of showing zeros.</p></div>
   <select aria-label="Choose a match" value={selected} onChange={event=>setSelected(event.target.value)}>
    {archives.map(archive=><option key={archive.id} value={archive.id}>{archive.name} · {new Date(archive.startedAt).toLocaleDateString()} {archive.endedAt?'':' (live)'}</option>)}
   </select>
  </div>
  {error&&<p className="unlock-error" role="alert">{error}</p>}
  {recap?<>
   <div className="recap-head">
    <div className="recap-teams">
     {recap.teams.map((team,index)=><div key={team.name+(index)} className={recap.seriesWinner===index?'winner':''}><b>{team.name}</b><span>{team.mapsWon}</span>{recap.seriesWinner===index&&<Trophy size={14}/>}</div>)}
    </div>
    <div className="recap-meta"><span>{[recap.event,recap.stage].filter(Boolean).join(' · ')||'Exhibition'}</span><span>{recap.format.toUpperCase()} · {recap.totals.rounds} rounds · {formatDuration(recap.durationMs)}</span><span>{current?.delivery?`Last delivery ${new Date(current.delivery.at).toLocaleString()} — ${current.delivery.status}`:'No delivery yet'}</span></div>
   </div>
   <div className="recap-grid">
    <div className="recap-maps">
     <span className="section-label">MAPS</span>
     {recap.maps.length?recap.maps.map(map=><div className={'recap-map'+(map.winnerTeamIndex!==null&&map.winnerTeamIndex===recap.seriesWinner?' won':'')} key={map.map}><b>{map.map.replace(/^de_/,'')}</b><span>{map.ctScore} : {map.tScore}</span><small>{map.winnerTeamIndex!==null?`${recap.teams[map.winnerTeamIndex]?.name||'—'} won`:`${map.rounds} rounds`}</small></div>):<p className="field-hint">No map results were recorded.</p>}
    </div>
    <div className="recap-mvp">
     <span className="section-label">MVP</span>
     <b>{recap.mvp?.name||'No kills recorded'}</b>
     {recap.mvp&&<span>{recap.mvp.kills} K · {recap.mvp.deaths} D · {recap.mvp.headshots} HS{recap.mvp.adr!==null?` · ${recap.mvp.adr} ADR`:''}</span>}
     <small>{recap.captured.snapshots?'Round snapshots recorded.':'Assists, MVPs and damage were not captured for this archive.'}</small>
    </div>
   </div>
   <div className="recap-table-wrap">
    <table className="desk-table recap-table">
     <thead><tr><th>Player</th><th>Team</th><th>K</th><th>D</th><th>A</th><th>HS</th><th>HS%</th><th>ADR</th><th>K/D</th></tr></thead>
     <tbody>{recap.players.map(player=><tr key={player.steamid}><td><b>{player.name}</b></td><td>{recap.teams[player.teamIndex]?.name||'—'}</td><td>{player.kills}</td><td>{player.deaths}</td><td>{player.assists??'—'}</td><td>{player.headshots}</td><td>{player.hsPct??'—'}</td><td>{player.adr??'—'}</td><td>{player.kd??'—'}</td></tr>)}</tbody>
    </table>
   </div>
   <div className="recap-actions">
    <div className="recap-size" role="group" aria-label="Card format">{(['feed','story'] as CardSize[]).map(value=><button key={value} type="button" className={'mini-button'+(size===value?' active':'')} onClick={()=>setSize(value)}>{value==='feed'?'Feed 1200×630':'Story 1080×1350'}</button>)}</div>
    <button type="button" className="mini-button" disabled={!!busy} onClick={()=>download('svg')}><ImageIcon size={13}/>{busy==='svg'?'Preparing…':'Download card (SVG)'}</button>
    <button type="button" className="mini-button" disabled={!!busy} onClick={()=>download('png')}><ArrowDownToLine size={13}/>{busy==='png'?'Rendering…':'Download PNG'}</button>
    <button type="button" className="mini-button" onClick={()=>download('csv')}><ArrowDownToLine size={13}/>CSV</button>
    <button type="button" className="mini-button" onClick={()=>void copyCaption()}><ClipboardCopy size={13}/>Copy caption</button>
   </div>
   <div className="recap-markers">
    <div className="panel-heading"><h3>Clip markers <span className="subtle-pill">{markers.length}</span></h3><a className="mini-button" href={`/api/archive/${encodeURIComponent(recap.archiveId)}/markers.csv`} download>Export CSV</a></div>
    <p className="field-hint">A marker is a timecode, not a clip: mark a moment here, export the list, and cut it in the editor. No video is encoded or uploaded.</p>
    <div className="recap-marker-add">
     <input type="text" maxLength={120} placeholder="What happened? (optional)" value={markerLabel} onChange={event=>setMarkerLabel(event.target.value)} disabled={!canControl}/>
     <button type="button" className="button primary" disabled={!canControl||busy==='marker'} onClick={()=>void addMarker('manual')}><ClipboardCopy size={13}/>{busy==='marker'?'Marking…':'Mark this moment'}</button>
    </div>
    {markers.length>0&&<ol className="recap-marker-list">{[...markers].sort((first,second)=>first.at-second.at).map(marker=><li key={marker.id}>
     <code>{timecode(marker.offsetMs)}</code>
     <span>{marker.label||marker.kind}{marker.round!==null?` · round ${marker.round+1}`:''}</span>
     {onReplay&&<button type="button" className="mini-button" onClick={()=>onReplay(marker.at)}>Replay</button>}
     <button type="button" className="icon-button danger" aria-label="Remove marker" disabled={!canControl} onClick={()=>void removeMarker(marker.id)}>×</button>
    </li>)}</ol>}
   </div>
   <div className="recap-deliver">
    <label className="field"><span>DELIVER TO A DISCORD WEBHOOK</span><input type="url" value={webhook} onChange={event=>setWebhook(event.target.value)} placeholder="https://discord.com/api/webhooks/…" disabled={!canControl}/><small className="field-hint">Only https URLs on a public host are accepted. The message contains the score, the maps and the MVP — nothing from your account.</small></label>
    <button type="button" className="button primary" disabled={!canControl||!!busy||webhook.length<10} onClick={()=>void deliver()}><Send size={14}/>{busy==='deliver'?'Sending…':'Send recap'}</button>
  </div>
   <details className="recap-caption"><summary>Caption</summary><pre>{recapCaption(recap)}</pre></details>
   <p className="field-hint"><Users size={12}/> {finished.length} finished archive{finished.length===1?'':'s'} available.</p>
  </>:<p className="field-hint">Choose a match to build its recap.</p>}
 </section>;
}
