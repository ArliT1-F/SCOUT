import React,{useMemo,useState} from 'react';
import {AnimatePresence,motion} from 'framer-motion';
import {Trophy,Users} from 'lucide-react';
import {assetUrl} from './assets';
import {sceneTeams,teamBySlot,mapCards,nextMap,seriesScore,winnerOf,lineupFor,liveLineup,sideOfTeam,fitName,fitSize,breakWords,breakClock,bracketLayout,slotView,type SceneTeam,type MapCard,type LiveLike} from './scenes';
import {splitRoster,type PlayerCard} from '../server/players';
import type {SceneId} from '../server/controls';
import type {SeriesState} from '../server/series';
import type {ResolvedSides} from '../server/sides';
// The full-canvas broadcast scenes: matchup, lineups, map series, tournament tree, winner and break. Each
// one owns the whole 1920×1080 canvas (the live scoreboard steps aside) and is drawn from the operator's
// configuration, so it is correct before CS2 is even running. Team colours arrive as --a / --b / --team
// custom properties; everything else is the SCOUT black-and-magenta theme.
const ease=[0.22,1,0.36,1] as const;
const rise=(index=0,y=26)=>({initial:{opacity:0,y},animate:{opacity:1,y:0},transition:{duration:.55,delay:.15+index*.07,ease}});
const pop=(delay=0)=>({initial:{opacity:0,scale:.82},animate:{opacity:1,scale:1},transition:{duration:.6,delay,ease}});
const tint=(color:string)=>({['--team' as any]:color});
// Text boxes the scenes fit operator text into (px at the 1920×1080 design size). See fitSize().
const SIDE_W=(1792-300)/2;      // one team column of the matchup: the canvas less margins and the VS column, halved
const LINEUP_HEAD_W=868-84-20;  // a lineup column less its crest and gap
const SERIES_NAME_W=520;        // each team name beside the series score

// A team's logo, or a monogram in the team colour when it has none (or the file is gone), so a scene is
// never a blank hole while the operator is still setting up.
export function Crest({team,size}:{team:Pick<SceneTeam,'name'|'tag'|'color'|'logo'>;size:number}){
 const [failed,setFailed]=useState('');
 const glow=tint(team.color);
 if(team.logo&&failed!==team.logo) return <span className="st-crest-wrap" style={{width:size,height:size,...glow}}><img className="st-crest" style={{width:size,height:size}} src={assetUrl(team.logo)} alt="" onError={()=>setFailed(team.logo)}/></span>;
 const letters=Array.from((team.tag||team.name||'?').replace(/[^\p{L}\p{N}]/gu,'')).slice(0,3).join('').toUpperCase()||'?';
 return <span className="st-crest-wrap" style={{width:size,height:size,...glow}}><span className="st-monogram" style={{width:size,height:size,fontSize:Math.round(size*(letters.length>2?.3:.4))}}>{letters}</span></span>;
}

const formatText=(config:any)=>`BEST OF ${String(config?.format||'bo3').replace(/\D/g,'')||'3'}`;
function Frame({config,teams,label,children}:{config:any;teams:[SceneTeam,SceneTeam];label:string;children:React.ReactNode}){
 return <motion.div className="stage" style={{['--a' as any]:teams[0].color,['--b' as any]:teams[1].color}} initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:.4}}>
  <div className="stage-wash"/><div className="stage-grid"/>
  <div className="st-head"><div className="st-event">✳ <b>{config?.event?.name||'SCOUT'}</b>{config?.event?.stage&&<span>{config.event.stage}</span>}</div><div className="st-chip">{formatText(config)}</div></div>
  {children}
  <div className="st-foot"><span>SCOUT<span className="tiny-plus">+</span></span><span>{label}</span></div>
 </motion.div>;
}

// ---- Matchup ----
function MatchupScene({config,teams,cards,score}:{config:any;teams:[SceneTeam,SceneTeam];cards:MapCard[];score:[number,number]}){
 const side=(team:SceneTeam,i:number)=><motion.div className="st-side" style={tint(team.color)} initial={{opacity:0,x:i?90:-90}} animate={{opacity:1,x:0}} transition={{duration:.7,delay:.1,ease}}>
  <Crest team={team} size={320}/>
  <h2 className="st-team-name" style={{fontSize:fitSize(team.name,SIDE_W,{max:96,min:40,lines:2})}}>{team.name}</h2>
  {team.tag&&<span className="st-tag">{team.tag}</span>}
 </motion.div>;
 return <Frame config={config} teams={teams} label="Matchup">
  <div className="st-matchup">
   {side(teams[0],0)}
   <motion.div className="st-vs" {...pop(.35)}><b>VS</b>{(score[0]||score[1])?<div className="st-series"><em>{score[0]}</em><i>:</i><em>{score[1]}</em></div>:null}<small>{formatText(config)}</small></motion.div>
   {side(teams[1],1)}
  </div>
  {cards.length>0&&<div className="st-maprow">{cards.map((card,i)=>{const pick=card.pick==='decider'?undefined:teamBySlot(config,card.pick);
   return <motion.div className={'st-mapchip '+card.status} style={tint(pick?.color||'#7e6c90')} key={card.index} {...rise(i+4,18)}>
    {pick?<Crest team={pick} size={34}/>:<span className="st-decider">?</span>}
    <div><b>{card.label||'TBA'}</b><small>{card.status==='live'?'LIVE NOW':card.pick==='decider'?'DECIDER':`${pick?.tag||pick?.name} PICK`}</small></div>
    {card.score&&card.status!=='upcoming'&&<span className="res">{(teams[0].slot==='A'?card.score:[card.score[1],card.score[0]]).join('–')}</span>}
   </motion.div>})}</div>}
 </Frame>;
}

// ---- Lineups ----
function PlayerFigure({card,index,team}:{card:PlayerCard;index:number;team:SceneTeam}){
 const [broken,setBroken]=useState(false);
 return <motion.figure className="st-player" style={tint(team.color)} {...rise(index,44)}>
  <div className="st-photo">{card.photo&&!broken?<img src={assetUrl(card.photo)} alt="" onError={()=>setBroken(true)}/>:<Users size={56} strokeWidth={1.3}/>}{card.role&&<span className="st-role">{card.role}</span>}</div>
  <figcaption><b style={{fontSize:fitName(card.name)}}>{card.name||'—'}</b><small>{card.realName||'\u00a0'}</small></figcaption>
 </motion.figure>;
}
function LineupsScene({config,teams,lineups}:{config:any;teams:[SceneTeam,SceneTeam];lineups:ReturnType<typeof lineupFor>[]}){
 return <Frame config={config} teams={teams} label="Lineups">
  <div className="st-lineups">{teams.map((team,ti)=>{const {starters,bench,source}=lineups[ti];
   return <section className="st-lineup" style={tint(team.color)} key={team.slot}>
    <motion.div className="st-lineup-head" {...rise(0,-20)}><Crest team={team} size={84}/><div><h2 style={{fontSize:fitSize(team.name,LINEUP_HEAD_W,{max:62,min:34})}}>{team.name}</h2><small>{team.tag?`${team.tag} · `:''}{source==='live'?'ON THE SERVER':'STARTING FIVE'}</small></div></motion.div>
    {starters.length?<div className="st-cards">{starters.map((card,i)=><PlayerFigure card={card} index={i+ti*2} team={team} key={card.steamid+card.name+i}/>)}</div>:<div className="st-empty">No players yet — add them under Teams &amp; players</div>}
    <motion.div className="st-bench" {...rise(6,12)}>{bench.map((card,i)=><span key={card.name+i}><b>{card.role||'SUB'}</b><i>{card.name}</i></span>)}</motion.div>
   </section>})}</div>
 </Frame>;
}

// ---- Map series ----
function MapPicture({card}:{card:MapCard}){
 const [failed,setFailed]=useState('');
 return card.image&&failed!==card.image?<img src={assetUrl(card.image)} alt="" onError={()=>setFailed(card.image)}/>:null;
}
function SeriesScene({config,teams,cards,score}:{config:any;teams:[SceneTeam,SceneTeam];cards:MapCard[];score:[number,number]}){
 const leftIsA=teams[0].slot==='A';
 const columns=Math.max(1,cards.length), maxW=columns<=3?420:columns<=5?340:260;
 // The label sits inside a card whose width is the track width less its 18px side padding and border.
 const labelW=Math.min(maxW,(1792-(columns-1)*20)/columns)-38;
 // A two-digit score ("16 : 14") is about seven glyphs wide; it shrinks with the card instead of being clipped by it.
 const scoreSize=fitSize('0000000',labelW-2,{max:60,min:26});
 return <Frame config={config} teams={teams} label="Map series">
  <motion.div className="st-seriesbar" {...rise(0,-16)}>
   <Crest team={teams[0]} size={92}/><b style={{...tint(teams[0].color),fontSize:fitSize(teams[0].name,SERIES_NAME_W,{max:64,min:34})}}>{teams[0].name}</b>
   <div className="st-score"><em>{score[0]}</em><i>:</i><em>{score[1]}</em></div>
   <b style={{...tint(teams[1].color),fontSize:fitSize(teams[1].name,SERIES_NAME_W,{max:64,min:34})}}>{teams[1].name}</b><Crest team={teams[1]} size={92}/>
  </motion.div>
  <div className="st-maps" style={{gridTemplateColumns:`repeat(${columns},minmax(0,${maxW}px))`}}>{cards.map((card,i)=>{
   const pick=card.pick==='decider'?undefined:teamBySlot(config,card.pick), pair=card.score?(leftIsA?card.score:[card.score[1],card.score[0]]):undefined;
   const winnerLeft=card.winner?card.winner===teams[0].slot:undefined;
   return <motion.article className={'st-map '+card.status} style={tint(pick?.color||'#7e6c90')} key={card.index} {...rise(i,50)}>
    <div className="st-map-img"><MapPicture card={card}/><span className="st-map-no">MAP {i+1}</span>
     <span className={'st-map-status '+card.status}>{card.status==='live'?<><i/>LIVE</>:card.status==='done'?'PLAYED':'UP NEXT'}</span>
     <h3 style={{fontSize:fitSize(card.label||'TBA',labelW,{max:64,min:26})}}>{card.label||'TBA'}</h3></div>
    <div className="st-map-body">
     <div className="st-pick">{pick?<><Crest team={pick} size={26}/><span>{pick.tag||pick.name} pick</span></>:'Decider'}</div>
     <div className="st-map-score" style={{fontSize:scoreSize}}>{pair&&card.status!=='upcoming'?<><em className={winnerLeft===true?'win':winnerLeft===false?'lose':''}>{pair[0]}</em><i>:</i><em className={winnerLeft===false?'win':winnerLeft===true?'lose':''}>{pair[1]}</em></>:<span className="tbd">—</span>}</div>
    </div>
   </motion.article>})}</div>
 </Frame>;
}

// ---- Tournament tree ----
const BOARD={width:1792,height:790};
function BracketScene({config,teams}:{config:any;teams:[SceneTeam,SceneTeam]}){
 const rounds:any[]=config?.bracket?.rounds||[];
 const board=useMemo(()=>bracketLayout(rounds,BOARD),[rounds]);
 const fontSize=Math.max(12,Math.min(24,Math.round(board.cardH*.21)));
 // One line across the canvas; its 0.17em letter-spacing adds to the glyph width, hence em 0.66.
 const title=config?.bracket?.title||'THE BRACKET';
 return <Frame config={config} teams={teams} label="Tournament tree">
  <motion.h1 className="st-title" style={{fontSize:`${fitSize(title,1792,{max:52,min:30,em:0.66})}px`}} {...rise(0,-16)}>{title}</motion.h1>
  <div className="st-board" style={{width:BOARD.width,height:BOARD.height}}>
   <svg className="st-links" width={BOARD.width} height={BOARD.height}>{board.links.map(link=>{
    const decided=!!rounds[link.round]?.matches?.[link.index]?.winner;
    return <motion.path key={link.round+'-'+link.index} d={link.d} className={decided?'hot':''} initial={{pathLength:0,opacity:0}} animate={{pathLength:1,opacity:1}} transition={{duration:.7,delay:.4+link.round*.25,ease}}/>})}</svg>
   {board.heads.map(head=><motion.div className="st-round-head" style={{left:head.x,width:head.w}} key={head.round} {...rise(head.round,-12)}>{rounds[head.round]?.name}</motion.div>)}
   {board.cards.map(card=>{const match=rounds[card.round]?.matches?.[card.index]||{};
    return <motion.div className={'st-bm '+(match.status==='live'?'live ':'')+(match.winner?'decided':'')} key={card.round+'-'+card.index} style={{left:card.x,top:card.y,width:card.w,height:card.h,fontSize}} {...rise(card.round*2+card.index*.15,22)}>
     {(['a','b'] as const).map(side=>{const view=slotView(match[side],config);
      return <div className={'st-bm-slot '+(match.winner===side?'won':match.winner?'lost':'')+(view.bound?'':' free')} key={side} style={tint(view.color||'#7e6c90')}>
       {view.bound&&<Crest team={{name:view.name,tag:'',color:view.color||'#7e6c90',logo:view.logo}} size={Math.round(card.h*.32)}/>}
       <span className="st-bm-name">{view.name}</span><em>{match.status==='upcoming'&&!match.winner?'':side==='a'?match.aScore:match.bScore}</em>
      </div>})}
     {match.status==='live'&&<span className="st-bm-live"><i/>LIVE</span>}
    </motion.div>})}
  </div>
 </Frame>;
}

// ---- Winner ----
function WinnerScene({config,teams,series,sides,cards}:{config:any;teams:[SceneTeam,SceneTeam];series?:SeriesState;sides?:ResolvedSides;cards:MapCard[]}){
 const champion=winnerOf(config,series,sides), team=champion.team;
 const configured=team&&(config?.teams||[]).find((candidate:any)=>candidate.id===team.id);
 const {starters}=configured?splitRoster(configured):{starters:[]};
 const played=cards.filter(card=>card.status==='done'&&card.score);
 const eyebrow=champion.scope==='bracket'?'Tournament champions':champion.scope==='map'?'Map winners':'Series winners';
 const leftIsA=teams[0].slot==='A';
 return <Frame config={config} teams={teams} label="Winner">
  {team?<div className="st-winner" style={tint(team.color)}>
   <div className="st-burst"/>
   <motion.span className="st-eyebrow" {...rise(0,-14)}><Trophy size={30} strokeWidth={1.6}/>{eyebrow}<Trophy size={30} strokeWidth={1.6}/></motion.span>
   <motion.div className="st-crestbox" {...pop(.2)}><Crest team={team} size={280}/></motion.div>
   <motion.h1 style={{fontSize:`${fitSize(team.name,1700,{max:140,min:56,lines:2})}px`}} {...rise(3,30)}>{team.name}</motion.h1>
   {champion.score&&(champion.score[0]||champion.score[1])?<motion.div className="st-final" {...rise(4,20)}>{champion.score[0]}<i>:</i>{champion.score[1]}</motion.div>:null}
   {played.length>0&&<motion.div className="st-results" {...rise(5,16)}>{played.map(card=>{const pair=leftIsA?card.score!:[card.score![1],card.score![0]];return <span key={card.index}><b>{card.label}</b>{pair.join('–')}</span>})}</motion.div>}
   {starters.length>0&&<div className="st-strip">{starters.map((card,i)=><motion.div className="st-mini" {...rise(6+i,24)} key={card.steamid+card.name+i}><span className="ph">{card.photo?<img src={assetUrl(card.photo)} alt=""/>:<Users size={40} strokeWidth={1.4}/>}</span><b>{card.name}</b></motion.div>)}</div>}
  </div>:<div className="st-winner"><motion.span className="st-eyebrow" {...rise(0)}><Trophy size={30} strokeWidth={1.6}/>Awaiting the result</motion.span><motion.h1 {...rise(1,30)}>Winner to be decided</motion.h1></div>}
 </Frame>;
}

// ---- Break ----
function BreakScene({config,teams,cards,breakEndsAt,now}:{config:any;teams:[SceneTeam,SceneTeam];cards:MapCard[];breakEndsAt:number|null;now:number}){
 const {title,message}=breakWords(config), clock=breakClock(breakEndsAt,now), next=nextMap(cards);
 return <Frame config={config} teams={teams} label="Break">
  <div className="st-break">
   <div className="st-pulse" aria-hidden="true"><i/><i/><i/></div>
   <motion.h1 style={{fontSize:`${fitSize(title,1640,{max:150,min:56,lines:2})}px`}} {...rise(0,28)}>{title}</motion.h1>
   {message&&<motion.p style={{fontSize:`${fitSize(message,1300,{max:40,min:24,lines:3})}px`}} {...rise(1,20)}>{message}</motion.p>}
   {clock.running&&<motion.div className="st-countdown" {...rise(2,20)}><small>BACK IN</small><b>{clock.label}</b></motion.div>}
   {clock.done&&<motion.div className="st-countdown done" {...rise(2,20)}><b>STARTING SHORTLY</b></motion.div>}
  </div>
  <div className="st-next-wrap"><motion.div className="st-next" {...rise(4,20)}>
   <small>UP NEXT</small>
   <Crest team={teams[0]} size={44}/><b>{teams[0].name}</b><i>vs</i><b>{teams[1].name}</b><Crest team={teams[1]} size={44}/>
   {next&&<span className="st-next-map">MAP {next.index+1} · {next.label}</span>}
  </motion.div></div>
 </Frame>;
}

export interface SceneProps {
 scene:SceneId;config:any;swapped:boolean;series?:SeriesState;sides?:ResolvedSides;radars?:any;
 players:LiveLike[];nameOf:(player:LiveLike,side?:string)=>string;
 // Host-clock time in ms (already corrected for the browser's clock skew) and the break timer's end.
 breakEndsAt:number|null;now:number;
}
export function SceneStage({scene,config,swapped,series,sides,radars,players,nameOf,breakEndsAt,now}:SceneProps){
 const teams=sceneTeams(config,swapped), cards=useMemo(()=>mapCards(config,radars),[config,radars]);
 const wins=seriesScore(config,series,sides), score:[number,number]=teams[0].slot==='A'?[wins.a,wins.b]:[wins.b,wins.a];
 let body:React.ReactNode=null;
 if(scene==='matchup') body=<MatchupScene key="matchup" config={config} teams={teams} cards={cards} score={score}/>;
 else if(scene==='lineups'){
  const lineups=teams.map(team=>{const side=sideOfTeam(sides,team.id);return lineupFor(config,team,side?liveLineup(players,side,nameOf):[])});
  body=<LineupsScene key="lineups" config={config} teams={teams} lineups={lineups}/>;
 }
 else if(scene==='veto') body=<SeriesScene key="veto" config={config} teams={teams} cards={cards} score={score}/>;
 else if(scene==='bracket') body=<BracketScene key="bracket" config={config} teams={teams}/>;
 else if(scene==='winner') body=<WinnerScene key="winner" config={config} teams={teams} series={series} sides={sides} cards={cards}/>;
 else if(scene==='break') body=<BreakScene key="break" config={config} teams={teams} cards={cards} breakEndsAt={breakEndsAt} now={now}/>;
 return <AnimatePresence mode="wait">{body}</AnimatePresence>;
}
