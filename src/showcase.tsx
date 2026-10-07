import React from 'react';
import {Hud} from './hud';
import {demo,demoEvents} from './demo';
import {defaultControls,type SceneId} from '../server/controls';
import {defaultOverlay} from '../server/overlay';
import {normalizeConfig} from '../server/config';
// The radar calibration this build ships, imported rather than retyped, so the dots on the page sit
// where the dots on the broadcast sit (it is the file the host reads and the panel edits).
import radarConfig from '../config/radars.json';
// The pictures on the product page.
//
// They are not screenshots. They are the product: the same `Hud` component the operator panel
// previews and the /obs and /game outputs render, driven by the same sample world the panel's
// "Demo feed" switch uses (src/demo.ts) and by the radar calibration this build ships
// (config/radars.json, the file the host reads). Nothing is redrawn by hand, so a layer that
// changes in the panel changes here on the next build instead of drifting out of date — which is
// the only way a marketing page can be trusted to show the real thing.
//
// What is here beyond the panel's demo feed, and why:
//   - a config (event, teams, rosters, series, bracket) — the panel's demo feed has none, so its
//     preview shows placeholder sides; a product page needs a tournament to look at;
//   - one confirmed round result, because the round-recap scene exists for exactly that state and
//     would otherwise render its "waiting for a result" empty state;
//   - a completed series for the winner scene, because that scene is only ever on air after a
//     final (the header of the tour says so, so nobody is being told the match is over).
// Every string the scenes print still comes from the operator data or the shipped defaults.
const showcaseRound={id:14,map:'de_inferno',round:14,winner:'CT' as const,reason:'elimination' as const,ctScore:8,tScore:6};
export const SHOWCASE_CONFIG:any=normalizeConfig({
 event:{name:'SCOUT Demo Series',stage:'Grand final'},
 format:'bo3',mr:12,otMr:3,
 teams:[
  {id:'vertex',name:'Vertex',tag:'VTX',color:'#d970c2',players:[
   {name:'nova',steamid:'0',role:'AWPER'},
   {name:'kairo',steamid:'1',role:'Entry'},
   {name:'s1lent',steamid:'2',role:'Support'},
   {name:'frost',steamid:'3',role:'Anchor'},
   {name:'mika',steamid:'4',role:'IGL'},
  ]},
  {id:'parallax',name:'Parallax',tag:'PRX',color:'#e8c97e',players:[
   {name:'EXO',steamid:'5',role:'IGL'},
   {name:'ryze',steamid:'6',role:'Rifler'},
   {name:'orbit',steamid:'7',role:'AWPER'},
   {name:'blitz',steamid:'8',role:'Entry'},
   {name:'zen',steamid:'9',role:'Support'},
  ]},
 ],
 // The same story the demo feed tells: map one is history, the live map is de_inferno at 8 : 6.
 maps:[
  {name:'de_mirage',pick:'A',score:[13,9],status:'done'},
  {name:'de_inferno',pick:'B',score:[8,6],status:'live'},
  {name:'de_nuke',pick:'decider',status:'upcoming'},
 ],
 bracket:{title:'Grand final weekend',rounds:[
  {name:'Semifinals',matches:[
   {id:'sf1',a:{team:'vertex',label:''},b:{team:'',label:'Northwind'},aScore:2,bScore:0,winner:'a',status:'done'},
   {id:'sf2',a:{team:'parallax',label:''},b:{team:'',label:'Sable'},aScore:2,bScore:1,winner:'a',status:'done'},
  ]},
  {name:'Final',matches:[{id:'f1',a:{team:'vertex',label:''},b:{team:'parallax',label:''},aScore:1,bScore:0,winner:null,status:'live'}]},
 ]},
});
// The winner scene needs the series finished, so it is previewed with the same event one map later.
export const SHOWCASE_FINISHED_CONFIG:any=normalizeConfig({
 ...SHOWCASE_CONFIG,
 maps:[
  {name:'de_mirage',pick:'A',score:[13,9],status:'done'},
  {name:'de_inferno',pick:'B',score:[13,10],status:'done'},
  {name:'de_nuke',pick:'decider',status:'upcoming'},
 ],
 bracket:{title:'Grand final weekend',rounds:[
  {name:'Semifinals',matches:[
   {id:'sf1',a:{team:'vertex',label:''},b:{team:'',label:'Northwind'},aScore:2,bScore:0,winner:'a',status:'done'},
   {id:'sf2',a:{team:'parallax',label:''},b:{team:'',label:'Sable'},aScore:2,bScore:1,winner:'a',status:'done'},
  ]},
  {name:'Final',matches:[{id:'f1',a:{team:'vertex',label:''},b:{team:'parallax',label:''},aScore:2,bScore:0,winner:'a',status:'done'}]},
 ]},
});
// The map the sample match is live on, read from the same config the scenes print, so the picture
// behind the transparent HUD is the same map the scoreboard names (de_inferno in this build).
export const SHOWCASE_LIVE_MAP=String((SHOWCASE_CONFIG.maps??[]).find((map:any)=>map.status==='live')?.name??'de_inferno');
export const SHOWCASE_RADARS=radarConfig as any;
export const SHOWCASE_OVERLAY=defaultOverlay();
export const showcaseEvents=(now:number,withRoundResult=false)=>{
 const events=demoEvents as unknown as {kills:any[];rounds:any[]};
 return {
  kills:events.kills.map((kill,index)=>({...kill,at:now-index*2400})),
  rounds:withRoundResult?[{...showcaseRound,endedAt:now}]:events.rounds,
 };
};
// A stage frame is the panel's own preview frame: the same .preview-stage/.preview-hud classes that
// scale the 1920 × 1080 canvas down to whatever width the card has, measured the same way (the panel
// does it in PreviewStage, which is why a hard-coded scale is wrong there and here). Nothing is
// painted over the canvas: the frame shows the output, and the caption underneath names it.
function useStageScale(){
 const ref=React.useRef<HTMLDivElement>(null);
 const [scale,setScale]=React.useState(.35);
 React.useEffect(()=>{
  const node=ref.current;if(!node) return;
  const measure=()=>{const width=node.clientWidth;if(width>0) setScale(width/1920)};
  measure();
  if(typeof ResizeObserver==='undefined'){addEventListener('resize',measure);return()=>removeEventListener('resize',measure)}
  const observer=new ResizeObserver(measure);observer.observe(node);
  return()=>observer.disconnect();
 },[]);
 return [ref,scale] as const;
}
// The demo feed is a moment, not a loop: the killfeed entries age out of the 9-second window unless
// `now` keeps moving, which is why the panel ticks a clock and so does this.
function useLiveClock(){
 const [now,setNow]=React.useState(()=>Date.now());
 React.useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 return now;
}
export function HudStage({scene,className='',backdrop=true,map=SHOWCASE_LIVE_MAP}:{scene:SceneId;className?:string;backdrop?:boolean;map?:string}){
 // The panel's demo feed has no tournament behind it, so its preview shows stand-in sides; the page
 // passes the sample event described above instead. Everything else is the panel's own call.
 const [ref,scale]=useStageScale();
 const now=useLiveClock();
 const config=scene==='winner'?SHOWCASE_FINISHED_CONFIG:SHOWCASE_CONFIG;
 return <div className={('preview-stage '+className).trim()} ref={ref}>
  {backdrop&&<div className="map-backdrop"><img className="map-backdrop-img" src={`/thumbs/site/${map}.jpg`} alt="" loading="lazy" decoding="async"/></div>}
  <div className="preview-hud" style={{['--preview-scale' as any]:scale}}>
   <Hud state={demo} controls={{...defaultControls,scene,breakEndsAt:scene==='break'?now+4*60*1000:null}}
    config={config} radars={SHOWCASE_RADARS} overlay={SHOWCASE_OVERLAY} lastSeen={now} now={now}
    signal events={showcaseEvents(now,scene==='recap')} demoMode/>
  </div>
 </div>;
}
