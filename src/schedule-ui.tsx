import React,{useEffect,useMemo,useState} from 'react';
import {CalendarDays,Clock3,Download,Play,Plus,Sparkles,Trash2,Wand2} from 'lucide-react';
import type {ScoutConfig,ScheduleSlot} from '../server/config';
import {SLOT_DURATION_MS,generateBracket,nextUps,slotLabel,suggestBreak,type SlotWindow} from '../server/schedule';

// Run of Show (docs/LAUNCH-FEATURES.md §2). Two surfaces share this file:
//   * ScheduleEditor — the fixture table and bracket generator, in the panel's "Run of show" tab;
//   * MatchDayCard   — now / next / later on the app dashboard, where an operator actually looks.
// Both talk to the same host APIs (/api/schedule/apply and /api/schedule.ics) and to the same pure
// module the server uses, so "next match" means one thing everywhere.

const localInput=(at:number)=>{
 const date=new Date(at);
 const pad=(value:number)=>String(value).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput=(value:string)=>new Date(value).getTime()||0;
const timeLabel=(at:number)=>new Date(at).toLocaleString([], {weekday:'short',hour:'2-digit',minute:'2-digit'});
const delayLabel=(ms:number)=>{
 if(ms<=0) return 'now';
 const minutes=Math.round(ms/60_000);
 if(minutes<60) return `in ${minutes} min`;
 const hours=Math.round(minutes/60);
 return `in ${hours} h`;
};
const newSlot=(config:ScoutConfig,index:number):ScheduleSlot=>{
 // The first slot is "an hour from now, rounded up", the rest follow the previous fixture's block.
 const base=index===0?Math.ceil((Date.now()+60*60_000)/900_000)*900_000:0;
 const previous=config.schedule[index-1];
 const at=previous?previous.at+SLOT_DURATION_MS[previous.format]:base;
 return {id:`slot-${Date.now().toString(36)}-${index+1}`,at,a:{team:'',label:''},b:{team:'',label:''},stage:config.event.stage||'',format:config.format,stream:'',note:'',bracketMatchId:''};
};

export function ScheduleEditor({config,onChange,offsetMinutes,onOffset,canEdit,onNotice}:{
 config:ScoutConfig;onChange:(next:ScoutConfig)=>void;offsetMinutes:number;onOffset:(minutes:number)=>void;canEdit:boolean;onNotice:(message:string)=>void;
}){
 const [entries,setEntries]=useState('');
 const [startAt,setStartAt]=useState(()=>localInput(Math.ceil((Date.now()+60*60_000)/900_000)*900_000));
 const [replaceFixtures,setReplaceFixtures]=useState(true);
 const [advanced,setAdvanced]=useState(false);
 const schedule=config.schedule;
 const update=(index:number,patch:Partial<ScheduleSlot>)=>onChange({...config,schedule:schedule.map((slot,position)=>position===index?{...slot,...patch}:slot)});
 const add=()=>onChange({...config,schedule:[...schedule,newSlot(config,schedule.length)]});
 const remove=(index:number)=>onChange({...config,schedule:schedule.filter((_,position)=>position!==index)});
 const shift=(index:number,deltaMs:number)=>update(index,{at:Math.max(0,schedule[index].at+deltaMs)});
 const totalMinutes=schedule.reduce((sum,slot)=>sum+SLOT_DURATION_MS[slot.format],0);
 const suggestion=useMemo(()=>suggestBreak(schedule,offsetMinutes*60_000,Date.now()),[schedule,offsetMinutes]);
 const teamNames=config.teams.map(team=>team.name);
 const generate=()=>{
  const names=entries.split('\n').map(line=>line.trim()).filter(Boolean);
  if(names.length<2){onNotice('Add at least two teams, one per line, before generating a bracket.');return}
  try{
   const generated=generateBracket({entries:names.map(label=>({label})),title:config.event.name,format:config.format,startAt:fromLocalInput(startAt),makeSlots:true});
   // Generated ids are stable per bracket position; prefix them so regenerating cannot collide with
   // fixtures an operator already moved by hand.
   const stamp=Date.now().toString(36);
   const slots=generated.slots.map((slot,index)=>({...slot,id:`slot-${stamp}-${index+1}`,bracketMatchId:slot.bracketMatchId?`${stamp}-${slot.bracketMatchId}-${index}`:''}));
   onChange({...config,bracket:generated.bracket,schedule:replaceFixtures?slots:[...schedule,...slots]});
   onNotice(`Bracket generated: ${names.length} teams, ${generated.byes} bye(s), ${slots.length} first-round fixture(s). Save the configuration to publish it.`);
  }catch(error:any){onNotice(error?.message||'The bracket could not be generated.')}
 };
 return <section className="panel detail-panel schedule-panel">
  <div className="panel-heading">
   <div><h2>Run of show <span className="subtle-pill">{schedule.length} fixture{schedule.length===1?'':'s'}</span></h2><p className="info-note">Times are stored as absolute instants and shown in this machine&apos;s timezone. The calendar export renders them in each reader&apos;s own zone.</p></div>
   <div className="schedule-actions">
    <a className="mini-button" href="/api/schedule.ics" download><Download size={13}/>Calendar (.ics)</a>
   </div>
  </div>
  <div className="schedule-summary">
   <div><CalendarDays size={15}/><b>{schedule.length}</b><span>fixtures</span></div>
   <div><Clock3 size={15}/><b>{Math.round(totalMinutes/60*10)/10}</b><span>hours of broadcast</span></div>
   <label className="schedule-offset"><span>RUNNING LATE</span><input type="number" min={0} max={720} step={5} disabled={!canEdit} value={offsetMinutes} onChange={event=>onOffset(Math.max(0,Math.min(720,Number(event.target.value)||0)))}/><em>min</em></label>
  </div>
  {suggestion&&<p className="info-note schedule-hint">Next: <b>{suggestion.label}</b> {suggestion.stage?`(${suggestion.stage}) `:''}in {suggestion.minutes} minute{suggestion.minutes===1?'':'s'}. <button className="text-button" onClick={()=>onOffset(offsetMinutes+15)}>Push back 15 min</button></p>}
  <div className="schedule-table-wrap">
   <table className="desk-table schedule-table">
    <thead><tr><th>When</th><th>A</th><th>B</th><th>Stage</th><th>Format</th><th>Stream</th><th aria-label="Actions"/></tr></thead>
    <tbody>
     {schedule.length===0&&<tr><td colSpan={7} className="schedule-empty">No fixtures yet. Add one below, or generate a bracket from a team list.</td></tr>}
     {schedule.map((slot,index)=>{
      const window:SlotWindow={...slot,effectiveAt:slot.at+(slot.at>Date.now()?offsetMinutes*60_000:0),durationMs:SLOT_DURATION_MS[slot.format],endsAt:slot.at+(slot.at>Date.now()?offsetMinutes*60_000:0)+SLOT_DURATION_MS[slot.format]};
      return <tr key={slot.id}>
       <td><input type="datetime-local" disabled={!canEdit} value={localInput(slot.at)} onChange={event=>update(index,{at:fromLocalInput(event.target.value)})}/><small className="schedule-delay">{delayLabel(window.effectiveAt-Date.now())}</small></td>
       <td><input type="text" maxLength={64} disabled={!canEdit} list="scout-team-names" placeholder={teamNames[0]||'Team A'} value={slot.a.label} onChange={event=>update(index,{a:{...slot.a,label:event.target.value}})}/></td>
       <td><input type="text" maxLength={64} disabled={!canEdit} list="scout-team-names" placeholder={teamNames[1]||'Team B'} value={slot.b.label} onChange={event=>update(index,{b:{...slot.b,label:event.target.value}})}/></td>
       <td><input type="text" maxLength={120} disabled={!canEdit} value={slot.stage} placeholder="Semifinal" onChange={event=>update(index,{stage:event.target.value})}/></td>
       <td><select disabled={!canEdit} value={slot.format} onChange={event=>update(index,{format:event.target.value as ScheduleSlot['format']})}><option value="bo1">BO1</option><option value="bo3">BO3</option><option value="bo5">BO5</option></select></td>
       <td><input type="url" maxLength={300} disabled={!canEdit} value={slot.stream} placeholder="https://twitch.tv/…" onChange={event=>update(index,{stream:event.target.value})}/></td>
       <td><div className="schedule-row-actions"><button type="button" className="mini-button" disabled={!canEdit} title="Move 15 minutes earlier" onClick={()=>shift(index,-15*60_000)}>−15</button><button type="button" className="mini-button" disabled={!canEdit} title="Move 15 minutes later" onClick={()=>shift(index,15*60_000)}>+15</button><button type="button" className="icon-button danger" disabled={!canEdit} aria-label="Remove fixture" onClick={()=>remove(index)}><Trash2 size={13}/></button></div></td>
      </tr>;
     })}
    </tbody>
   </table>
   <datalist id="scout-team-names">{teamNames.map(name=><option key={name} value={name}/>)}</datalist>
   <button type="button" className="button" disabled={!canEdit} onClick={add}><Plus size={14}/>Add fixture</button>
  </div>
  <details className="schedule-generator" open={advanced} onToggle={event=>setAdvanced((event.target as HTMLDetailsElement).open)}>
   <summary><Sparkles size={14}/>Generate a bracket and its fixtures</summary>
   <div className="schedule-generator-body">
    <label className="field"><span>TEAMS, ONE PER LINE (SEEDING ORDER)</span><textarea rows={8} value={entries} onChange={event=>setEntries(event.target.value)} placeholder={'Vertex\nParallax\nNightshift\nHarbor\n…'} disabled={!canEdit}/><small className="field-hint">Standard single-elimination seeding. A bracket that is not a power of two gets byes, decided automatically and shown in the tree.</small></label>
    <div className="schedule-generator-side">
     <label className="field"><span>FIRST FIXTURE</span><input type="datetime-local" value={startAt} onChange={event=>setStartAt(event.target.value)} disabled={!canEdit}/></label>
     <label className="toggle-row"><div><b>Replace the fixture list</b><small>Off: append the generated fixtures instead</small></div><button type="button" aria-pressed={replaceFixtures} className={'toggle '+(replaceFixtures?'enabled':'')} disabled={!canEdit} onClick={()=>setReplaceFixtures(!replaceFixtures)}><i/></button></label>
     <button type="button" className="button primary" disabled={!canEdit} onClick={generate}><Wand2 size={14}/>Generate bracket</button>
     <p className="field-hint">Generation writes the bracket and the fixtures into this configuration; nothing is published until you press Save configuration.</p>
    </div>
   </div>
  </details>
 </section>;
}

// The dashboard card. It polls nothing itself: the app already holds the live snapshot, and the
// countdown is computed from the same server clock the break timer uses.
export function MatchDayCard({config,offsetMinutes,now,canControl,onNotice}:{
 config:ScoutConfig|undefined;offsetMinutes:number;now:number;canControl:boolean;onNotice:(message:string)=>void;
}){
 const [busy,setBusy]=useState('');
 const [,setTick]=useState(0);
 useEffect(()=>{const timer=setInterval(()=>setTick(value=>value+1),30_000);return()=>clearInterval(timer)},[]);
 if(!config?.schedule?.length) return null;
 const {next,live}=nextUps(config.schedule,offsetMinutes*60_000,now);
 const later=config.schedule.filter(slot=>next?slot.at>next.at:slot.at>now).slice(0,3);
 const act=async(slotId:string,action:'match'|'break')=>{
  setBusy(slotId+action);
  try{
   const response=await fetch('/api/schedule/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slotId,action})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'That fixture could not be applied.');
   onNotice(action==='break'?'Break screen set for the next fixture.':'Fixture loaded into the overlay.');
  }catch(error:any){onNotice(error?.message||'That fixture could not be applied.')}
  finally{setBusy('')}
 };
 const row=(slot:SlotWindow|null,tone:'live'|'next'|'later')=>{
  if(!slot) return null;
  const at=slot.effectiveAt;
  return <div className={'matchday-row '+tone} key={slot.id}>
   <div className="matchday-time"><b>{new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</b><small>{tone==='live'?'ON NOW':tone==='next'?delayLabel(at-now):timeLabel(at)}</small></div>
   <div className="matchday-who"><b>{slotLabel(slot)}</b><small>{[slot.stage,slot.format.toUpperCase(),slot.stream?'Stream link set':''].filter(Boolean).join(' · ')}</small></div>
   {tone!=='later'&&<div className="matchday-actions">
    <button type="button" className="mini-button" disabled={!canControl||busy===slot.id+'match'} onClick={()=>void act(slot.id,'match')}><Play size={12}/>Load match</button>
    <button type="button" className="mini-button" disabled={!canControl||busy===slot.id+'break'} onClick={()=>void act(slot.id,'break')}>Break to it</button>
   </div>}
  </div>;
 };
 return <section className="panel matchday-card">
  <div className="panel-heading"><h2>Match day <span className="subtle-pill">{config.schedule.length} fixtures</span></h2>{offsetMinutes>0&&<span className="schedule-late-pill">+{offsetMinutes} MIN</span>}</div>
  <div className="matchday-list">
   {row(live,'live')}
   {row(next,'next')}
   {later.map(slot=>row({...slot,effectiveAt:slot.at+(slot.at>now?offsetMinutes*60_000:0),durationMs:SLOT_DURATION_MS[slot.format],endsAt:slot.at},'later'))}
  </div>
 </section>;
}

// A tiny shared export so the panel and the app dashboard agree on how a fixture reads.
export function fixtureSummary(config:ScoutConfig|undefined,offsetMinutes:number,now:number){
 const slot=nextUps(config?.schedule??[],offsetMinutes*60_000,now).next;
 return slot?`${slotLabel(slot)} · ${delayLabel(slot.effectiveAt-now)}`:'';
}
