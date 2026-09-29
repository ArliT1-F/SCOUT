import React,{useRef,useState} from 'react';
import {Image as ImageIcon,Plus,Trash2,Upload,X} from 'lucide-react';
import type {ScoutConfig,TeamConfig,MapConfig,BracketMatch} from '../server/config';
// The operator-side editors behind Teams & players, Match setup and Tournament tree. Everything here
// edits a local draft of config/teams.json; the host persists it through PUT /api/config and pushes
// it to every output view. Logos and map pictures go through POST /api/upload and are referenced by
// path, so config stays plain JSON and the overlay keeps loading images as static assets.
type DraftChange=(next:ScoutConfig)=>void;
const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const MAP_NAMES=['de_ancient','de_anubis','de_dust2','de_inferno','de_mirage','de_nuke','de_overpass','de_train','de_vertigo'];
const assetUrl=(path?:string)=>path?(path.startsWith('uploads/')?'/'+path:path):'';

export function ImageUpload({kind,value,onChange,title}:{kind:'logo'|'map';value?:string;onChange:(path:string)=>void;title?:string}){
 const inputRef=useRef<HTMLInputElement>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 async function pick(file:File|undefined){
  if(!file) return;
  if(!/^image\//.test(file.type)||file.size>5*1024*1024){setError('Use a PNG, JPEG, GIF, WEBP or SVG up to 5 MB');return}
  setError('');setBusy(true);
  try{
   const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('could not read the file'));reader.readAsDataURL(file)});
   const res=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,name:file.name,data})});
   const body=await res.json().catch(()=>({}));
  if(!res.ok) throw Error(body.error||'Upload failed');
   onChange(String(body.path||''));
  }catch(reason:any){setError(reason.message||'Upload failed')}
  finally{setBusy(false);if(inputRef.current) inputRef.current.value=''}
 }
 return <div className={'image-upload '+(busy?'busy':'')}>
  {value?<img className="image-preview" src={assetUrl(value)} alt={title||'uploaded image'} onError={event=>{(event.target as HTMLImageElement).style.opacity='0.25'}}/>:<div className="image-empty"><ImageIcon size={17}/><small>NO IMAGE</small></div>}
  <div className="image-actions">
   <button type="button" className="mini-button" disabled={busy} onClick={()=>inputRef.current?.click()}><Upload size={12}/>{busy?'Uploading…':value?'Replace':'Upload'}</button>
   {value&&<button type="button" className="mini-button danger" disabled={busy} onClick={()=>{onChange('');setError('')}}><X size={12}/>Remove</button>}
  </div>
  <input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onChange={event=>pick(event.target.files?.[0])}/>
  {error&&<small className="field-error">{error}</small>}
 </div>;
}

export function TeamEditor({config,onChange}:{config:ScoutConfig;onChange:DraftChange}){
 const updateTeam=(index:number,patch:Partial<TeamConfig>)=>{const teams=clone(config.teams);teams[index]={...teams[index],...patch};onChange({...config,teams})};
 const updatePlayer=(teamIndex:number,playerIndex:number,patch:Record<string,string>)=>{const teams=clone(config.teams);teams[teamIndex].players[playerIndex]={...teams[teamIndex].players[playerIndex],...patch};onChange({...config,teams})};
 const addPlayer=(teamIndex:number)=>{const teams=clone(config.teams);if(teams[teamIndex].players.length>=10)return;teams[teamIndex].players.push({steamid:'',name:'',nickname:'',role:''});onChange({...config,teams})};
 const removePlayer=(teamIndex:number,playerIndex:number)=>{const teams=clone(config.teams);teams[teamIndex].players.splice(playerIndex,1);onChange({...config,teams})};
 return <section className="panel detail-panel">
  <div className="editor-head"><h2>Teams & rosters</h2><p>Names, tags, colours, logos and the starting lineups shown on the HUD. Roster SteamIDs let the host bind a team to CT/T even when the game reports another name.</p></div>
  <div className="team-cards">{config.teams.map((team,ti)=>
   <div className="team-card" key={team.id}>
    <div className="team-card-head">
     <ImageUpload kind="logo" value={team.logo} title={team.name} onChange={path=>updateTeam(ti,{logo:path})}/>
     <div className="team-fields">
      <label className="field"><span>TEAM NAME</span><input value={team.name} maxLength={64} onChange={event=>updateTeam(ti,{name:event.target.value})}/></label>
      <label className="field"><span>TAG</span><input value={team.tag} maxLength={12} placeholder="VTX" onChange={event=>updateTeam(ti,{tag:event.target.value})}/></label>
      <label className="field"><span>COLOUR</span><span className="color-field"><input type="color" value={team.color||'#d970c2'} onChange={event=>updateTeam(ti,{color:event.target.value})}/><input value={team.color} placeholder="#d970c2" maxLength={32} onChange={event=>updateTeam(ti,{color:event.target.value})}/></span></label>
     </div>
    </div>
    <div className="roster">
     <div className="section-label">ROSTER · {team.players.length} PLAYERS</div>
     {team.players.map((player,pi)=>
      <div className="roster-row" key={pi}>
       <span className="roster-index">{pi+1}</span>
       <input placeholder="Nickname" value={player.name} maxLength={64} onChange={event=>updatePlayer(ti,pi,{name:event.target.value})}/>
       <input placeholder="Real name" value={player.nickname} maxLength={64} onChange={event=>updatePlayer(ti,pi,{nickname:event.target.value})}/>
       <input placeholder="SteamID (optional)" value={player.steamid} maxLength={40} onChange={event=>updatePlayer(ti,pi,{steamid:event.target.value})}/>
       <input placeholder="Role" value={player.role} maxLength={64} onChange={event=>updatePlayer(ti,pi,{role:event.target.value})}/>
       <button type="button" className="icon-button danger" title="Remove player" onClick={()=>removePlayer(ti,pi)}><Trash2 size={13}/></button>
      </div>)}
     <button type="button" className="control-button dashed" onClick={()=>addPlayer(ti)}><span><Plus size={13}/> Add player</span></button>
    </div>
   </div>)}
  </div>
 </section>;
}

export function MatchEditor({config,onChange}:{config:ScoutConfig;onChange:DraftChange}){
 const updateMap=(index:number,patch:Partial<MapConfig>)=>{const maps=clone(config.maps);maps[index]={...maps[index],...patch};onChange({...config,maps})};
 const addMap=()=>{if(config.maps.length>=9)return;const maps=clone(config.maps);maps.push({name:'de_mirage',pick:'decider',status:'upcoming',image:''});onChange({...config,maps})};
 const removeMap=(index:number)=>{const maps=clone(config.maps);maps.splice(index,1);if(!maps.length)maps.push({name:'de_mirage',pick:'decider',status:'upcoming',image:''});onChange({...config,maps})};
 const [teamA,teamB]=config.teams;
 return <section className="panel detail-panel">
  <div className="editor-head"><h2>Match & map series</h2><p>Event, format and the maps played — with the pictures shown on the Map series scene. Scores here are the operator's series cards; live round scores still come from GSI.</p></div>
  <div className="form-grid">
   <label className="field"><span>EVENT NAME</span><input value={config.event.name} maxLength={120} placeholder="Campus Cup 2025" onChange={event=>onChange({...config,event:{...config.event,name:event.target.value}})}/></label>
   <label className="field"><span>STAGE</span><input value={config.event.stage} maxLength={120} placeholder="Grand final" onChange={event=>onChange({...config,event:{...config.event,stage:event.target.value}})}/></label>
   <label className="field"><span>FORMAT</span><select value={config.format} onChange={event=>onChange({...config,format:event.target.value as ScoutConfig['format']})}><option value="bo1">Best of 1</option><option value="bo3">Best of 3</option><option value="bo5">Best of 5</option></select></label>
   <label className="field"><span>MR (ROUNDS / HALF)</span><input type="number" min={1} max={30} value={config.mr} onChange={event=>onChange({...config,mr:Number(event.target.value)||12})}/></label>
   <label className="field"><span>OT (ROUNDS / OT HALF)</span><input type="number" min={1} max={15} value={config.otMr} onChange={event=>onChange({...config,otMr:Number(event.target.value)||3})}/></label>
  </div>
  <div className="section-label map-series-label">MAP SERIES</div>
  <div className="map-rows">
   {config.maps.map((map,mi)=>
    <div className="map-row" key={mi}>
     <ImageUpload kind="map" value={map.image} title={map.name} onChange={path=>updateMap(mi,{image:path})}/>
     <div className="map-fields">
      <label className="field"><span>MAP</span><input list="scout-map-names" value={map.name} maxLength={64} onChange={event=>updateMap(mi,{name:event.target.value})}/></label>
      <label className="field"><span>PICK</span><select value={map.pick} onChange={event=>updateMap(mi,{pick:event.target.value as MapConfig['pick']})}><option value="A">{teamA.name||'Team A'} pick</option><option value="B">{teamB.name||'Team B'} pick</option><option value="decider">Decider</option></select></label>
      <label className="field"><span>STATUS</span><select value={map.status} onChange={event=>updateMap(mi,{status:event.target.value as MapConfig['status']})}><option value="upcoming">Upcoming</option><option value="live">Live</option><option value="done">Finished</option></select></label>
      <label className="field"><span>SCORE</span><span className="score-field"><input type="number" min={0} max={99} value={map.score?.[0]??''} placeholder="—" onChange={event=>updateMap(mi,{score:event.target.value===''?undefined:[Number(event.target.value)||0,map.score?.[1]??0]})}/><i>:</i><input type="number" min={0} max={99} value={map.score?.[1]??''} placeholder="—" onChange={event=>updateMap(mi,{score:event.target.value===''?undefined:[map.score?.[0]??0,Number(event.target.value)||0]})}/></span></label>
     </div>
     <button type="button" className="icon-button danger" title="Remove map" onClick={()=>removeMap(mi)}><Trash2 size={14}/></button>
    </div>)}
  </div>
  <datalist id="scout-map-names">{MAP_NAMES.map(name=><option value={name} key={name}/>)}</datalist>
  <button type="button" className="control-button dashed wide" onClick={addMap}><span><Plus size={13}/> Add map to the series</span></button>
 </section>;
}

export function BracketEditor({config,onChange}:{config:ScoutConfig;onChange:DraftChange}){
 const {bracket}=config;
 const commit=(rounds:ScoutConfig['bracket']['rounds'])=>{
  // Propagation mirrors the host: a set winner writes its slot forward positionally, so the tree
  // the admin sees is always the tree the overlay will draw.
  const next=clone(rounds);
  for(let r=0;r<next.length-1;r++)for(let i=0;i<next[r].matches.length;i++){
   const match=next[r].matches[i];if(!match.winner)continue;
   const target=next[r+1]?.matches[Math.floor(i/2)];if(!target)continue;
   const from=match.winner==='a'?match.a:match.b;
   target[i%2===0?'a':'b']={label:from.label||from.team||'TBD',team:from.team||''};
  }
  onChange({...config,bracket:{...bracket,rounds:next}});
 };
 const updateMatch=(ri:number,mi:number,patch:Partial<BracketMatch>)=>{const rounds=clone(bracket.rounds);rounds[ri].matches[mi]={...rounds[ri].matches[mi],...patch};commit(rounds)};
 const setWinner=(ri:number,mi:number,side:'a'|'b')=>{const rounds=clone(bracket.rounds);const match=rounds[ri].matches[mi];updateMatch(ri,mi,{winner:match.winner===side?null:side,status:match.winner===side?match.status:'done'})};
 const addMatch=(ri:number)=>{const rounds=clone(bracket.rounds);if(rounds[ri].matches.length>=16)return;rounds[ri].matches.push({id:`m${Date.now().toString(36)}${rounds[ri].matches.length}`,a:{label:'',team:''},b:{label:'',team:''},aScore:0,bScore:0,winner:null,status:'upcoming'});commit(rounds)};
 const removeMatch=(ri:number,mi:number)=>{const rounds=clone(bracket.rounds);if(rounds[ri].matches.length<=1)return;rounds[ri].matches.splice(mi,1);commit(rounds)};
 const addRound=()=>{if(bracket.rounds.length>=8)return;const rounds=clone(bracket.rounds);rounds.push({name:`Round ${rounds.length+1}`,matches:[{id:`m${Date.now().toString(36)}x`,a:{label:'',team:''},b:{label:'',team:''},aScore:0,bScore:0,winner:null,status:'upcoming'}]});commit(rounds)};
 const removeRound=(ri:number)=>{if(bracket.rounds.length<=1)return;const rounds=clone(bracket.rounds);rounds.splice(ri,1);commit(rounds)};
 const teamOf=(id?:string)=>config.teams.find(team=>team.id===id);
 const slotLabel=(slot:BracketMatch['a'])=>{
  const team=teamOf(slot?.team);
  return team?team.name:(slot?.label||'TBD');
 };
 return <section className="panel detail-panel">
  <div className="editor-head"><h2>Tournament tree</h2><p>Single-elimination bracket: the winner of match N advances into match ⌊N/2⌋ of the next round. Click a side to set (or clear) the winner — everything downstream updates itself.</p></div>
  <label className="field bracket-title"><span>BRACKET TITLE</span><input value={bracket.title} maxLength={120} placeholder="Playoffs" onChange={event=>onChange({...config,bracket:{...bracket,title:event.target.value}})}/></label>
  <div className="bracket-board">
   {bracket.rounds.map((round,ri)=>
    <div className="bracket-round" key={ri}>
     <div className="bracket-round-head">
      <input className="bracket-round-name" value={round.name} maxLength={64} onChange={event=>{const rounds=clone(bracket.rounds);rounds[ri].name=event.target.value;onChange({...config,bracket:{...bracket,rounds}})}}/>
      <button type="button" className="icon-button danger" title="Remove round" disabled={bracket.rounds.length<=1} onClick={()=>removeRound(ri)}><Trash2 size={13}/></button>
     </div>
     {round.matches.map((match,mi)=>
      <div className={'bracket-match '+(match.winner?'decided':match.status==='live'?'live':'')} key={match.id}>
       {(['a','b'] as const).map(side=>
        <div className="bracket-slot-row" key={side}>
         <button type="button" className={'bracket-slot '+(match.winner===side?'won':match.winner?'lost':'')} title={match.winner===side?'Winner — click to undo':'Set winner'} onClick={()=>setWinner(ri,mi,side)}>
          <span className="bracket-slot-label">{slotLabel(match[side])}</span>
          <em>{side==='a'?match.aScore:match.bScore}</em>
         </button>
         <div className="bracket-slot-edit">
          <select value={match[side].team||''} onChange={event=>updateMatch(ri,mi,{[side]:{...match[side],team:event.target.value}} as Partial<BracketMatch>)}>
           <option value="">Custom seed</option>
           {config.teams.map(team=><option value={team.id} key={team.id}>{team.name}</option>)}
          </select>
          <input placeholder="Seed label" value={match[side].label} maxLength={64} disabled={!!match[side].team} onChange={event=>updateMatch(ri,mi,{[side]:{...match[side],label:event.target.value}} as Partial<BracketMatch>)}/>
          <input className="bracket-score-input" type="number" min={0} max={99} title="Maps won" value={side==='a'?match.aScore:match.bScore} onChange={event=>updateMatch(ri,mi,{[side==='a'?'aScore':'bScore']:Number(event.target.value)||0})}/>
         </div>
        </div>)}
       <div className="bracket-match-foot">
        <select value={match.status} onChange={event=>updateMatch(ri,mi,{status:event.target.value as BracketMatch['status']})}>
         <option value="upcoming">Upcoming</option><option value="live">Live</option><option value="done">Finished</option>
        </select>
        {match.winner&&<button type="button" className="mini-button" onClick={()=>updateMatch(ri,mi,{winner:null})}><X size={11}/> Clear result</button>}
        <button type="button" className="icon-button danger" title="Remove match" disabled={round.matches.length<=1} onClick={()=>removeMatch(ri,mi)}><Trash2 size={13}/></button>
       </div>
      </div>)}
     <button type="button" className="control-button dashed" onClick={()=>addMatch(ri)}><span><Plus size={12}/> Add match</span></button>
    </div>)}
   <div className="bracket-round bracket-round-add">
    <button type="button" className="control-button dashed" disabled={bracket.rounds.length>=8} onClick={addRound}><span><Plus size={12}/> Add round</span></button>
   </div>
  </div>
 </section>;
}
