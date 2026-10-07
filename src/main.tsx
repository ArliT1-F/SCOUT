import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Activity,Archive as ArchiveIcon,ArrowUpRight,BarChart3,Check,ChevronDown,ChevronRight,Copy,ExternalLink,Eye,Flag,Gamepad2,GitMerge,Layers,LayoutDashboard,Maximize2,Monitor,MoreHorizontal,Move,Palette,Radio,Save,Settings2,Shield,SlidersHorizontal,Swords,Trophy,Users,Wifi,Zap} from 'lucide-react';
import {motion} from 'framer-motion';
import {feedNextAction,type GsiDiagnostics,type MatchState,type PlayerState} from '../server/state';
import type {KillEvent} from '../server/events';
import {configSides,type ResolvedSides,type ResolvedSide} from '../server/sides';
import {seriesState,type SeriesState} from '../server/series';
import type {ScoutConfig} from '../server/config';
import {TeamEditor,MatchEditor,BracketEditor,BreakEditor,RadarsEditor} from './admin';
import {ObsPanel} from './obs-panel';
import type {ObsConfig,ObsStatus} from '../server/obs-config';
import {elementStyle,type LayoutConfig,type LayoutElement,type LayoutKey} from '../server/layout';
import {defaultOverlay,getWidget,overlayThemeStyle,widgetStyle,type OverlayConfig} from '../server/overlay';
import {OverlayStudio} from './overlay-studio';
import {EventPackPanel,MatchArchivePanel,OperatorConsole,PreflightPanel,ReplayStudio,TouchRemote,type ReplayFrame} from './operator-tools';
import {CustomOverlays,widgetVisible} from './custom-overlays';
import type {RadarsConfig} from '../server/radars';
import {phaseView} from './phases';
import {formatClock,interpolatedClock} from './clock';
import {weaponInfo,activeWeapon,utilityOf,teamUtility,type Utility} from './weapons';
import {WeaponIcon,UtilityIcon} from './icons';
import {calibrationFor,radarPoints,type RadarConfig,type GrenadeKind} from './radar';
import {buildRoster,identify,shownName,cardOf} from '../server/players';
import {assetUrl} from './assets';
import {SceneStage} from './stage';
import {defaultControls,type Controls,type SceneId} from '../server/controls';
import type {RoundEvent} from '../server/events';
import {demo,demoEvents} from './demo';
import {UnlockScreen,SessionPill,apiFetch,setDeniedHandler,forgetToken} from './session';
import {SiteRouter,LauncherLinkCard,BetaApplicationsPanel,isSiteRoute,type SiteRoute} from './site';
import {OperationsPanel} from './ops-panel';
import type {PanelSessionView} from '../server/auth';
import './style.css';
const OUTPUT_ROUTES=['/obs','/game'];
// Trailing slashes are tolerated; Vite/express serve the same SPA document for either form.
const isOutputRoute=OUTPUT_ROUTES.includes(location.pathname.replace(/\/+$/,'')||'/');
// The public product pages (src/site.tsx): landing, application, sign-in and dashboard. They are
// deliberately outside the panel's session gate — an applicant has no authority yet, and a hosted
// deployment has no panel at all — so they are resolved before anything else renders.
const trimmedPath=location.pathname.replace(/\/+$/,'')||'/';
const siteRoute:SiteRoute|null=isSiteRoute(trimmedPath)?trimmedPath:null;
// Opt-in browser-only aid: /obs?checker=1 draws a checkerboard behind the canvas so an operator can
// prove the page is transparent in a normal browser. Never add it to the OBS source URL.
const showChecker=isOutputRoute&&new URLSearchParams(location.search).get('checker')==='1';
// Tag the document transparent *before* the first paint. OBS composites the browser source over the
// game capture, so any html/body background (or one applied only after mount) shows up as black bars
// covering the whole frame. Doing this at module scope guarantees frame one is already transparent.
if(isOutputRoute){document.documentElement.classList.add('output-root');document.body?.classList.add('output-body')}
const initial:Controls=defaultControls;
function useFeed(){const [data,setData]=useState<any>(null),[connected,setConnected]=useState(false);useEffect(()=>{let ws:WebSocket;let retry:ReturnType<typeof setTimeout>;let stopped=false;function connect(){ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);ws.onopen=()=>setConnected(true);ws.onmessage=e=>{try{const message=JSON.parse(e.data);
 // Host time minus this browser's time when the snapshot arrived. Scenes that count toward a host-clock
 // instant (the break timer) apply it, so a browser whose clock is off still agrees with the operator.
 if(message&&typeof message.serverTime==='number') message.clockSkew=message.serverTime-Date.now();setData(message)}catch{}};ws.onclose=()=>{setConnected(false);if(!stopped)retry=setTimeout(connect,1500)}}connect();return()=>{stopped=true;clearTimeout(retry);ws?.close()}},[]);return {data,connected}}
// Team identity on the HUD: the uploaded logo when the admin configured one, otherwise the two-bar
// placeholder mark. Logos are plain <img> so any png/jpeg/webp/svg the host serves just works.
function Mark({other=false,logo,color}:{other?:boolean;logo?:string;color?:string}){
 if(logo) return <span className="team-mark has-logo"><img src={logo.startsWith('uploads/')?'/'+logo:logo} alt=""/></span>;
 return <span className={'team-mark '+(other?'other':'')} style={color?{['--team']:color} as any:undefined}>{other?<><i/><i/><i/></>:<><i/><i/></>}</span>;
}
function UtilityRow({utility,compact=false}:{utility:Utility;compact?:boolean}){const items:(['he'|'flash'|'smoke'|'fire'|'decoy'|'taser',number])[]=[['he',utility.he],['flash',utility.flash],['smoke',utility.smoke],['fire',utility.fire],['decoy',utility.decoy],['taser',utility.taser]];return <span className={'utility'+(compact?' compact':'')}>{utility.defusekit&&<i title="Defuse kit"><UtilityIcon kind="defusekit"/></i>}{items.filter(([,count])=>count>0).map(([kind,count])=><i key={kind} title={kind.toUpperCase()}><UtilityIcon kind={kind}/>{count>1&&<b>{count}</b>}</i>)}</span>}
function Strip({p,name,observed}:{p:PlayerState;name:string;observed:boolean}){const health=p.state?.health||0;const weapon=activeWeapon(p);return <div className={'player '+(!health?'dead ':'')+(observed?'observed':'')}><div className="player-line"><span className="slot">{p.observer_slot??'–'}</span><b>{name}</b><span className="hp">{health?health:'×'}</span></div><div className="player-meta"><span>${(p.state?.money||0).toLocaleString()}</span><Shield size={10}/><span>{p.match_stats?.kills||0} / {p.match_stats?.deaths||0}</span>{health>0&&<span className="player-weapon" title={weapon?.name}><WeaponIcon name={weapon?.name} kind={weapon?.kind}/>{weapon?.label||'—'}</span>}<UtilityRow utility={utilityOf(p)}/></div><div className="health" style={{width:health+'%',background:health>50?'var(--team)':health>25?'#e6c567':'#eb6b6b'}}/></div>}
// The single panel that answers "why is nothing showing?": CS2 never sent, every packet 401'd,
// packets rejected on shape, or CS2 playing instead of spectating. Diagnostics never carry the token.
function FeedPanel({gsi,now,connected}:{gsi?:GsiDiagnostics;now:number;connected:boolean}){
 const age=gsi?.lastPacketAt?now-gsi.lastPacketAt:null;
 const ageLabel=!gsi?.lastPacketAt?'never':age!<1500?'just now':age!<60000?`${Math.round(age!/1000)}s ago`:`${Math.round(age!/60000)}m ago`;
 const state_=!connected?'offline':gsi?.accepted&&age!==null&&age<5000?'receiving':gsi?.accepted?'stale':'waiting';
 return <section className="panel feed-panel">
  <div className="panel-heading"><h2>CS2 feed <span className={'feed-state '+state_}>{connected?state_.toUpperCase():'HOST OFFLINE'}</span></h2><span className="feed-uri">{gsi?.uri||'http://127.0.0.1:8080/gsi'}</span></div>
  <div className="feed-body">
   <div className="feed-counters">{[{v:gsi?.accepted??0,l:'ACCEPTED',cls:'ok'},{v:gsi?.rejectedAuth??0,l:'TOKEN-REJECTED',cls:(gsi?.rejectedAuth?'bad':'')},{v:gsi?.rejectedShape??0,l:'SHAPE-REJECTED',cls:(gsi?.rejectedShape?'warn':'')},{v:gsi?.rejectedLate??0,l:'STALE-IGNORED',cls:(gsi?.rejectedLate?'warn':'')},{v:ageLabel,l:'LAST PACKET',cls:''}].map(({v,l,cls})=><div className={'feed-counter '+cls} key={l}><b>{v}</b><small>{l}</small></div>)}</div>
   <div className="feed-blocks">{gsi&&Object.keys(gsi.blocks).length?Object.entries(gsi.blocks).map(([name,size])=><span className={'block-chip '+(name==='allplayers'?'hot':'')} key={name}>{name} ×{size}</span>):<span className="block-chip empty">no blocks yet</span>}</div>
   <div className="feed-meta"><span>PROVIDER <b>{gsi?.provider||'—'}</b></span><span>PORT <b>{gsi?.port??'—'}</b></span><span>TOKEN SOURCE <b>{gsi?.tokenSource??'—'}</b></span><span>SUBTREE ISSUES <b>{gsi?.subtreeIssues??0}</b></span></div>
   <p className={'feed-hint '+(state_==='receiving'?'good':'')}>{feedNextAction(gsi)}</p>
  </div></section>;
}
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
const radarDesc=(calibration:any,map?:string)=>calibration?`Live positions · ${map?.replace('de_','').toUpperCase()}`:`No calibration for ${map||'the current map'}`;
const seriesFormat=(series?:SeriesState,config?:any)=>(series?.format||seriesState({},config).format).toUpperCase();
const WEAPON_LABELS:Record<string,string>={weapon_ak47:'AK-47',weapon_m4a1:'M4A4',weapon_m4a1_silencer:'M4A1-S',weapon_awp:'AWP',weapon_deagle:'DEAGLE',weapon_usp_silencer:'USP-S',weapon_glock:'GLOCK',weapon_knife:'KNIFE',weapon_hegrenade:'HE',weapon_flashbang:'FLASH',weapon_smokegrenade:'SMOKE',weapon_molotov:'MOLLY',weapon_incgrenade:'INCENDIARY',weapon_decoy:'DECOY',weapon_ssg08:'SSG 08',weapon_aug:'AUG',weapon_sg556:'SG 553',weapon_famas:'FAMAS',weapon_galilar:'GALIL',weapon_mp9:'MP9',weapon_mp7:'MP7',weapon_mp5sd:'MP5-SD',weapon_ump45:'UMP-45',weapon_p90:'P90',weapon_mac10:'MAC-10',weapon_bizon:'BIZON',weapon_nova:'NOVA',weapon_xm1014:'XM1014',weapon_mag7:'MAG-7',weapon_sawedoff:'SAWED-OFF',weapon_m249:'M249',weapon_negev:'NEGEV',weapon_tec9:'TEC-9',weapon_fiveseven:'FIVE-SEVEN',weapon_cz75a:'CZ75',weapon_p250:'P250',weapon_elite:'DUALIES',weapon_revolver:'R8',weapon_taser:'ZEUS'};
const weaponLabel=(name?:string)=>WEAPON_LABELS[name||'']||weaponInfo(name)?.label||'';
// A bracket slot shows its bound team's name, else the seed label the admin typed (e.g. "Winner SF1").
const demoKills=(now:number)=>({kills:demoEvents.kills.map((kill,index)=>({...kill,at:now-index*2400}))});
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
function Hud({state,controls,config,sides:resolved,resolvedSeries,radars,lastSeen,now=Date.now(),clockSkew=0,signal,events,demoMode=false,layout,overlay,arranging=false,onReposition,onLayerReposition}:{state:MatchState;controls:Controls;config:any;clockSkew?:number;sides?:ResolvedSides;resolvedSeries?:SeriesState;radars?:RadarConfig;lastSeen?:number;now?:number;signal:boolean;events?:{kills?:KillEvent[];rounds?:RoundEvent[]};demoMode?:boolean;layout?:LayoutConfig;overlay?:OverlayConfig;arranging?:boolean;onReposition?:(key:LayoutKey,pos:LayoutElement)=>void;onLayerReposition?:(id:string,x:number,y:number)=>void}){
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
const sceneList:{id:SceneId;title:string;desc:string;icon:any}[]=[{id:'live',title:'Live game',desc:'In-game spectator HUD',icon:Gamepad2},{id:'matchup',title:'Matchup',desc:'Team vs. team introduction',icon:Swords},{id:'lineups',title:'Lineups',desc:'Meet the starting five',icon:Users},{id:'veto',title:'Map series',desc:'Picks, bans & map scores',icon:Layers},{id:'bracket',title:'Tournament tree',desc:'The road to the trophy',icon:GitMerge},{id:'winner',title:'Winner',desc:'The victory moment',icon:Trophy},{id:'break',title:'Break',desc:'A moment between the action',icon:Monitor},{id:'recap',title:'Round recap',desc:'Confirmed round result and key eliminations',icon:Flag},{id:'stats',title:'Player stats',desc:'Live K / D / A and MVP comparison',icon:BarChart3}];
// Overlay a draft team's name/colour/logo onto server-resolved sides, so the preview shows panel
// edits instantly without losing the GSI-derived CT/T binding.
const restyleSides=(sides:ResolvedSides|undefined,config?:any):ResolvedSides|undefined=>{
 if(!sides||!config?.teams) return sides;
 const restyle=(side:ResolvedSide):ResolvedSide=>{const team=(config.teams||[]).find((candidate:any)=>candidate.id===side.id);return team?{...side,name:team.name,tag:team.tag,color:team.color||side.color,logo:team.logo||undefined}:side};
 return {...sides,CT:restyle(sides.CT),T:restyle(sides.T)};
};
// The preview renders the real 1920×1080 HUD inside a card whose width changes with the window, the
// sidebar and the "expand" toggle, so the scale must follow the measured stage width. A hard-coded
// scale left the HUD as a small corner thumbnail whenever the stage was wider than one preset size.
const PreviewScale=React.createContext(0.353);
function PreviewStage({children}:{children:React.ReactNode}){
 const ref=React.useRef<HTMLDivElement>(null);
 const [scale,setScale]=useState(0.353);
 React.useLayoutEffect(()=>{
  const node=ref.current;if(!node) return;
  const measure=()=>{const width=node.clientWidth;if(width>0) setScale(width/1920)};
  measure();
  if(typeof ResizeObserver==='undefined'){addEventListener('resize',measure);return()=>removeEventListener('resize',measure)}
  const observer=new ResizeObserver(measure);observer.observe(node);
  return()=>observer.disconnect();
 },[]);
 return <PreviewScale.Provider value={scale}><div className="preview-stage" ref={ref}>{children}</div></PreviewScale.Provider>;
}
function PreviewHud({children}:{children:React.ReactNode}){
 const scale=React.useContext(PreviewScale);
 return <div className="preview-hud" style={{['--preview-scale' as any]:scale}}>{children}</div>;
}
function PermissionNotice({title,description}:{title:string;description:string}){return <section className="panel permission-notice"><Shield size={19}/><div><b>{title}</b><p>{description}</p></div></section>}
function App(){const {data,connected}=useFeed();const [tab,setTab]=useState('Overview');const [demoMode,setDemoMode]=useState(true);const [controls,setControls]=useState<Controls>(initial);const [notice,setNotice]=useState('');const [now,setNow]=useState(Date.now());const [expanded,setExpanded]=useState(false);const [draft,setDraft]=useState<ScoutConfig|null>(null);const [arranging,setArranging]=useState(false);const [layoutDraft,setLayoutDraft]=useState<LayoutConfig|null>(null);const [overlayDraft,setOverlayDraft]=useState<OverlayConfig|null>(null);const [overlayBusy,setOverlayBusy]=useState(false);const [replayFrame,setReplayFrame]=useState<ReplayFrame|null>(null);const [radarsDraft,setRadarsDraft]=useState<RadarsConfig|null>(null);const [obsDraft,setObsDraft]=useState<ObsConfig|null>(null);const [obsBusy,setObsBusy]=useState(false);
// The host answers every WebSocket connection with the session that connection has, so the panel knows
// whether it is local, remote or locked without asking. A denial from any mutation refreshes it: the
// session may have expired or the token may have changed under this browser.
const [session,setSession]=useState<PanelSessionView|null>(null);const [denied,setDenied]=useState('');
useEffect(()=>{if(data?.session)setSession(data.session)},[data?.session]);
async function refreshSession(){try{const res=await apiFetch('/api/session');if(res.ok)setSession(await res.json())}catch{}}
useEffect(()=>{setDeniedHandler((message)=>{setDenied(message);setSession(current=>current&&{...current,authenticated:false,via:null});void refreshSession()});return()=>setDeniedHandler(null)},[]);
useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),100);return()=>clearInterval(id)},[]);useEffect(()=>{if(data?.controls)setControls(data.controls)},[data?.controls]);const signal=connected&&!!data?.lastSeen&&(now-data.lastSeen<5000);
// The panel edits a draft copy of config/teams.json; saving PUTs it to the host, which normalizes,
// persists and broadcasts it to every output view.
const config:any=draft||data?.config;
const dirty=!!draft&&JSON.stringify(draft)!==JSON.stringify(data?.config??null);
// Arrange mode edits a local draft of config/layout.json; the outputs only move when the operator
// saves, so nothing jumps on air mid-tweak. Custom radars work the same way, except uploads are
// already on disk — the draft calibrations preview live and reach the outputs on save.
const layout:LayoutConfig=layoutDraft||data?.layout||{elements:{}};
const layoutDirty=JSON.stringify(layout)!==JSON.stringify(data?.layout||{elements:{}});
const overlay:OverlayConfig=overlayDraft||data?.overlay||defaultOverlay();
const overlayDirty=!!overlayDraft&&JSON.stringify(overlayDraft)!==JSON.stringify(data?.overlay??null);
const radars:RadarsConfig=radarsDraft||data?.radars||{maps:{}};
const radarsDirty=!!radarsDraft&&JSON.stringify(radarsDraft)!==JSON.stringify(data?.radars??null);
const canControl=session?.capabilities?.includes('control')||false;
const canEditMatch=session?.capabilities?.includes('match-edit')||false;
const canDesign=session?.capabilities?.includes('design')||false;
const isOwner=session?.role==='owner';
const currentLease=data?.lease?{...data.lease,mine:data.lease.principalId===session?.principalId}:null;
const canDrive=canControl&&(!currentLease?.holder||currentLease.mine);
const setPreviewReplay=React.useCallback((frame:ReplayFrame|null)=>{setReplayFrame(frame);if(frame)setDemoMode(false)},[]);
function flash(message:string){setNotice(message);setTimeout(()=>setNotice(''),3500)}
// The optional OBS bridge. The host owns the connection; the panel edits a draft of the settings and asks for actions.
const obsSaved:ObsConfig|undefined=data?.obs?.config, obsStatus:ObsStatus|undefined=data?.obs?.status;
const obsView=obsDraft||obsSaved;
const obsDirty=!!obsDraft&&JSON.stringify(obsDraft)!==JSON.stringify(obsSaved??null);
async function obsCall(path:string,init:RequestInit,done:string){
 setObsBusy(true);
 try{const res=await apiFetch(path,init);const body=await res.json().catch(()=>({}));if(!res.ok) throw Error(body.error||'The OBS request failed');flash(done);return body}
 catch(reason:any){flash(reason.message||'The OBS request failed');return undefined}
 finally{setObsBusy(false)}
}
const jsonInit=(method:string,body?:unknown):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
async function saveObs(){if(!obsDraft) return;if(await obsCall('/api/obs',jsonInit('PUT',obsDraft),'OBS settings saved')) setObsDraft(null)}
async function saveConfig(){
 try{
  const res=await apiFetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw Error(body.error||'Save failed');
  setDraft(null);flash('Configuration saved to all outputs');
 }catch(reason:any){flash(reason.message||'Unable to save. Check the host connection.')}
}
async function logout(){try{await apiFetch('/api/session',{method:'DELETE'})}catch{}forgetToken();setDenied('');setSession(current=>current&&{...current,authenticated:false,via:null,local:false});flash('Signed out of the panel')}
function reposition(key:LayoutKey,pos:LayoutElement){setLayoutDraft(prev=>{const base=prev||data?.layout||{elements:{}};return {...base,elements:{...base.elements,[key]:pos}}})}
async function saveLayout(){
 if(!layoutDraft) return;
 try{
  const res=await apiFetch('/api/layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(layoutDraft)});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw Error(body.error||'Save failed');
  setLayoutDraft(null);flash('Legacy position layout saved to all outputs');
 }catch(reason:any){flash(reason.message||'Unable to save the layout. Check the host connection.')}
}
function repositionLayer(id:string,x:number,y:number){setOverlayDraft(previous=>{const base:OverlayConfig=previous||data?.overlay||defaultOverlay();return {...base,widgets:base.widgets.map(widget=>widget.id===id?{...widget,x,y}:widget)}})}
async function saveOverlay(){if(!overlayDraft)return;setOverlayBusy(true);try{const res=await apiFetch('/api/overlay',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(overlayDraft)});const body=await res.json().catch(()=>({}));if(!res.ok)throw Error(body.error||'Overlay publish failed');setOverlayDraft(null);flash('Overlay design published to /obs and every connected output')}catch(reason:any){flash(reason.message||'Unable to publish overlay design. Check permissions and host connection.')}finally{setOverlayBusy(false)}}
async function saveRadars(){

 try{
  const res=await apiFetch('/api/radars',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(radars)});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw Error(body.error||'Save failed');
  setRadarsDraft(null);flash('Radar configuration saved to all outputs');
 }catch(reason:any){flash(reason.message||'Unable to save the radar configuration. Check the host connection.')}
}
async function update(patch:Partial<Controls>){try{const res=await apiFetch('/api/controls',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...controls,...patch})});const body=await res.json().catch(()=>({}) as any);if(!res.ok)throw Error(body.error||'Unable to save. Check the host connection.');setControls(body);setNotice('Broadcast settings saved')}catch(reason:any){setNotice(reason.message||'Unable to save. Check the host connection.')}setTimeout(()=>setNotice(''),3500)}
async function claimControl(force=false){try{const res=await apiFetch('/api/lease',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force})});const body=await res.json().catch(()=>({}) as any);if(!res.ok){flash(body.error||'Could not claim broadcast control');return}flash(force?'Control handed over to you':'Broadcast control lease acquired')}catch(reason:any){flash(reason.message||'Could not reach the host to claim broadcast control')}}
async function releaseControl(){try{const res=await apiFetch('/api/lease',{method:'DELETE'});const body=await res.json().catch(()=>({}) as any);if(!res.ok){flash(body.error||'Could not release broadcast control');return}flash('Broadcast control released')}catch(reason:any){flash(reason.message||'Could not reach the host to release broadcast control')}}
async function setRecording(enabled:boolean){const res=await apiFetch('/api/recordings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});const body=await res.json().catch(()=>({}) as any);if(!res.ok)throw Error(body.error||'Could not change recording state');flash(enabled?'GSI recording started':'GSI recording stopped')}
function packImported(){setDraft(null);setLayoutDraft(null);setOverlayDraft(null);setRadarsDraft(null);setObsDraft(null);setDemoMode(false);setReplayFrame(null);flash('Event package applied; live preview is using the imported event data')}
const previewReplay=!demoMode&&!!replayFrame;
const state=demoMode?demo:previewReplay?replayFrame!.state:(signal?data?.state||{}:{});
const events=demoMode?demoKills(now):previewReplay?replayFrame!.events:data?.events;const sides=configSides(config);
// The panel itself is behind the host's session. The output routes above are not: an OBS browser source
// on another machine has no token and must keep loading /obs and its feed.
if(siteRoute)return <SiteRouter route={siteRoute}/>;
if(isOutputRoute)return <Output state={data?.state||{}} controls={data?.controls||initial} config={data?.config} sides={data?.sides} resolvedSeries={data?.series} radars={data?.radars} layout={data?.layout} overlay={data?.overlay} lastSeen={data?.lastSeen} now={now} clockSkew={data?.clockSkew||0} signal={signal} events={{kills:(data?.events?.kills||[]).filter((kill:KillEvent)=>now-kill.at<9000),rounds:data?.events?.rounds||[]}}/>;
if(session&&!session.authenticated&&!session.local) return <UnlockScreen session={session} message={denied} onUnlocked={()=>{setDenied('');void refreshSession()}}/>;
if(new URLSearchParams(location.search).get('remote')==='1')return <TouchRemote controls={controls} hostConnected={connected} lease={currentLease} canControl={canControl} canTakeover={isOwner} onAction={patch=>void update(patch)} onClaim={claimControl} onRelease={releaseControl} onNotice={flash}/>;
return <div className="app"><aside className="sidebar"><a className="brand" href="/"><span className="brand-symbol">✳</span> scout<span className="brand-dot">®</span></a><div className="workspace"><span className="workspace-icon">{(config?.event?.name||'S').charAt(0).toUpperCase()}</span><div>{config?.event?.name||'Tournament workspace'}<small>Tournament workspace</small></div><ChevronDown size={15}/></div><div className="nav-label">WORKSPACE</div><nav>{[{name:'Overview',icon:LayoutDashboard},{name:'Match setup',icon:Swords},{name:'Teams & players',icon:Users},{name:'Tournament tree',icon:GitMerge},{name:'Broadcast scenes',icon:Layers},{name:'Overlay Studio',icon:Palette},{name:'Map radars',icon:SlidersHorizontal},{name:'Replay Studio',icon:Radio},{name:'Session archive',icon:ArchiveIcon},{name:'Event packages',icon:Layers},{name:'Operators & audit',icon:Users},{name:'Beta applications',icon:Shield},{name:'Operations',icon:Activity}].filter(item=>(item.name!=='Operators & audit'&&item.name!=='Beta applications'&&item.name!=='Operations')||isOwner).map(({name,icon:Icon})=><button key={name} className={tab===name?'active':''} onClick={()=>setTab(name)}><Icon size={18}/>{name}{name==='Overview'&&<span className="nav-active-dot"/>}</button>)}</nav><div className="sidebar-bottom"><LauncherLinkCard/><div className="host-card"><span className={'status-dot '+(connected?'':'off')}/><b>{connected?'Overlay host online':'Host reconnecting'}</b><small>PORT 8080 <span>v0.1.0</span></small></div><button className="settings-link" onClick={()=>setTab('Setup guide')}><Settings2 size={18}/>Setup guide<ArrowUpRight size={15}/></button><div className="operator"><span>OP</span><div>Observer station<small>Local operator</small></div><MoreHorizontal size={18}/></div></div></aside>
 <main><header><div className="breadcrumb">Workspace <ChevronRight size={13}/> <span>{tab}</span></div><div className="header-right"><SessionPill session={session} onLogout={logout}/><span className="header-separator"/><span className="help" onClick={()=>setTab('Setup guide')}>?</span></div></header><div className="content"><div className="page-title"><div><div className="eyebrow">YOUR BROADCAST, UNDER CONTROL</div><h1>{tab==='Overview'?'Broadcast overview':tab}</h1><p>Every round. Every detail. Ready for the big stage.</p></div><div className="title-actions">{(dirty||overlayDirty)&&<span className="unsaved-pill">UNSAVED CHANGES</span>}<button className="button save-button" disabled={!dirty||!canEditMatch} onClick={saveConfig}><Save size={15}/>Save configuration</button><a className="button primary" href="/obs" target="_blank">Open broadcast <ArrowUpRight size={16}/></a></div></div>
 <div className="status-cards"><div className="metric"><span className="metric-icon green"><Radio size={20}/></span><div><small>GSI CONNECTION</small><b>{signal?'Receiving live data':'Waiting for CS2'}<span className={'status-dot '+(signal?'':'amber')}/></b><p>{signal?'Observer feed connected':'Demo available in preview'}</p></div><Activity className="metric-end" size={23}/></div><div className="metric"><span className="metric-icon purple-bg"><Swords size={20}/></span><div><small>CURRENT MATCH</small><b>{sides.CT.name} <span className="muted">vs</span> {sides.T.name}</b><p>{config?.event?.stage||'Exhibition'} <span>·</span> {(config?.format||'bo3').toUpperCase().replace('BO','Best of ')}</p></div></div><div className="metric"><span className="metric-icon gold"><Layers size={20}/></span><div><small>ACTIVE SCENE</small><b>{sceneList.find(s=>s.id===controls.scene)?.title}</b><p>{controls.scene==='live'?'In-game spectator HUD':'Full-screen broadcast graphic'}</p></div><span className="on-air">OUTPUT</span></div></div>
 {tab==='Overview'&&canControl&&<section className={'control-lease-card'+(currentLease?.mine?' mine':'')}><div className="lease-mark"><Shield size={16}/></div><div><small>LIVE CONTROL LEASE</small><b>{currentLease?.holder?currentLease.mine?`You are in control · ${session?.operator||'operator'}`:`${currentLease.holder} is in control`:'Available · no producer owns the lease'}</b><span>{currentLease?.expiresAt?`Automatic release at ${new Date(currentLease.expiresAt).toLocaleTimeString()} unless renewed by an action.`:'A renewable 45-second lease prevents conflicting scene changes.'}</span></div>{currentLease?.mine?<button className="button" onClick={()=>void releaseControl()}>Release control</button>:currentLease?.holder&&isOwner?<button className="button danger-button" onClick={()=>void claimControl(true)}>Owner takeover</button>:!currentLease?.holder?<button className="button primary" onClick={()=>void claimControl(false)}>Take control</button>:<span className="lease-held">CONTROL IN USE</span>}</section>}
 {(tab==='Overview'||tab==='Setup guide')&&<FeedPanel gsi={data?.gsi} now={now} connected={connected}/>}
 {tab==='Overview'&&<PreflightPanel hostConnected={connected} lastSeen={data?.lastSeen||0} now={now} gsi={data?.gsi} state={data?.state} sides={data?.sides} radars={radars} obs={obsStatus} config={data?.config} overlay={overlay}/>}
 {(tab==='Overview'||tab==='Map radars'||tab==='Overlay Studio'||tab==='Replay Studio')&&<div className={'middle-grid '+(expanded?'expanded':'')}><section className="panel preview-panel"><div className="panel-heading"><h2>Overlay preview <span className="preview-pill">{demoMode?'DEMO':previewReplay?'REPLAY':'LIVE'}</span></h2><div><button title="Switch preview source" className="text-button" onClick={()=>{if(demoMode){setDemoMode(false);setReplayFrame(null)}else if(previewReplay)setReplayFrame(null);else setDemoMode(true)}}><span className={'status-dot '+(demoMode?'amber':previewReplay?'':'')}/>{demoMode?'Demo feed':previewReplay?'Replay preview':'GSI feed'}</button><button className={'icon-button'+(arranging?' active':'')} title="Arrange overlay elements" aria-pressed={arranging} onClick={()=>canDesign&&setArranging(!arranging)} disabled={!canDesign} aria-label="Arrange all overlay layers"><Move size={15}/></button><button className="icon-button" title="Expand preview" onClick={()=>setExpanded(!expanded)}><Maximize2 size={15}/></button></div></div><div className="preview-wrap"><PreviewStage><div className="map-backdrop"><div className="building one"/><div className="building two"/><div className="archway"/><div className="pavement"/></div><PreviewHud><Hud state={state} controls={controls} config={config} sides={demoMode?undefined:previewReplay?configSides(config):restyleSides(data?.sides,config)} resolvedSeries={demoMode?undefined:seriesState(state,config||{})} radars={radars} lastSeen={previewReplay?replayFrame?.at:data?.lastSeen} now={previewReplay&&replayFrame?replayFrame.at:now} clockSkew={previewReplay?0:data?.clockSkew||0} signal={previewReplay?true:signal} events={events} demoMode={demoMode} layout={layout} overlay={overlay} arranging={arranging} onReposition={arranging?reposition:undefined} onLayerReposition={arranging?repositionLayer:undefined}/></PreviewHud><span className="preview-watermark">LAYOUT PREVIEW</span></PreviewStage></div>{(arranging||layoutDirty)&&<div className="arrange-bar"><span><b>{arranging?'ARRANGE MODE':'UNSAVED LAYOUT'}</b>{arranging?' Drag the outlined panels on the preview — positions live on the 1920 × 1080 canvas and reach every output on save.':' Layout changes have not been pushed to the outputs yet.'}</span><button className="mini-button" disabled={!canDesign} onClick={()=>setLayoutDraft({elements:{}})}>Reset positions</button><button className="mini-button" disabled={!layoutDirty||!canDesign} onClick={()=>setLayoutDraft(null)}>Discard</button><button className="button primary" disabled={!layoutDirty||!canDesign} onClick={saveLayout}><Save size={13}/>Save layout</button></div>}<div className="preview-bottom"><span><span className="status-dot"/> Shared overlay renderer</span><span>1920 × 1080 <i/> 16:9 <i/> Transparent output</span></div></section><section className="panel quick-controls"><div className="panel-heading"><h2>Quick controls</h2><SlidersHorizontal size={16}/></div><div className="controls-body"><div className="section-label">HUD ELEMENTS</div>{[{key:'radar',label:'Radar',desc:radarDesc(calibrationFor(radars,state.map?.name),state.map?.name),disabled:!calibrationFor(radars,state.map?.name)},{key:'killfeed',label:'Killfeed',desc:'Derived kills & round results'},{key:'lowerThird',label:'Player lower-third',desc:'Observed player details'},{key:'economy',label:'Economy panel',desc:'Team money comparison'}].map(item=><div className={'toggle-row '+(item.disabled?'disabled':'')} key={item.key}><div><b>{item.label}</b><small>{item.desc}</small></div><button disabled={item.disabled||!canDrive} aria-label={'Toggle '+item.label} aria-pressed={controls[item.key as keyof Controls] as boolean} className={'toggle '+(controls[item.key as keyof Controls]?'enabled':'')} onClick={()=>update({[item.key]:!controls[item.key as keyof Controls]})}><i/></button></div>)}<div className="control-divider"/><div className="section-label">MATCH CONTROLS</div><button disabled={!canDrive} className={'control-button '+(controls.techPause?'selected':'')} onClick={()=>update({techPause:!controls.techPause})}><span><span className="pause-icon">Ⅱ</span>Technical pause</span><span>{controls.techPause?'ON':'OFF'}</span></button><button disabled={!canDrive} className="control-button" onClick={()=>update({swapped:!controls.swapped})}><span><span className="swap-icon">⇄</span>Swap team sides</span><ChevronRight size={14}/></button><div className="controls-note"><Shield size={13}/>{canDrive?'Changes sync to all output views':currentLease?.holder?'Another operator holds the control lease':'Claim the control lease to make on-air changes'}</div></div></section></div>}
 {(tab==='Overview'||tab==='Broadcast scenes')&&<section className="scene-section"><div className="section-heading"><h2>Broadcast scenes <span>One click. On air.</span></h2><button className="text-button" onClick={()=>setTab(tab==='Overview'?'Broadcast scenes':'Overview')}>{tab==='Overview'?'View all scenes':'Back to overview'}<ArrowUpRight size={14}/></button></div><div className="scene-grid">{sceneList.map(({id,title,desc,icon:Icon},i)=><button disabled={!canDrive} className={'scene-card '+(controls.scene===id?'chosen':'')} key={id} onClick={()=>update({scene:id})}><div className={'scene-art art-'+id}><span className="scene-number">0{i+1}</span>{id==='live'?<div className="mini-hud"><i/><i/><i/><i/><b>8 <em>1:24</em> 6</b></div>:id==='matchup'?<div className="mini-match"><Mark/><span>VS</span><Mark other/></div>:id==='veto'?<div className="mini-maps"><i/><i/><i/></div>:id==='bracket'?<div className="mini-bracket"><i/><i/><i/></div>:id==='lineups'?<div className="mini-players">{[1,2,3,4,5].map(n=><Users key={n} size={22}/>)}</div>:<Icon size={35} strokeWidth={1.2}/>}<span className="scene-art-label">{id==='winner'?'VICTORY':id==='break'?'STAY TUNED':''}</span>{controls.scene===id&&<span className="scene-live"><span/> ACTIVE</span>}</div><div className="scene-caption"><div><b>{title}</b><small>{desc}</small></div>{controls.scene===id?<span className="check-circle"><Check size={11}/></span>:<ChevronRight size={14}/>}</div></button>)}</div></section>}
 {tab==='Overview'&&<section className="panel series-panel"><div className="panel-heading"><h2>Current series <span className="subtle-pill">{seriesFormat(data?.series,config)}</span></h2><button className="text-button" onClick={()=>setTab('Match setup')}>Match details<ArrowUpRight size={14}/></button></div><div className="series-content"><div className="series-teams"><Mark logo={sides.CT.logo} color={sides.CT.color}/><div><b>{sides.CT.name} <span>vs</span> {sides.T.name}</b><small>{[config?.event?.stage,config?.event?.name].filter(Boolean).join(' · ')||'EXHIBITION'}</small></div><Mark other logo={sides.T.logo} color={sides.T.color}/></div><div className="map-results">{(config?.maps||[]).map((m:any,i:number)=><div className={'map-result '+m.status} key={(m.name||'map')+i}>{m.image&&<img className="map-thumb" src={'/'+String(m.image).replace(/^\//,'')} alt=""/>}<span className="map-index">0{i+1}</span><div><b>{String(m.name||'—').replace('de_','')}</b><small>{m.pick==='decider'?'Decider':`${m.pick==='A'?(config?.teams?.[0]?.name||'Team A'):(config?.teams?.[1]?.name||'Team B')} pick`}</small></div><div className="map-score"><b>{m.status==='upcoming'?'—':(m.score||[]).join(' : ')}</b><small>{m.status==='live'?'● CONFIGURED LIVE':m.status==='done'?'FINISHED':'UP NEXT'}</small></div></div>)}</div></div></section>}
 {tab==='Broadcast scenes'&&canEditMatch&&config&&<BreakEditor config={config} onChange={setDraft} breakEndsAt={controls.breakEndsAt??null} hostNow={now+(data?.clockSkew||0)} onTimer={endsAt=>update({breakEndsAt:endsAt})} onShow={()=>update({scene:'break'})} onAir={controls.scene==='break'}/>}
 {tab==='Broadcast scenes'&&isOwner&&obsView&&obsStatus&&<ObsPanel config={obsView} status={obsStatus} dirty={obsDirty} busy={obsBusy} onChange={setObsDraft} onSave={saveObs} onReconnect={()=>obsCall('/api/obs/reconnect',jsonInit('POST'),'Reconnecting to OBS…')} onTest={scene=>obsCall('/api/obs/switch',jsonInit('POST',{scene}),`OBS switched to “${scene}”`)} onRefresh={async()=>{const body=await obsCall('/api/obs/refresh-overlay',jsonInit('POST'),'Overlay refreshed in OBS');if(body?.refreshed) flash(`Refreshed ${body.refreshed.join(', ')} in OBS`)}}/>}
 {tab==='Match setup'&&(canEditMatch&&config?<MatchEditor config={config} onChange={setDraft}/>:<PermissionNotice title="Match editing is restricted" description="A producer or owner can change teams, series details and the map order."/>)}
 {tab==='Map radars'&&(canDesign?<RadarsEditor radars={radars} seriesMaps={(config?.maps||[]).map((map:any)=>String(map.name||''))} onChange={setRadarsDraft} onSave={saveRadars} dirty={radarsDirty}/>:<PermissionNotice title="Radar design is restricted" description="An owner or designer can calibrate radar assets and publish them to the transparent output."/>)}
 {tab==='Teams & players'&&(canEditMatch&&config?<TeamEditor config={config} onChange={setDraft}/>:<PermissionNotice title="Roster editing is restricted" description="A producer or owner can update teams, players, aliases and portraits for this event."/>)}
 {tab==='Tournament tree'&&(canEditMatch&&config?<BracketEditor config={config} onChange={setDraft}/>:<PermissionNotice title="Bracket editing is restricted" description="A producer or owner can edit the tournament bracket."/>)}
 {tab==='Overlay Studio'&&(canDesign?<OverlayStudio value={overlay} onChange={setOverlayDraft} onSave={saveOverlay} onDiscard={()=>setOverlayDraft(null)} dirty={overlayDirty} busy={overlayBusy} onNotice={flash}/>:<PermissionNotice title="Overlay Studio is read-only" description="Request designer or owner access to add, remove, arrange, and theme broadcast layers."/>)}
 {tab==='Replay Studio'&&<ReplayStudio onFrame={setPreviewReplay} recording={data?.recording} onRecordingChange={setRecording} canControl={canDrive} onNotice={flash}/>}
 {tab==='Session archive'&&<MatchArchivePanel active={data?.archive} canControl={canDrive} onNotice={flash}/>}
 {tab==='Event packages'&&<EventPackPanel canDesign={canDesign} onImported={packImported} onNotice={flash}/>}
 {tab==='Operators & audit'&&isOwner&&<OperatorConsole session={session} onNotice={flash}/>}
 {tab==='Beta applications'&&isOwner&&<BetaApplicationsPanel/>}
 {tab==='Operations'&&isOwner&&<OperationsPanel/>}
 {tab==='Setup guide'&&<section className="panel detail-panel"><h2>Connect your observer station</h2><ol><li>Copy <code>config/gamestate_integration_overlay.cfg</code> into CS2’s <code>game/csgo/cfg</code> folder.</li><li>Set matching GSI_TOKEN and config auth token. Restart CS2 in Fullscreen Windowed and observe a match.</li><li>In OBS, add Game Capture for cs2.exe, then a Browser Source using <code>{location.origin}/obs</code> — the address you opened this panel on, so it is right whether OBS runs here or on another machine. The overlay needs no token.</li><li>Set the Browser Source to 1920 × 1080. Disable “Shutdown source when not visible”. Do not use chroma key or Window Capture for this overlay.</li><li>Optional: the <b>SCOUT Shell</b> (<code>src-tauri</code>, Windows) shows <code>/game</code> in its own click-through window exactly over CS2 while CS2 is in front — F8 switches it on and off. See the README; it is an alternative to the OBS Browser Source, not a second copy of it.</li><li>Optional: connect SCOUT to OBS from the <b>OBS Studio</b> card on the <b>Broadcast scenes</b> tab to switch OBS&apos;s scene along with yours.</li></ol><p className="info-note">Overlay covering the game with black bars? Point the Browser Source at <code>/obs</code> (never <code>/</code> or <code>/admin</code>), leave the source’s <b>Custom CSS</b> field empty, and keep the active scene on <b>Live game</b> — the other scenes are full-screen graphics by design. To prove the page is transparent, open <code>/obs?checker=1</code> in a normal browser: the HUD should sit on a grey checkerboard, and only the HUD panels themselves should be filled.</p><button className="button" onClick={()=>navigator.clipboard.writeText(location.origin+'/obs').then(()=>setNotice('OBS URL copied')).catch(()=>setNotice('Copy manually: '+location.origin+'/obs'))}><Copy size={15}/>Copy OBS source URL</button></section>}
 <footer><span><span className="footer-brand">✳ scout</span> Built for the moments that matter.</span><span>GSI only <i/> No injection <i/><span className="status-dot"/> External-process architecture</span></footer></div></main>{notice&&<motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} className="toast"><Check size={16}/>{notice}</motion.div>}</div>}
function Output(props:React.ComponentProps<typeof Hud>){const [scale,setScale]=useState(Math.min(innerWidth/1920,innerHeight/1080));useEffect(()=>{document.documentElement.classList.add('output-root');document.body.classList.add('output-body');const resize=()=>setScale(Math.min(innerWidth/1920,innerHeight/1080));addEventListener('resize',resize);return()=>removeEventListener('resize',resize)},[]);return <>{showChecker&&<div className="checker-backdrop" aria-hidden="true"/>}<div className="output-canvas" style={{transform:`translate(-50%,-50%) scale(${scale})`}}><Hud {...props}/></div></>}
createRoot(document.getElementById('root')!).render(<App/>);
