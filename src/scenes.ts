import {formatOf,type SeriesState} from '../server/series';
import {splitRoster,type PlayerCard} from '../server/players';
// What the full-canvas broadcast scenes show, derived from the operator's configuration. Pure and
// separate from the JSX so the derivations (who won, what the series score is, where a bracket line
// runs) can be tested without a browser. The scenes are config-first on purpose: matchup, lineups and
// break are on air *before* CS2 is even running, so live GSI is only ever a fallback, never the source.
export type Slot='A'|'B';
export interface SceneTeam {id:string;name:string;tag:string;color:string;logo:string;slot:Slot}
const FALLBACK:Record<Slot,string>={A:'#d970c2',B:'#e8c97e'};

// Team A is the first configured team. `swapped` mirrors the operator's "swap sides" switch so the scenes
// and the scoreboard agree about which team is on the left.
export function teamBySlot(config:any,slot:Slot):SceneTeam {
 const raw=(Array.isArray(config?.teams)?config.teams:[])[slot==='A'?0:1]||{};
 return {id:String(raw.id||slot),name:String(raw.name||`TEAM ${slot}`),tag:String(raw.tag||''),color:String(raw.color||FALLBACK[slot]),logo:String(raw.logo||''),slot};
}
export const sceneTeams=(config:any,swapped=false):[SceneTeam,SceneTeam]=>{const pair:[SceneTeam,SceneTeam]=[teamBySlot(config,'A'),teamBySlot(config,'B')];return swapped?[pair[1],pair[0]]:pair};

// Map names arrive as de_mirage / cs_office / ar_baggage.
export const mapLabel=(name?:string)=>String(name||'').replace(/^(de|cs|ar)_/i,'').replace(/_/g,' ').toUpperCase();

export interface MapCard {index:number;name:string;label:string;image:string;pick:Slot|'decider';status:'upcoming'|'live'|'done';score?:[number,number];winner?:Slot}
// A map with no uploaded picture falls back to the shipped thumbnail (public/thumbs/), so the matchup and
// map series scenes have real imagery out of the box. Radar overviews (public/radars/) are the custom
// radar's own imagery and are deliberately never used here; the component handles a missing file anyway.
export function mapCards(config:any):MapCard[] {
 return (Array.isArray(config?.maps)?config.maps:[]).map((raw:any,index:number):MapCard=>{
  const name=String(raw?.name||'');
  const status=raw?.status==='done'||raw?.status==='live'?raw.status:'upcoming';
  const pair=Array.isArray(raw?.score)&&raw.score.length===2?raw.score.map(Number):undefined;
  const score=pair&&pair.every((value:number)=>Number.isFinite(value))?[pair[0],pair[1]] as [number,number]:undefined;
  // Only a finished map has a winner; a live score is a score, not a result.
  const winner:Slot|undefined=status==='done'&&score?(score[0]>score[1]?'A':score[1]>score[0]?'B':undefined):undefined;
  const image=String(raw?.image||'')||(name?`thumbs/${name}.png`:'');
  return {index,name,label:mapLabel(name),image,pick:raw?.pick==='A'||raw?.pick==='B'?raw.pick:'decider',status,score,winner};
 });
}
// One side of a tournament-tree match: a slot bound to a configured team shows that team's name, logo and
// colour; a free-label seed ("Winner of SF1", a club that is not one of the two teams) shows its label.
export interface SlotView {name:string;logo:string;color:string;bound:boolean}
export function slotView(slot:any,config:any):SlotView {
 const team=slot?.team?(Array.isArray(config?.teams)?config.teams:[]).find((candidate:any)=>candidate.id===slot.team):undefined;
 if(team) return {name:String(team.name),logo:String(team.logo||''),color:String(team.color||''),bound:true};
 return {name:String(slot?.label||'').trim()||'TBD',logo:'',color:'',bound:false};
}
export const nextMap=(cards:MapCard[])=>cards.find(card=>card.status==='live')||cards.find(card=>card.status==='upcoming');

export interface SeriesScore {a:number;b:number;needed:number;source:'config'|'gsi'|'none';winner?:Slot}
type SidesLike={CT?:{id?:string};T?:{id?:string}};
type SeriesLike=Pick<SeriesState,'maps'|'mapsToWin'|'seriesWinner'>;
// The operator's recorded map results win; before any are entered the live GSI series score is used, but
// only for sides that resolved to one of the two configured teams (a stand-in side has no slot to credit).
export function seriesScore(config:any,series?:SeriesLike,sides?:SidesLike):SeriesScore {
 const needed=Math.ceil(formatOf(config).bestOf/2);
 const decided=mapCards(config).filter(card=>card.winner);
 if(decided.length){
  const a=decided.filter(card=>card.winner==='A').length, b=decided.length-a;
  return {a,b,needed,source:'config',winner:a>=needed?'A':b>=needed?'B':undefined};
 }
 if(series&&sides){
  const slotOf=(side:'CT'|'T'):Slot|undefined=>{const id=sides[side]?.id;return id&&id===config?.teams?.[0]?.id?'A':id&&id===config?.teams?.[1]?.id?'B':undefined};
  const tally={A:0,B:0};let seen=false;
  for(const side of ['CT','T'] as const){const slot=slotOf(side);if(slot){tally[slot]+=Number(series.maps?.[side])||0;seen=true}}
  if(seen&&(tally.A||tally.B)){const need=series.mapsToWin||needed;return {a:tally.A,b:tally.B,needed:need,source:'gsi',winner:tally.A>=need?'A':tally.B>=need?'B':undefined}}
 }
 return {a:0,b:0,needed,source:'none'};
}

// `score` is winner-first (maps won in a series, rounds won in a map, the final's score in a tree).
export interface Champion {team?:SceneTeam;scope:'series'|'bracket'|'map'|'none';score?:[number,number]}
// Who the winner scene celebrates. The live feed's series winner is authoritative; then the operator's
// recorded results; then the tournament tree's final; and only a finished map as the last resort.
export function winnerOf(config:any,series?:SeriesLike&Partial<Pick<SeriesState,'mapWinner'|'score'>>,sides?:SidesLike):Champion {
 const slotOfSide=(side?:'CT'|'T'):Slot|undefined=>{const id=side?sides?.[side]?.id:undefined;return id&&id===config?.teams?.[0]?.id?'A':id&&id===config?.teams?.[1]?.id?'B':undefined};
 const other=(side:'CT'|'T')=>side==='CT'?'T':'CT';
 const live=slotOfSide(series?.seriesWinner);
 if(live&&series?.seriesWinner){const side=series.seriesWinner;return {team:teamBySlot(config,live),scope:'series',score:[Number(series.maps?.[side])||0,Number(series.maps?.[other(side)])||0]}}
 const recorded=seriesScore(config).winner;
 if(recorded){const wins=seriesScore(config);return {team:teamBySlot(config,recorded),scope:'series',score:recorded==='A'?[wins.a,wins.b]:[wins.b,wins.a]}}
 const rounds:any[]=Array.isArray(config?.bracket?.rounds)?config.bracket.rounds:[];
 const final=rounds[rounds.length-1]?.matches?.slice(-1)[0];
 if(final?.winner==='a'||final?.winner==='b'){
  const slot=final[final.winner], won=Number(final.winner==='a'?final.aScore:final.bScore)||0, lost=Number(final.winner==='a'?final.bScore:final.aScore)||0;
  const configured=(config?.teams||[]).findIndex((team:any)=>team.id&&team.id===slot?.team);
  if(configured>=0) return {team:teamBySlot(config,configured===0?'A':'B'),scope:'bracket',score:[won,lost]};
  if(slot?.label) return {team:{id:'bracket',name:String(slot.label),tag:'',color:FALLBACK.A,logo:'',slot:'A'},scope:'bracket',score:[won,lost]};
 }
 const mapSlot=slotOfSide(series?.mapWinner);
 if(mapSlot&&series?.mapWinner){const side=series.mapWinner;return {team:teamBySlot(config,mapSlot),scope:'map',score:[Number(series.score?.[side])||0,Number(series.score?.[other(side)])||0]}}
 return {scope:'none'};
}

// The lineups scene. The operator's roster is the source; the live feed only stands in when the roster is
// empty (the shipped default has no players) so the scene is never blank while CS2 is connected.
export interface LiveLike {steamid?:string;name?:string;team?:string;observer_slot?:number}
export function liveLineup(players:LiveLike[],side:'CT'|'T',nameOf:(player:LiveLike,side?:string)=>string,limit=5):PlayerCard[] {
 return players.filter(player=>player.team===side).sort((a,b)=>(a.observer_slot??99)-(b.observer_slot??99)).slice(0,limit)
  .map(player=>({name:nameOf(player,side),realName:'',role:'',photo:'',steamid:player.steamid||'',teamId:''}));
}
export const sideOfTeam=(sides:SidesLike|undefined,teamId:string):'CT'|'T'|undefined=>sides?.CT?.id===teamId?'CT':sides?.T?.id===teamId?'T':undefined;
export function lineupFor(config:any,team:SceneTeam,live:PlayerCard[]=[]):{starters:PlayerCard[];bench:PlayerCard[];source:'roster'|'live'|'none'} {
 const configured=(config?.teams||[]).find((candidate:any)=>candidate.id===team.id);
 const {starters,bench}=configured?splitRoster(configured):{starters:[],bench:[]};
 if(starters.length) return {starters,bench,source:'roster'};
 return live.length?{starters:live,bench:[],source:'live'}:{starters:[],bench:[],source:'none'};
}
// A lineup card is 162px wide at the design size (five cards per half: (868 − 4×14) / 5) and its name plate pads
// 12px a side, so the text box is 138px. Player handles are short mixed-case words, hence 0.5em per glyph.
export const NAME_PLATE_W=138;
export const fitName=(name:string):number=>fitSize(name,NAME_PLATE_W,{max:40,min:21,em:0.5});

// Operator text (team and map names, the break wording) runs to 64–240 characters, but a scene has a fixed box:
// the largest size in [min,max] at which `text` should fit `lines` lines of `width` px. Condensed caps measure
// 0.40–0.51em per glyph with the scenes' letter-spacing (M ≈ 0.58, W ≈ 0.72), so 0.56 leaves headroom for real
// names; extra lines count 85% because a word cannot be split across them. Below `min` the CSS ellipsis / line
// clamp takes over, so text is cut rather than the layout broken.
export function fitSize(text:string,width:number,opts:{max:number;min:number;lines?:number;em?:number}):number {
 const {max,min,lines=1,em=0.56}=opts;
 const glyphs=Math.max(1,Array.from(String(text||'')).length);
 const room=width*lines*(lines>1?0.85:1);
 return Math.max(min,Math.min(max,Math.floor(room/(glyphs*em))));
}

export const BREAK_TITLE='WE’LL BE RIGHT BACK';
export const breakWords=(config:any)=>({title:String(config?.break?.title||'').trim()||BREAK_TITLE,message:String(config?.break?.message||'').trim()});
// mm:ss, or h:mm:ss past an hour. Rounded up, so the last second reads 00:01 and 00:00 means "now".
export function formatCountdown(ms:number):string {
 const total=Math.ceil(Math.max(0,Number.isFinite(ms)?ms:0)/1000), hours=Math.floor(total/3600), minutes=Math.floor(total%3600/60), seconds=total%60;
 const pad=(value:number)=>String(value).padStart(2,'0');
 return hours?`${hours}:${pad(minutes)}:${pad(seconds)}`:`${pad(minutes)}:${pad(seconds)}`;
}
export interface BreakClock {running:boolean;done:boolean;remainingMs:number;label:string}
export function breakClock(endsAt:number|null|undefined,now:number):BreakClock {
 if(typeof endsAt!=='number'||!Number.isFinite(endsAt)) return {running:false,done:false,remainingMs:0,label:''};
 const remainingMs=Math.max(0,endsAt-now), done=remainingMs===0;
 return {running:!done,done,remainingMs,label:formatCountdown(remainingMs)};
}

// Tournament tree geometry. Round r has its own match count; match i feeds match floor(i/2) of the next
// round (the same positional rule the host uses to advance winners), so each column is spread over the
// full height and every connector runs from a match's right edge to the centre of the match it feeds.
export interface BracketCard {round:number;index:number;x:number;y:number;w:number;h:number;cy:number}
export interface BracketLink {round:number;index:number;d:string}
export interface BracketBoard {cards:BracketCard[];links:BracketLink[];colW:number;gap:number;cardH:number;titleH:number;heads:{round:number;x:number;w:number}[]}
const tidy=(value:number)=>Math.round(value*10)/10;
export function bracketLayout(rounds:{matches:unknown[]}[],area:{width:number;height:number},opts:{titleH?:number;maxCardH?:number;maxColW?:number}={}):BracketBoard {
 const count=rounds.length, titleH=opts.titleH??58, maxCardH=opts.maxCardH??118, maxColW=opts.maxColW??340;
 if(!count) return {cards:[],links:[],colW:0,gap:0,cardH:0,titleH,heads:[]};
 const gap=count<=2?130:count<=3?104:count<=5?66:40;
 const colW=Math.max(120,Math.min(maxColW,(area.width-(count-1)*gap)/count));
 const x0=Math.max(0,(area.width-(count*colW+(count-1)*gap))/2), body=Math.max(1,area.height-titleH);
 const rows=Math.max(1,...rounds.map(round=>round.matches.length));
 const cardH=tidy(Math.max(44,Math.min(maxCardH,body/rows-14)));
 const cards:BracketCard[]=[], links:BracketLink[]=[], heads:BracketBoard['heads']=[];
 const centre=(round:number,index:number)=>titleH+(index+0.5)*body/Math.max(1,rounds[round].matches.length);
 rounds.forEach((round,r)=>{
  const x=tidy(x0+r*(colW+gap));
  heads.push({round:r,x,w:tidy(colW)});
  round.matches.forEach((_,i)=>{
   const cy=centre(r,i);
   cards.push({round:r,index:i,x,y:tidy(cy-cardH/2),w:tidy(colW),h:cardH,cy:tidy(cy)});
   if(r<count-1){
    const target=Math.min(Math.floor(i/2),rounds[r+1].matches.length-1);
    const x1=tidy(x+colW), x2=tidy(x0+(r+1)*(colW+gap)), xm=tidy(x1+gap/2);
    links.push({round:r,index:i,d:`M${x1} ${tidy(cy)}H${xm}V${tidy(centre(r+1,target))}H${x2}`});
   }
  });
 });
 return {cards,links,colW:tidy(colW),gap,cardH,titleH,heads};
}
