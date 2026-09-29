import React from 'react';
import {Plug,RefreshCw,Send} from 'lucide-react';
import {SCENE_IDS,SCENE_TITLES} from '../server/controls';
import type {ObsConfig,ObsStatus} from '../server/obs-config';
// The operator's view of the optional OBS bridge: connection status, on/off, the SCOUT-scene → OBS-scene map and
// the two actions (test a switch, reload the overlay source). Everything is a draft until "Save OBS settings";
// the connection itself is the host's business (server/obs.ts). The OBS password is never shown or entered here.
const STATE_LABEL:Record<ObsStatus['state'],string>={disabled:'Off',connecting:'Connecting',authenticating:'Signing in',connected:'Connected',error:'Needs attention'};
const SYNC_HELP:Record<ObsConfig['sync'],string>={
 off:'Show OBS status only — SCOUT never changes the OBS scene.',
 scout:'Putting a scene on air in SCOUT switches OBS to the scene mapped to it.',
 both:'As above, and switching to a mapped scene inside OBS puts the matching SCOUT scene on air.',
};
export function ObsPanel({config,status,dirty,busy,onChange,onSave,onReconnect,onTest,onRefresh}:{config:ObsConfig;status:ObsStatus;dirty:boolean;busy:boolean;onChange:(next:ObsConfig)=>void;onSave:()=>void;onReconnect:()=>void;onTest:(scene:string)=>void;onRefresh:()=>void}){
 const connected=status.state==='connected';
 const setMap=(id:typeof SCENE_IDS[number],name:string)=>onChange({...config,sceneMap:{...config.sceneMap,[id]:name}});
 const last=status.lastSwitch;
 return <section className="panel detail-panel obs-panel">
  <div className="editor-head"><h2><Plug size={15}/> OBS Studio <span className={'obs-pill '+status.state}><i/>{STATE_LABEL[status.state]}</span></h2>
   <p>Optional. SCOUT connects <em>out</em> to OBS's built-in WebSocket server (Tools &gt; WebSocket Server Settings; OBS 28 or newer) and can switch OBS's scene along with yours. The overlay works exactly the same with this off. If OBS has a password, set <code>OBS_WS_PASSWORD</code> on the host — it is never entered, stored or shown here.</p></div>
  <p className={'obs-message '+(status.state==='error'?'bad':'')}>{status.message}{status.state!=='disabled'&&<span className="obs-password">{status.passwordSet?' · password: set on the host':' · no password set on the host'}</span>}</p>
  {connected&&<div className="obs-facts">
   {status.obsVersion&&<span>OBS <b>{status.obsVersion}</b></span>}
   {status.currentScene&&<span>On air <b>{status.currentScene}</b></span>}
   <span>Streaming <b>{status.streaming===undefined?'—':status.streaming?'yes':'no'}</b></span>
   <span>Recording <b>{status.recording===undefined?'—':status.recording?'yes':'no'}</b></span>
  </div>}
  {last&&<p className={'obs-last '+(last.ok?'ok':'bad')}>{last.ok?`Switched OBS to “${last.scene}”`:`Could not switch OBS to “${last.scene}”: ${last.error}`}</p>}
  <div className="toggle-row obs-toggle"><div><b>Connect to OBS</b><small>Off by default; nothing is opened until this is on</small></div><button type="button" aria-label="Connect to OBS" aria-pressed={config.enabled} className={'toggle '+(config.enabled?'enabled':'')} onClick={()=>onChange({...config,enabled:!config.enabled})}><i/></button></div>
  <div className="form-grid">
   <label className="field field-wide"><span>OBS WEBSOCKET ADDRESS</span><input value={config.url} maxLength={200} placeholder="ws://127.0.0.1:4455" spellCheck={false} onChange={event=>onChange({...config,url:event.target.value})}/></label>
   <label className="field"><span>SCENE SYNC</span><select value={config.sync} onChange={event=>onChange({...config,sync:event.target.value as ObsConfig['sync']})}><option value="off">Status only</option><option value="scout">SCOUT to OBS</option><option value="both">Both ways</option></select></label>
  </div>
  <p className="obs-help">{SYNC_HELP[config.sync]}</p>
  <div className="section-label map-series-label">OBS SCENE FOR EACH SCOUT SCENE</div>
  <div className="obs-map">{SCENE_IDS.map(id=><div className="obs-map-row" key={id}>
   <span>{SCENE_TITLES[id]}</span>
   <input list="obs-scene-names" value={config.sceneMap[id]} maxLength={200} placeholder="leave OBS alone" aria-label={`OBS scene for ${SCENE_TITLES[id]}`} onChange={event=>setMap(id,event.target.value)}/>
   <button type="button" className="mini-button" disabled={!connected||!config.sceneMap[id]||busy} title="Switch OBS to this scene now" onClick={()=>onTest(config.sceneMap[id])}><Send size={11}/>Test</button>
  </div>)}</div>
  <datalist id="obs-scene-names">{status.scenes.map(name=><option value={name} key={name}/>)}</datalist>
  <div className="form-grid"><label className="field field-wide"><span>OVERLAY BROWSER SOURCE (OPTIONAL)</span><input value={config.browserSource} maxLength={200} placeholder="found automatically by its /obs or /game address" onChange={event=>onChange({...config,browserSource:event.target.value})}/></label></div>
  <div className="obs-actions">
   <button type="button" className="button save-button" disabled={!dirty||busy} onClick={onSave}>{dirty?'Save OBS settings':'OBS settings saved'}</button>
   <button type="button" className="button" disabled={!config.enabled||dirty||busy} title={dirty?'Save first':'Retry the connection now'} onClick={onReconnect}><RefreshCw size={12}/>Reconnect</button>
   <button type="button" className="button" disabled={!connected||busy} title="Reload the overlay browser source inside OBS" onClick={onRefresh}><RefreshCw size={12}/>Refresh overlay in OBS</button>
  </div>
 </section>;
}
