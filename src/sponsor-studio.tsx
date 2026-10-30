import React,{useEffect,useState} from 'react';
import {Eye,Globe2,Image as ImageIcon,Plus,Trash2} from 'lucide-react';
import {MAX_SPONSORS,SPONSOR_ASSET,SPONSOR_ROTATION_MS,activeSponsor,emptySponsor,rotationCycle} from '../server/sponsor-rotation';
import type {OverlayConfig,OverlayWidget} from '../server/overlay';
import {assetUrl} from './assets';
import {ImageUpload} from './admin';

// The sponsor layer's inspector. Sponsors are broadcast graphics first and a report second, so the
// same panel shows the artwork, how long each one holds the screen, and what the host has already
// counted as impressions — no second "sponsor dashboard" to keep in sync.
export function SponsorInspector({value,widget,onChange,onNotice}:{
 value:OverlayConfig;widget:OverlayWidget;onChange:(next:OverlayConfig)=>void;onNotice?:(message:string)=>void;
}){
 const sponsors=value.sponsors;
 const [report,setReport]=useState<{total:number;rows:Array<{id:string;name:string;impressions:number;share:number}>}|null>(null);
 const [error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  fetch('/api/sponsors/report?days=30').then(response=>response.ok?response.json():null).then(body=>{if(live&&body)setReport(body)}).catch(()=>{});
  return()=>{live=false};
 },[]);
 const patch=(index:number,patch:Partial<OverlayConfig['sponsors'][number]>)=>onChange({...value,sponsors:sponsors.map((slot,position)=>position===index?{...slot,...patch}:slot)});
 const remove=(index:number)=>onChange({...value,sponsors:sponsors.filter((_,position)=>position!==index)});
 const add=(asset:string)=>{
  if(sponsors.length>=MAX_SPONSORS){setError(`Remove a sponsor before adding another (maximum ${MAX_SPONSORS}).`);return}
  const name=asset.split('/').pop()?.replace(/\.[a-z0-9]+$/i,'').replace(/[_-]+/g,' ').replace(/^\d+\s*/,'').trim().slice(0,48)||`Sponsor ${sponsors.length+1}`;
  onChange({...value,sponsors:[...sponsors,{...emptySponsor(sponsors.length,asset),name}]});
 };
 const cycle=rotationCycle(sponsors);
 const onAir=activeSponsor(sponsors,Date.now(),widget.rotateMs||SPONSOR_ROTATION_MS);
 return <div className="inspector-section sponsor-inspector">
  <h4>Sponsor rotation <small>{sponsors.length}/{MAX_SPONSORS} · PNG, JPEG, WEBP or GIF</small></h4>
  <p className="studio-hint">Each graphic takes a turn in this layer. Weight is airtime, not order: weight 3 gets three turns for every one a weight 1 gets. The overlay picks from the clock, so every output switches together.</p>
  <div className="studio-form-grid">
   <label className="studio-field"><span>SECONDS PER GRAPHIC</span><select value={String(widget.rotateMs||SPONSOR_ROTATION_MS)} onChange={event=>onChange({...value,widgets:value.widgets.map(candidate=>candidate.id===widget.id?{...candidate,rotateMs:Number(event.target.value)}:candidate)})}>{[10000,15000,20000,30000,45000,60000].map(ms=><option key={ms} value={ms}>{ms/1000} s</option>)}</select></label>
   <label className="studio-field"><span>SCENES</span><button type="button" className="mini-button" onClick={()=>onChange({...value,widgets:value.widgets.map(candidate=>candidate.id===widget.id?{...candidate,showOn:['live','matchup','lineups','veto','bracket','winner','break','recap','stats']}:candidate)})}><Globe2 size={12}/>Show in every scene</button></label>
  </div>
  {error&&<p className="field-error" role="alert">{error}</p>}
  <div className="sponsor-list">
   {sponsors.length===0&&<p className="studio-hint"><ImageIcon size={13}/> No sponsor graphics yet. Upload one below — it appears in the preview immediately, and nothing is published until you press Publish to outputs.</p>}
   {sponsors.map((slot,index)=><div className={'sponsor-row'+(slot.enabled?'':' disabled')+(onAir?.id===slot.id?' on-air':'')} key={slot.id}>
    <span className="sponsor-thumb">{SPONSOR_ASSET.test(slot.asset)?<img src={assetUrl(slot.asset)} alt=""/>:<ImageIcon size={14}/>}</span>
    <label className="studio-field"><span>NAME</span><input maxLength={48} value={slot.name} onChange={event=>patch(index,{name:event.target.value})}/></label>
    <label className="studio-field sponsor-weight"><span>WEIGHT</span><input type="number" min={1} max={100} value={slot.weight} onChange={event=>patch(index,{weight:Math.max(1,Math.min(100,Number(event.target.value)||1))})}/></label>
    <button type="button" role="switch" aria-checked={slot.enabled} aria-label={`Show ${slot.name}`} className={'toggle '+(slot.enabled?'enabled':'')} onClick={()=>patch(index,{enabled:!slot.enabled})}><i/></button>
    <button type="button" className="icon-button danger" aria-label={`Remove ${slot.name}`} onClick={()=>remove(index)}><Trash2 size={12}/></button>
   </div>)}
  </div>
  {sponsors.length<MAX_SPONSORS&&<div className="sponsor-add"><ImageUpload kind="overlay" value="" title="Add a sponsor graphic" onChange={asset=>{if(asset)add(asset)}}/><span className="studio-hint"><Plus size={12}/> Upload to add a sponsor</span></div>}
  {cycle.length>0&&<p className="studio-hint">Cycle: {cycle.length} turn{cycle.length===1?'':'s'} · {Math.round((cycle.length*(widget.rotateMs||SPONSOR_ROTATION_MS))/1000)} s to loop{onAir?` · on air now: ${onAir.name}`:''}</p>}
  <div className="sponsor-report">
   <h5><Eye size={13}/> Proof of play, last 30 days</h5>
   {report?<>
    <p className="studio-hint">{report.total?`${report.total} sampled impression${report.total===1?'':'s'} recorded by this host.`:'Nothing counted yet — the number starts when this layer is published and visible in a scene.'}</p>
    {report.rows.length>0&&<table className="desk-table sponsor-report-table"><thead><tr><th>Sponsor</th><th>Impressions</th><th>Share</th></tr></thead><tbody>{report.rows.map(row=><tr key={row.id}><td>{row.name}</td><td>{row.impressions}</td><td>{row.share}%</td></tr>)}</tbody></table>}
    <a className="mini-button" href="/api/sponsors/report.csv?days=30" download><Eye size={12}/>Export CSV</a>
   </>:<p className="studio-hint">The report could not be loaded.</p>}
  </div>
  <p className="studio-hint">Proof of play is sampled by the host every few seconds while this layer is on screen — one count per sponsor per scene per rotation step. It is an honest measure of what went to air from this machine, not a third-party ad-server number.</p>
 </div>;
}
