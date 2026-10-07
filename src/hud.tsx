import React,{useState} from 'react';
import {Shield,Users} from 'lucide-react';
import type {MatchState,PlayerState} from '../server/state';
import type {KillEvent,RoundEvent} from '../server/events';
import {configSides,type ResolvedSides} from '../server/sides';
import {seriesState,type SeriesState} from '../server/series';
import {elementStyle,type LayoutConfig,type LayoutElement,type LayoutKey} from '../server/layout';
import {getWidget,overlayThemeStyle,widgetStyle,type OverlayConfig} from '../server/overlay';
import {CustomOverlays,widgetVisible} from './custom-overlays';
import {phaseView} from './phases';
import {formatClock,interpolatedClock} from './clock';
import {weaponInfo,activeWeapon,utilityOf,teamUtility,type Utility} from './weapons';
import {WeaponIcon,UtilityIcon} from './icons';
import {calibrationFor,radarPoints,type RadarConfig,type GrenadeKind} from './radar';
import {buildRoster,identify,shownName,cardOf} from '../server/players';
import {assetUrl} from './assets';
import {SceneStage} from './stage';
import type {Controls,SceneId} from '../server/controls';
import {demo} from './demo';
// The overlay renderer itself, shared by the two things that draw it: the operator panel's live
// preview (and, through /obs and /game, the broadcast output) and the public product page, which
// shows the very same markup instead of an artist's impression of it. One renderer means the
// landing page cannot drift from the product — a layer added here appears on both at once.
// Team identity on the HUD: the uploaded logo when the admin configured one, otherwise the two-bar
// placeholder mark. Logos are plain <img> so any png/jpeg/webp/svg the host serves just works.
export function Mark({other=false,logo,color}:{other?:boolean;logo?:string;color?:string}){
 if(logo) return <span className="team-mark has-logo"><img src={logo.startsWith('uploads/')?'/'+logo:logo} alt=""/></span>;
 return <span className={'team-mark '+(other?'other':'')} style={color?{['--team']:color} as any:undefined}>{other?<><i/><i/><i/></>:<><i/><i/></>}</span>;
}
function UtilityRow({utility,compact=false}:{utility:Utility;compact?:boolean}){const items:(['he'|'flash'|'smoke'|'fire'|'decoy'|'taser',number])[]=[['he',utility.he],['flash',utility.flash],['smoke',utility.smoke],['fire',utility.fire],['decoy',utility.decoy],['taser',utility.taser]];return <span className={'utility'+(compact?' compact':'')}>{utility.defusekit&&<i title="Defuse kit"><UtilityIcon kind="defusekit"/></i>}{items.filter(([,count])=>count>0).map(([kind,count])=><i key={kind} title={kind.toUpperCase()}><UtilityIcon kind={kind}/>{count>1&&<b>{count}</b>}</i>)}</span>}
function Strip({p,name,observed}:{p:PlayerState;name:string;observed:boolean}){const health=p.state?.health||0;const weapon=activeWeapon(p);return <div className={'player '+(!health?'dead ':'')+(observed?'observed':'')}><div className="player-line"><span className="slot">{p.observer_slot??'–'}</span><b>{name}</b><span className="hp">{health?health:'×'}</span></div><div className="player-meta"><span>${(p.state?.money||0).toLocaleString()}</span><Shield size={10}/><span>{p.match_stats?.kills||0} / {p.match_stats?.deaths||0}</span>{health>0&&<span className="player-weapon" title={weapon?.name}><WeaponIcon name={weapon?.name} kind={weapon?.kind}/>{weapon?.label||'—'}</span>}<UtilityRow utility={utilityOf(p)}/></div><div className="health" style={{width:health+'%',background:health>50?'var(--team)':health>25?'#e6c567':'#eb6b6b'}}/></div>}
// Radar: live GSI positions projected through the operator's calibration. The image is optional —
// without it the grid still shows where everyone is, which is what calibration debugging needs.
// Thrown utility renders as per-type markers from the same projection (see src/radar.ts).
const NADE_LABEL:Record<GrenadeKind,string>={smoke:'Smoke grenade',flash:'Flashbang',he:'HE grenade',fire:'Molotov / incendiary',decoy:'Decoy grenade',unknown:'Grenade'};
function Radar({state,sides,radars,pos,nameOf}:{state:MatchState;sides:ResolvedSides;radars?:RadarConfig;pos?:React.CSSProperties;nameOf?:(player:{steamid?:string;name?:string},side?:string)=>string}){
 const cal=calibrationFor(radars,state.map?.name);
 const [imageOk,setImageOk]=useState(true);
 if(!cal) return null;
 const {dots,bomb,grenades}=radarPoints(state,cal,{colors:{CT:sides.CT.color,T:sides.T.color}});
  return <div className={'radar'+(imageOk&&cal.image?' with-image':'')} style={pos}>
  {imageOk&&cal.image?<img src={'/'+cal.image.replace(/^\//,'')} alt="" onError={()=>setImageOk(false)}/>:<div className="radar-grid"><span>RADAR IMAGE MISSING</span><small>public/{cal.image}</small></div>}
  {dots.map(dot=><i key={dot.steamid} className={'dot'+(dot.side==='CT'?' ct':' t')+(dot.alive?'':' dead')+(dot.observed?' observed':'')} style={{left:dot.u*100+'%',top:dot.v*100+'%',['--team']:dot.color||(dot.side==='CT'?'#d970c2':'#e8c97e')} as any} title={nameOf?nameOf({steamid:dot.steamid,name:dot.name},dot.side):dot.name}>
   {dot.observed&&dot.yaw!==undefined&&<b style={{transform:`rotate(${dot.yaw}deg)`}}/>}
  </i>)}
  {bomb&&<i className={'bomb'+(bomb.planted?' planted':'')} style={{left:bomb.u*100+'%',top:bomb.v*100+'%'}}/>}
  {grenades.map(nade=><i key={nade.id} className={'nade nade-'+nade.kind+(nade.deployed?' deployed':'')} style={{left:nade.u*100+'%',top:nade.v*100+'%'}} title={NADE_LABEL[nade.kind]}/>)}
  <span className="radar-label">{state.map?.name?.replace('de_','').toUpperCase()||'—'}<small>{dots.length} TRACKED{grenades.length>0?` · ${grenades.length} NADE${grenades.length===1?'':'S'}`:''}</small></span>
 </div>;
}
const WEAPON_LABELS:Record<string,string>={weapon_ak47:'AK-47',weapon_m4a1:'M4A4',weapon_m4a1_silencer:'M4A1-S',weapon_awp:'AWP',weapon_deagle:'DEAGLE',weapon_usp_silencer:'USP-S',weapon_glock:'GLOCK',weapon_knife:'KNIFE',weapon_hegrenade:'HE',weapon_flashbang:'FLASH',weapon_smokegrenade:'SMOKE',weapon_molotov:'MOLLY',weapon_incgrenade:'INCENDIARY',weapon_decoy:'DECOY',weapon_ssg08:'SSG 08',weapon_aug:'AUG',weapon_sg556:'SG 553',weapon_famas:'FAMAS',weapon_galilar:'GALIL',weapon_mp9:'MP9',weapon_mp7:'MP7',weapon_mp5sd:'MP5-SD',weapon_ump45:'UMP-45',weapon_p90:'P90',weapon_mac10:'MAC-10',weapon_bizon:'BIZON',weapon_nova:'NOVA',weapon_xm1014:'XM1014',weapon_mag7:'MAG-7',weapon_sawedoff:'SAWED-OFF',weapon_m249:'M249',weapon_negev:'NEGEV',weapon_tec9:'TEC-9',weapon_fiveseven:'FIVE-SEVEN',weapon_cz75a:'CZ75',weapon_p250:'P250',weapon_elite:'DUALIES',weapon_revolver:'R8',weapon_taser:'ZEUS'};
const weaponLabel=(name?:string)=>WEAPON_LABELS[name||'']||weaponInfo(name)?.label||'';
// Killfeed: server-derived kills, newest first, faded out by age. Ages come from the host clock in
// the snapshot, so the entries expire on the same schedule on every output surface.
function Killfeed({events,sides,pos,nameOf}:{events?:{kills?:KillEvent[]};sides:ResolvedSides;pos?:React.CSSProperties;nameOf?:(player:{steamid?:string;name?:string},side?:string)=>string}){
 // Kill events carry the in-game names; the operator's alias (matched by SteamID first) is applied at render time.
 const who=(steamid?:string,name?:string,side?:string)=>nameOf?nameOf({steamid,name},side):name||'';
 const sideColor=(side?:string)=>sides[side==='CT'?'CT':'T']?.color||(side==='CT'?'#d970c2':'#e8c97e');
 const now=Date.now();
 const kills=(events?.kills||[]).filter(kill=>now-kill.at<9000).slice(-5).reverse();
 if(!kills.length) return null;
 return <div className="killfeed" style={pos}>{kills.map(kill=><div className={'kill'+(now-kill.at>7000?' leaving':'')} key={kill.id}>
  <b style={{color:sideColor(kill.killerSide)}}>{who(kill.killer,kill.killerName,kill.killerSide)||'UNKNOWN'}</b>
  <span className="kill-weapon"><WeaponIcon name={kill.weapon} kind={weaponInfo(kill.weapon)?.kind}/>{weaponLabel(kill.weapon)}</span>
  <b style={{color:sideColor(kill.victimSide)}}>{who(kill.victim,kill.victimName,kill.victimSide)}</b>
  {kill.headshot&&<i className="kill-hs" title="Headshot">★</i>}
 </div>)}</div>;
}
export function Hud({state,controls,config,sides:resolved,resolvedSeries,radars,lastSeen,now=Date.now(),clockSkew=0,signal,events,demoMode=false,layout,overlay,arranging=false,onReposition,onLayerReposition}:{state:MatchState;controls:Controls;config:any;clockSkew?:number;sides?:ResolvedSides;resolvedSeries?:SeriesState;radars?:RadarConfig;lastSeen?:number;now?:number;signal:boolean;events?:{kills?:KillEvent[];rounds?:RoundEvent[]};demoMode?:boolean;layout?:LayoutConfig;overlay?:OverlayConfig;arranging?:boolean;onReposition?:(key:LayoutKey,pos:LayoutElement)=>void;onLayerReposition?:(id:string,x:number,y:number)=>void}){
// The current visual layer starts from its carefully tuned CSS anchor and accepts a saved position override.
const styleOf=(key:LayoutKey)=>{const item=getWidget(overlay,key);return (item?widgetStyle(item,elementStyle(layout,key)):elementStyle(layout,key)) as React.CSSProperties|undefined};
const widgetStyleOf=(id:string)=>{const item=getWidget(overlay,id);return item?widgetStyle(item) as React.CSSProperties:undefined};
const layerVisible=(id:string,scene:SceneId='live')=>widgetVisible(overlay,id,scene);
// Drag-to-reposition, used by the admin's Arrange mode. Everything is measured against the .hud
// box and divided by its rendered scale, so the same math works in the scaled admin preview and
// on the full-size output canvas. Elements stay within a visible strip of the canvas so nothing
// can ever be dragged fully out of reach behind the overflow clip.
const startDrag=(key:LayoutKey,e:React.PointerEvent<HTMLElement>)=>{
 if(!onReposition) return;
 e.preventDefault();
 const hud=e.currentTarget.closest('.hud');
 if(!hud) return;
 const frame=hud.getBoundingClientRect(),scale=frame.width/1920||1;
 const rect=e.currentTarget.getBoundingClientRect();
 const from={x:(rect.left-frame.left)/scale,y:(rect.top-frame.top)/scale,w:rect.width/scale,mx:e.clientX,my:e.clientY};
 const move=(event:PointerEvent)=>{
  const x=Math.round(from.x+(event.clientX-from.mx)/scale);
  const y=Math.round(from.y+(event.clientY-from.my)/scale);
  onReposition(key,{x:Math.max(-20,Math.min(1880,x)),y:Math.max(-20,Math.min(1050,y)),w:Math.round(from.w)});
 };
 const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop)};
 window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);
};
// Arrange-mode handles: one dashed ghost per movable element, reusing the element's own class so
// the ghost sits exactly where that element would render (CSS default or saved position). The
// ghosts render last, above everything, and are the only pointer-active layer while arranging.
const GHOSTS:[LayoutKey,string,string][]=[['event','hud-event','EVENT HEADER'],['scoreboard','scoreboard','SCOREBOARD'],['radar','radar','RADAR'],['killfeed','killfeed','KILLFEED'],['rosterLeft','roster roster-0','LEFT ROSTER'],['rosterRight','roster roster-1','RIGHT ROSTER'],['lowerThird','lower-third','LOWER THIRD'],['economy','hud-banner','ECONOMY BAR'],['footer','hud-footer','FOOTER']];
// A scene on air owns the whole canvas. While arranging, the live layout is always drawn so the drag handles sit on real elements.
const sceneOn=controls.scene!=='live'&&!arranging;
const players=Object.values(state.allplayers||{});const sides=resolved||configSides(config);// Who is who: the operator's roster (SteamID first, then name) supplies aliases and portraits. Built from the live draft config, so an alias typed in the panel shows in the preview before it is saved.
const roster=React.useMemo(()=>buildRoster(config),[config]);const sideTeamId=(side?:string)=>sides[side==='CT'?'CT':'T']?.id;const nameOf=(who:{steamid?:string;name?:string},side?:string)=>shownName(roster,who,sideTeamId(side));const series=resolvedSeries||seriesState(state,config);const pips=(side:string)=><small className="pips">{series.pips[side==='CT'?'CT':'T'].map((won:boolean,index:number)=><i key={index} className={won?'on':''}/>)}</small>;const order=(controls.swapped?['T','CT']:['CT','T']) as ('CT'|'T')[];const rosterOrder=order;const team=(side:string)=>sides[side==='CT'?'CT':'T']||{name:side,color:side==='CT'?'#d970c2':'#e8c97e'};const color=(side:string)=>team(side).color||(side==='CT'?'#d970c2':'#e8c97e');const observed=players.find(p=>p.steamid===state.player?.steamid);const activeWeapon=Object.values(observed?.weapons||{}).find(w=>w.state==='active');const clock=interpolatedClock(state,demoMode?now:(lastSeen??0),now);const secs=clock.seconds;const score=(side:string)=>side==='CT'?state.map?.team_ct?.score:state.map?.team_t?.score;const view=demoMode?phaseView(demo):phaseView(state,controls);const lastRound=(events?.rounds||[]).filter(round=>round.map===state.map?.name).pop();const roundJustEnded=!!lastRound&&Date.now()-lastRound.endedAt<15000;
return <div className={'hud '+(demoMode?'demo-hud':'')+(arranging?' arranging':'')} data-treatment={overlay?.theme.treatment||'broadcast'} data-density={overlay?.theme.density||'comfortable'} data-motion={overlay?.theme.motion||'cinematic'} data-grid={String(overlay?.theme.grid!==false)} data-glow={String(overlay?.theme.glow!==false)} style={overlayThemeStyle(overlay?.theme) as React.CSSProperties}>
  {sceneOn?<SceneStage scene={controls.scene} config={config} swapped={controls.swapped} series={series} sides={sides} players={players} nameOf={nameOf} events={events} breakEndsAt={controls.breakEndsAt??null} now={now+clockSkew}/>:<>
 {layerVisible('event')&&<div className="hud-event" style={styleOf('event')}>✳ <b>{config?.event?.name||'SCOUT'}</b><span>{[config?.event?.stage,(series.format||'bo3').toUpperCase()].filter(Boolean).join(' · ')}</span></div>}
 {layerVisible('scoreboard')&&<div className="scoreboard" style={styleOf('scoreboard')}><div className="score-team" style={{['--team']:color(order[0])} as any}><Mark logo={team(order[0]).logo} color={color(order[0])}/><div><b>{team(order[0]).name}</b>{pips(order[0])}</div><strong>{score(order[0])??'–'}</strong></div><div className="clock">{view.clock&&<small>{series.phase==='overtime'?`OVERTIME ${series.otPeriod??1} · ${series.roundsThisHalf}/${series.otPerHalf}`:`ROUND ${series.round} / ${series.regulationRounds}`}</small>}{view.clock&&<b className={clock.source==='bomb'?'bomb-clock':''}>{clock.source==='bomb'?'◉ ':''}{formatClock(secs,clock.source==='bomb'?1:0)}</b>}<span>{clock.defusing?'DEFUSING':state.map?.name?.replace('de_','').toUpperCase()||'WAITING'}</span></div><div className="score-team lime" style={{['--team']:color(order[1])} as any}><strong>{score(order[1])??'–'}</strong><div>{pips(order[1])}<b>{team(order[1]).name}</b></div><Mark other logo={team(order[1]).logo} color={color(order[1])}/></div></div>}
 {!signal&&!demoMode&&layerVisible('signal')&&<div className="signal-lost" style={widgetStyleOf('signal')}>SIGNAL LOST · Waiting for CS2 GSI</div>}
 {view.banner&&layerVisible('phaseBanner')&&<div className={'phase-banner phase-'+view.banner} style={widgetStyleOf('phaseBanner')}>{view.banner==='freezetime'?'FREEZE TIME':view.banner==='round-over'?'ROUND OVER':'TACTICAL PAUSE'}</div>}
 {view.banner==='round-over'&&lastRound&&layerVisible('roundResult')&&<div className="round-result" style={widgetStyleOf('roundResult')}><span>{team(lastRound.winner||'CT').name}</span><b>{lastRound.winnerDetail?(lastRound.winnerDetail==='bomb'?'BOMB':lastRound.winnerDetail==='defuse'?'DEFUSE':(lastRound.winnerDetail as string)):'—'}</b><i>{lastRound.ctScore} : {lastRound.tScore}</i></div>}
 {view.card&&layerVisible('phaseCard')&&<div className={'phase-card phase-card-'+view.card.kind} style={widgetStyleOf('phaseCard')}><h3>{view.card.kind==='warmup'?'WARMUP':view.card.kind==='intermission'?'INTERMISSION':view.card.winner?`${team(view.card.winner).name} WINS THE MAP`:'MAP OVER'}</h3><p>{config?.event?.name||''}{config?.format?` · ${config.format.toUpperCase()}`:''}</p></div>}
 {controls.radar&&layerVisible('radar')&&view.rosters&&<Radar key={state.map?.name||'none'} state={state} sides={sides} radars={radars} pos={styleOf('radar')} nameOf={nameOf}/>}
 {controls.killfeed&&layerVisible('killfeed')&&view.killfeed&&<Killfeed events={events} sides={sides} pos={styleOf('killfeed')} nameOf={nameOf}/>}
 {view.rosters&&rosterOrder.map((side,index)=>{const id=index===0?'rosterLeft':'rosterRight';return layerVisible(id)&&<div className={'roster roster-'+index} key={side} style={styleOf(id)}><div className="roster-label">{team(rosterOrder[index]).name}<span>{rosterOrder[index]}</span></div>{Array.from({length:5},(_,i)=>{const p=players.filter(p=>p.team===side).sort((a,b)=>(a.observer_slot??99)-(b.observer_slot??99))[i];return p?<Strip key={p.steamid} p={p} name={nameOf(p,p.team)} observed={p.steamid===state.player?.steamid}/>:<div className="player empty" key={i}>— Waiting for player</div>})}</div>})}
 {controls.lowerThird&&layerVisible('lowerThird')&&view.lowerThird&&observed&&(()=>{const entry=identify(roster,observed,sideTeamId(observed.team)),card=entry&&cardOf(entry),sub=[card?.realName,card?.role].filter(Boolean).join(' · ');return <div className="lower-third" style={styleOf('lowerThird')}><span className={'avatar'+(card?.photo?' has-photo':'')}>{card?.photo?<img src={assetUrl(card.photo)} alt=""/>:<Users size={23}/>}</span><div><small>OBSERVING · {observed.team||'–'}</small><b>{nameOf(observed,observed.team)}</b>{sub&&<small className="lt-sub">{sub}</small>}</div><WeaponIcon name={activeWeapon?.name} kind={weaponInfo(activeWeapon?.name,activeWeapon?.type)?.kind} size={34}/><span>{activeWeapon?.ammo_clip??'–'} <small>/ {activeWeapon?.ammo_reserve??'–'}</small></span></div>})()}
 {controls.economy&&layerVisible('economy')&&<div className="hud-banner" style={styleOf('economy')}>TEAM ECONOMY · ${players.filter(p=>p.team==='CT').reduce((a,p)=>a+(p.state?.money||0),0).toLocaleString()} / ${players.filter(p=>p.team==='T').reduce((a,p)=>a+(p.state?.money||0),0).toLocaleString()}<UtilityRow utility={teamUtility(state,'CT')} compact/><i>vs</i><UtilityRow utility={teamUtility(state,'T')} compact/></div>}
 {layerVisible('footer')&&<div className="hud-footer" style={styleOf('footer')}><span>SCOUT<span className="tiny-plus">+</span></span><span>{demoMode?'DEMO FEED · NOT LIVE GAME DATA':'EXTERNAL GSI FEED'}</span></div>}
  </>}
 <CustomOverlays config={overlay} scene={controls.scene} context={{event:config?.event?.name||'SCOUT',stage:config?.event?.stage||'',map:state.map?.name?.replace('de_','').toUpperCase()||'WAITING',phase:state.round?.phase||state.map?.phase||'waiting',round:series.round,clock:clock.seconds===null?'—':formatClock(secs,clock.source==='bomb'?1:0),'score.ct':score('CT')??'–','score.t':score('T')??'–','team.ct':team('CT').name,'team.t':team('T').name,'series.ct':series.pips.CT.filter(Boolean).length,'series.t':series.pips.T.filter(Boolean).length}} arranging={arranging} onMove={onLayerReposition}/>
 {arranging&&GHOSTS.filter(([key])=>getWidget(overlay,key)).map(([key,cls,label])=><div key={key} className={cls+' arrange-ghost'} style={styleOf(key)} onPointerDown={event=>startDrag(key,event)}><span className="ghost-tag">{label}</span></div>)}
 </div>}
