import React,{useEffect,useMemo,useState} from 'react';
import {Bot,Play,Pause,Plus,Power,RotateCcw,ShieldAlert,Trash2} from 'lucide-react';
import type {Controls} from '../server/controls';
import {SCENE_IDS,SCENE_TITLES} from '../server/controls';
import {MANUAL_SUSPEND_MS,defaultAutomation,normalizeAutomation,scheduleForRules,type AutomationConfig,type AutomationRule,type AutomationStatus,type AutomationTrigger} from '../server/automation';

// Auto-pilot (docs/LAUNCH-FEATURES.md §3). The panel edits rules and shows exactly what the engine
// will do next; the engine itself lives in the host, enforces the lease and writes the audit trail.
// This file deliberately contains no execution logic: a UI that can also fire a scene change would be
// a second, untested path to air.

const TRIGGERS:Array<{id:AutomationTrigger['type'];label:string;hint:string}>=[
 {id:'round-end',label:'A round ends','hint':'Fires on every completed round, from the GSI feed.'},
 {id:'series-end',label:'The series ends','hint':'Fires when the match reaches game over.'},
 {id:'break-over',label:'The break countdown ends','hint':'Fires once when the break clock passes zero.'},
 {id:'slot-soon',label:'The next fixture is close','hint':'Fires when the next scheduled match is within the rule’s window.'},
];
const triggerLabel=(type:AutomationTrigger['type'])=>TRIGGERS.find(trigger=>trigger.id===type)?.label??type;
const ruleSummary=(rule:AutomationRule)=>{
 const steps=rule.do.map(action=>`${action.scene?SCENE_TITLES[action.scene as keyof typeof SCENE_TITLES]??action.scene:'countdown'}${action.after?` +${action.after}s`:''}`).join(' → ');
 return `${triggerLabel(rule.when.type)}${rule.when.minutes!==undefined?` (${rule.when.minutes} min)`:''}: ${steps}`;
};

export function AutomationPanel({canControl,onNotice,snapshotStatus}:{canControl:boolean;onNotice:(message:string)=>void;snapshotStatus?:AutomationStatus|null}){
 const [config,setConfig]=useState<AutomationConfig>(defaultAutomation());
 const [status,setStatus]=useState<AutomationStatus|null>(snapshotStatus??null);
 const [busy,setBusy]=useState(false);
 const [loaded,setLoaded]=useState(false);
 const [error,setError]=useState('');
 const [simulate,setSimulate]=useState<'round-end'|'series-end'|'break-over'|'slot-soon'>('round-end');
 useEffect(()=>{
  let live=true;
  (async()=>{
   try{
    const response=await fetch('/api/automation');
    if(!response.ok) throw new Error('The automation rules could not be loaded.');
    const body=await response.json();
    if(!live) return;
    setConfig(normalizeAutomation(body.config));setStatus(body.status??null);setLoaded(true);
   }catch(failure:any){if(live){setError(failure?.message||'The automation rules could not be loaded.');setLoaded(true)}}
  })();
  return()=>{live=false};
 },[]);
 useEffect(()=>{if(snapshotStatus)setStatus(snapshotStatus)},[snapshotStatus]);
 const preview=useMemo(()=>scheduleForRules(config.rules.filter(rule=>rule.enabled),{type:simulate,minutes:30},{now:0,scene:'live',breakEndsAt:null}),[config.rules,simulate]);
 const save=async(next:AutomationConfig)=>{
  setBusy(true);setError('');
  try{
   const response=await fetch('/api/automation',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'The rules could not be saved.');
   setConfig(normalizeAutomation(body.config));setStatus(body.status??null);onNotice(next.enabled?'Auto-pilot enabled — the rules below can now change the scene.':'Auto-pilot disabled.');
  }catch(failure:any){setError(failure?.message||'The rules could not be saved.')}
  finally{setBusy(false)}
 };
 const override=async()=>{
  setBusy(true);
  try{
   const response=await fetch('/api/automation/override',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   const body=await response.json().catch(()=>({}));
   if(!response.ok) throw new Error(body?.error||'Could not pause auto-pilot.');
   setStatus(body.status??null);onNotice('Auto-pilot paused for a minute. Any manual scene change does the same.');
  }catch(failure:any){setError(failure?.message||'Could not pause auto-pilot.')}
  finally{setBusy(false)}
 };
 const patchRule=(index:number,patch:Partial<AutomationRule>)=>setConfig({...config,rules:config.rules.map((rule,position)=>position===index?{...rule,...patch}:rule)});
 const patchAction=(index:number,actionIndex:number,patch:Partial<AutomationRule['do'][number]>)=>patchRule(index,{do:config.rules[index].do.map((action,position)=>position===actionIndex?{...action,...patch}:action)});
 const addRule=()=>setConfig({...config,rules:[...config.rules,{id:`rule-${Date.now().toString(36)}`,name:'New rule',enabled:false,when:{type:'round-end'},do:[{scene:'recap',after:0}],cooldownMs:0}]});
 const removeRule=(index:number)=>setConfig({...config,rules:config.rules.filter((_,position)=>position!==index)});
 const suspended=suspendedLabel(status?.suspendedUntil??null);
 return <section className="panel detail-panel automation-panel">
  <div className="panel-heading">
   <div><h2>Auto-pilot <span className={'subtle-pill '+(config.enabled?'on':'')}>{config.enabled?'ARMED':'OFF'}</span></h2><p className="info-note">Rules only change the scene and the break countdown. They never touch scores, teams or configuration, they never act while another operator holds the control lease, and any manual change pauses them for a minute.</p></div>
   <button type="button" role="switch" aria-checked={config.enabled} aria-label="Enable auto-pilot" className={'toggle '+(config.enabled?'enabled':'')} disabled={!canControl||busy} onClick={()=>void save({...config,enabled:!config.enabled})}><i/></button>
  </div>
  {error&&<p className="unlock-error" role="alert">{error}</p>}
  {status&&<div className="automation-state">
   <div><b>{status.activeRules.length}</b><span>active rules</span></div>
   <div><b>{status.pending.length}</b><span>queued actions</span></div>
   <div><b>{status.lastAction?new Date(status.lastAction.at).toLocaleTimeString():'—'}</b><span>{status.lastAction?status.lastAction.ruleName:'no action yet'}</span></div>
   {status.lastSkip&&<div className="automation-skip"><b>SKIPPED</b><span>{status.lastSkip.detail}</span></div>}
  </div>}
  {suspended&&<p className="info-note"><ShieldAlert size={14}/> Paused until {suspended} after a manual change.</p>}
  <div className="automation-rules">
   {config.rules.map((rule,index)=><article className={'automation-rule'+(rule.enabled?' enabled':'')} key={rule.id}>
    <header>
     <label className="automation-name"><input type="text" maxLength={60} disabled={!canControl} value={rule.name} onChange={event=>patchRule(index,{name:event.target.value})} aria-label="Rule name"/></label>
     <button type="button" role="switch" aria-checked={rule.enabled} aria-label={`Enable ${rule.name}`} className={'toggle '+(rule.enabled?'enabled':'')} disabled={!canControl} onClick={()=>patchRule(index,{enabled:!rule.enabled})}><i/></button>
     <button type="button" className="icon-button danger" aria-label={`Remove ${rule.name}`} disabled={!canControl} onClick={()=>removeRule(index)}><Trash2 size={13}/></button>
    </header>
    <div className="automation-grid">
     <label className="field"><span>WHEN</span><select disabled={!canControl} value={rule.when.type} onChange={event=>patchRule(index,{when:{...rule.when,type:event.target.value as AutomationTrigger['type']}})}>{TRIGGERS.map(trigger=><option key={trigger.id} value={trigger.id}>{trigger.label}</option>)}</select><small className="field-hint">{TRIGGERS.find(trigger=>trigger.id===rule.when.type)?.hint}</small></label>
     {rule.when.type==='slot-soon'&&<label className="field"><span>WINDOW (MINUTES BEFORE)</span><input type="number" min={0} max={180} disabled={!canControl} value={rule.when.minutes??10} onChange={event=>patchRule(index,{when:{...rule.when,minutes:Number(event.target.value)}})}/></label>}
     <label className="field"><span>COOLDOWN (SECONDS)</span><input type="number" min={0} max={3600} step={30} disabled={!canControl} value={Math.round((rule.cooldownMs||0)/1000)} onChange={event=>patchRule(index,{cooldownMs:Math.max(0,Number(event.target.value))*1000})}/></label>
    </div>
    <div className="automation-steps">
     <span className="section-label">THEN</span>
     {rule.do.map((action,actionIndex)=><div className="automation-step" key={actionIndex}>
      <select disabled={!canControl} aria-label="Scene" value={action.scene??''} onChange={event=>patchAction(index,actionIndex,{scene:(event.target.value||undefined) as Controls['scene']|undefined})}><option value="">(no scene)</option>{SCENE_IDS.map(id=><option key={id} value={id}>{SCENE_TITLES[id]}</option>)}</select>
      <label>after <input type="number" min={0} max={600} disabled={!canControl} value={action.after??0} onChange={event=>patchAction(index,actionIndex,{after:Math.max(0,Number(event.target.value))})}/> s</label>
      {actionIndex===rule.do.length-1?<button type="button" className="mini-button" disabled={!canControl||rule.do.length>=4} onClick={()=>patchRule(index,{do:[...rule.do,{scene:'live',after:8}]})}><Plus size={12}/></button>:<button type="button" className="mini-button" disabled={!canControl} onClick={()=>patchRule(index,{do:rule.do.filter((_,position)=>position!==actionIndex)})}><Trash2 size={12}/></button>}
     </div>)}
    </div>
    <p className="automation-summary">{ruleSummary(rule)}</p>
   </article>)}
  </div>
  <div className="automation-alerts">
   <span className="section-label">ALERTS</span>
   <label className="field"><span>WEBHOOK FOR FEED LOSS</span><input type="url" maxLength={300} value={config.alerts?.webhook??''} placeholder="https://discord.com/api/webhooks/…" disabled={!canControl} onChange={event=>setConfig({...config,alerts:{...(config.alerts??{webhook:'',onFeedLoss:true}),webhook:event.target.value}})}/><small className="field-hint">Optional. When the CS2 feed drops during a live map, this posts one message with the host name and how long it has been silent. Leave it empty to keep the alert on the panel only.</small></label>
   <label className="toggle-row"><div><b>Send the alert</b><small>One message per outage; recovery is announced in the same channel</small></div><button type="button" aria-pressed={config.alerts?.onFeedLoss!==false} className={'toggle '+((config.alerts?.onFeedLoss??true)?'enabled':'')} disabled={!canControl} onClick={()=>setConfig({...config,alerts:{...(config.alerts??{webhook:'',onFeedLoss:true}),onFeedLoss:!(config.alerts?.onFeedLoss??true)}})}><i/></button></label>
  </div>
  <div className="automation-actions">
   <button type="button" className="mini-button" disabled={!canControl||busy} onClick={addRule}><Plus size={13}/>Add rule</button>
   <button type="button" className="button primary" disabled={!canControl||busy} onClick={()=>void save(config)}>{busy?'Saving…':'Save rules'}</button>
   <button type="button" className="mini-button" disabled={!canControl||busy} onClick={()=>void override()}><Pause size={13}/>Pause 60 s</button>
   <button type="button" className="mini-button" disabled={!canControl||busy} onClick={()=>{setConfig(defaultAutomation());onNotice('Defaults restored in the editor — press Save rules to apply them.')}}><RotateCcw size={13}/>Defaults</button>
  </div>
  <div className="automation-preview">
   <div className="panel-heading"><h3><Bot size={15}/>What would happen</h3>
    <select aria-label="Simulate a trigger" value={simulate} onChange={event=>setSimulate(event.target.value as typeof simulate)}>{TRIGGERS.map(trigger=><option key={trigger.id} value={trigger.id}>{trigger.label}</option>)}</select>
   </div>
   {preview.length?<ol className="automation-timeline">{preview.map((action,index)=><li key={index}><span>+{Math.round(action.at/1000)}s</span><b>{action.patch.scene?SCENE_TITLES[action.patch.scene]:'countdown'}</b><small>{action.ruleName}</small></li>)}</ol>:<p className="field-hint">No enabled rule reacts to this trigger. Nothing would change on air.</p>}
  </div>
  <p className="field-hint automation-footnote">{loaded?'Rules are saved to config/automation.json on the host and included in event packages.':''} A manual override lasts {Math.round(MANUAL_SUSPEND_MS/1000)} seconds.</p>
 </section>;
}
function suspendedLabel(until:number|null){return until?new Date(until).toLocaleTimeString():null}
export const automationIcons={armed:Play,idle:Power};
