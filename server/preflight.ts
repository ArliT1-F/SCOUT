import type {GsiDiagnostics,MatchState} from './state.js';
import type {ResolvedSides} from './sides.js';
import type {RadarsConfig} from './radars.js';
import {calibrationFor} from '../src/radar.js';
import type {ObsStatus} from './obs-config.js';
import type {ScoutConfig} from './config.js';
import type {OverlayConfig} from './overlay.js';
export type CheckState='ready'|'warning'|'blocked'|'skipped';
export interface PreflightCheck {id:string;title:string;state:CheckState;detail:string;required:boolean}
export interface PreflightReport {ready:boolean;score:number;checks:PreflightCheck[];blockers:number;warnings:number}
export function buildPreflight(input:{hostConnected:boolean;lastSeen:number;now:number;gsi?:GsiDiagnostics;state?:MatchState;sides?:ResolvedSides;radars?:RadarsConfig;obs?:ObsStatus;config?:ScoutConfig;overlay?:OverlayConfig}):PreflightReport {
 const {hostConnected,lastSeen,now,gsi,state={},sides,radars,obs,config,overlay}=input;
 const feedAge=lastSeen?Math.max(0,now-lastSeen):Infinity;
 const checks:PreflightCheck[]=[
  {id:'host',title:'Overlay host',state:hostConnected?'ready':'blocked',detail:hostConnected?'The operator panel is connected to the SCOUT host.':'The host is unreachable; no output can receive updates.',required:true},
  {id:'gsi',title:'CS2 observer feed',state:feedAge<5000?'ready':feedAge<30000?'warning':'blocked',detail:feedAge<5000?'Live GSI packets are arriving.':Number.isFinite(feedAge)?`Last accepted packet was ${Math.round(feedAge/1000)} seconds ago.`:'No CS2 packet has been accepted yet.',required:true},
  {id:'observer',title:'Observer data',state:gsi?.allplayersSeen?'ready':gsi?.accepted?'warning':'blocked',detail:gsi?.allplayersSeen?`${Object.keys(state.allplayers||{}).length} live player records are available.`:gsi?.accepted?'Packets arrive, but no allplayers block has confirmed observer/GOTV mode.':'Player rosters and killfeed need a live observer/GOTV feed.',required:true},
  {id:'sides',title:'Team-side binding',state:sides?.confidence==='engaged'||sides?.confidence==='inferred'?'ready':'warning',detail:sides?.confidence==='engaged'?'Live GSI has identified the CT/T teams.':sides?.confidence==='inferred'?'A previously observed CT/T binding is being held.':sides?.confidence==='guess'?'The current CT/T assignment is a fallback guess; verify team names before air.':'No live evidence yet; configured team order will be used.',required:false},
 ];
 const map=state.map?.name;
 const calibration=calibrationFor(radars as any,map);
 checks.push({id:'radar',title:'Map radar',state:!map?'skipped':calibration?'ready':'warning',detail:!map?'Waiting for the current map name.':calibration?`Radar calibration exists for ${map.replace(/^de_/,'')}.`:`No calibrated radar for ${map}; the radar layer should be disabled.`,required:false});
 const obsState=obs?.state;
 checks.push({id:'obs',title:'OBS Studio bridge',state:obsState==='connected'?'ready':obsState==='disabled'?'skipped':'warning',detail:obsState==='connected'?'OBS WebSocket is connected.':obsState==='disabled'?'OBS sync is optional and currently disabled.':obs?.message||'OBS status is not available.',required:false});
 const enabledLayers=overlay?.widgets.filter(widget=>widget.enabled).length||0;
 checks.push({id:'layers',title:'Overlay design',state:enabledLayers?'ready':'blocked',detail:enabledLayers?`${enabledLayers} layers are enabled; theme “${overlay?.theme.name||'SCOUT Broadcast'}”.`:'Every overlay layer is disabled; nothing will render.',required:true});
 checks.push({id:'match',title:'Match configuration',state:config?.teams?.length===2&&config.maps.length?'ready':'warning',detail:config?`${config.teams.length} teams · ${config.maps.length} map card(s) configured.`:'Match configuration is not loaded.',required:false});
 const blockers=checks.filter(check=>check.state==='blocked').length,warnings=checks.filter(check=>check.state==='warning').length;
 const score=Math.round(checks.filter(check=>check.state==='ready').length/checks.length*100);
 return {ready:blockers===0,score,checks,blockers,warnings};
}
