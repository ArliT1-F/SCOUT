import {emptyPlayer,type BracketConfig,type BracketMatch,type BracketRound,type PlayerConfig,type TeamConfig} from './config.js';
// start.gg import. Organisers already keep their teams, rosters and brackets on start.gg, so the panel
// can pull them instead of having them typed in twice. Two halves:
//
//  - fetchStartggEvent talks to start.gg's GraphQL API (host side only: it needs the API token) and
//    reduces the answer to a small StartggEvent: entrants with their players, and sets grouped by
//    bracket (phase group).
//  - teamFromEntrant and buildBracket are pure, browser-safe transforms from that shape into SCOUT's
//    own config. The panel applies them to its draft, so an import is reviewed and saved like any
//    other edit and nothing reaches the broadcast until the operator presses Save.
//
// The token is the operator's: it comes from SCOUT_STARTGG_TOKEN on the host or from the request that
// uses it, and is never stored, logged, returned or broadcast (the OBS password follows the same rule).

export const STARTGG_API='https://api.start.gg/gql/alpha';

export interface StartggEntrant {id:string;name:string;players:string[];logoUrl:string|null}
export interface StartggSlot {entrantId:string|null;name:string|null;score:number|null;prereqType:string|null;prereqId:string|null}
export interface StartggSet {id:string;round:number;roundText:string;state:number;winnerId:string|null;groupId:string;slots:[StartggSlot,StartggSlot]}
export interface StartggGroup {id:string;name:string}
export interface StartggEvent {slug:string;tournament:string;name:string;entrants:StartggEntrant[];groups:StartggGroup[];sets:StartggSet[]}

// "https://www.start.gg/tournament/x/event/y/brackets/1/2", "start.gg/tournament/x/event/y" and the
// bare "tournament/x/event/y" all name the same event; the API wants the last form.
export function parseEventSlug(input:string):string|null {
 const match=/(?:^|\/)tournament\/([a-z0-9][a-z0-9-_]*)\/events?\/([a-z0-9][a-z0-9-_]*)/i.exec(String(input||'').trim());
 return match?`tournament/${match[1].toLowerCase()}/event/${match[2].toLowerCase()}`:null;
}

export class StartggError extends Error {constructor(message:string,readonly status:number){super(message)}}

const ENTRANTS_QUERY=`query ScoutEntrants($slug:String!,$page:Int!,$perPage:Int!){event(slug:$slug){id name tournament{name} entrants(query:{page:$page,perPage:$perPage}){pageInfo{totalPages} nodes{id name participants{gamerTag}}}}}`;
const SETS_QUERY=`query ScoutSets($slug:String!,$page:Int!,$perPage:Int!){event(slug:$slug){sets(page:$page,perPage:$perPage){pageInfo{totalPages} nodes{id round fullRoundText state winnerId phaseGroup{id displayIdentifier phase{name}} slots{prereqId prereqType entrant{id name} standing{stats{score{value}}}}}}}}`;
// Team artwork is a separate, optional query: if start.gg answers it with an error (a solo event, a
// schema change) the import simply goes ahead without logos.
const LOGOS_QUERY=`query ScoutTeamLogos($slug:String!,$page:Int!,$perPage:Int!){event(slug:$slug){entrants(query:{page:$page,perPage:$perPage}){nodes{id team{images{url type}}}}}}`;
// start.gg limits a request to 1000 objects; these page sizes keep an entrant page (with its players)
// and a set page (with its slots) well under that. The page caps bound one import to 500 teams and
// 600 matches, far beyond a community cup.
const ENTRANT_PAGE=40,SET_PAGE=40,MAX_PAGES=15;

type Fetch=typeof fetch;
async function gql(query:string,variables:Record<string,unknown>,token:string,fetchImpl:Fetch):Promise<any>{
 let res:Response;
 try{
  res=await fetchImpl(STARTGG_API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20_000)});
 }catch(error:any){throw new StartggError(`start.gg could not be reached (${error?.name==='TimeoutError'?'timed out':error?.message||'network error'}).`,502)}
 if(res.status===401||res.status===403) throw new StartggError('start.gg refused the API token. Create a new token under start.gg → Developer Settings and try again.',401);
 if(res.status===429) throw new StartggError('start.gg is rate limiting requests. Wait a minute and try again.',429);
 const body=await res.json().catch(()=>null);
 if(!res.ok||!body) throw new StartggError(`start.gg answered ${res.status}.`,502);
 if(body.errors?.length&&!body.data?.event) throw new StartggError(`start.gg could not answer the query: ${String(body.errors[0]?.message||'unknown error').slice(0,200)}`,502);
 return body.data;
}
const text=(value:unknown,max=64)=>String(value??'').trim().slice(0,max);
const idOf=(value:unknown)=>value===null||value===undefined?null:String(value);

export async function fetchStartggEvent(slug:string,token:string,fetchImpl:Fetch=fetch):Promise<StartggEvent>{
 if(!token) throw new StartggError('A start.gg API token is needed. Set SCOUT_STARTGG_TOKEN on the host, or paste a token into the import form.',400);
 const entrants:StartggEntrant[]=[];
 let tournament='',name='';
 for(let page=1;page<=MAX_PAGES;page++){
  const data=await gql(ENTRANTS_QUERY,{slug,page,perPage:ENTRANT_PAGE},token,fetchImpl);
  const event=data?.event;
  if(!event) throw new StartggError('No start.gg event was found at that link. Copy the link of the event itself (…/tournament/<name>/event/<event>).',404);
  tournament=text(event.tournament?.name,120);name=text(event.name,120);
  for(const node of event.entrants?.nodes||[]) entrants.push({id:String(node.id),name:text(node.name),players:(node.participants||[]).map((p:any)=>text(p?.gamerTag)).filter(Boolean).slice(0,10),logoUrl:null});
  if(page>=(event.entrants?.pageInfo?.totalPages||1)) break;
 }
 const sets:StartggSet[]=[];const groups=new Map<string,StartggGroup>();
 for(let page=1;page<=MAX_PAGES;page++){
  const event=(await gql(SETS_QUERY,{slug,page,perPage:SET_PAGE},token,fetchImpl))?.event;
  for(const node of event?.sets?.nodes||[]){
   const group=node.phaseGroup||{};const groupId=String(group.id??'event');
   if(!groups.has(groupId)) groups.set(groupId,{id:groupId,name:[text(group.phase?.name,60),group.displayIdentifier?`Pool ${text(group.displayIdentifier,12)}`:''].filter(Boolean).join(' · ')||'Bracket'});
   const slots=(node.slots||[]).slice(0,2).map((slot:any):StartggSlot=>{
    const score=Number(slot?.standing?.stats?.score?.value);
    return {entrantId:idOf(slot?.entrant?.id),name:slot?.entrant?.name?text(slot.entrant.name):null,score:Number.isFinite(score)?score:null,prereqType:slot?.prereqType?String(slot.prereqType):null,prereqId:idOf(slot?.prereqId)};
   });
   while(slots.length<2) slots.push({entrantId:null,name:null,score:null,prereqType:null,prereqId:null});
   sets.push({id:String(node.id),round:Number(node.round)||0,roundText:text(node.fullRoundText),state:Number(node.state)||0,winnerId:idOf(node.winnerId),groupId,slots:slots as [StartggSlot,StartggSlot]});
  }
  if(page>=(event?.sets?.pageInfo?.totalPages||1)) break;
 }
 // Logos: best effort, never fatal.
 try{
  const logos=new Map<string,string>();
  for(let page=1;page<=MAX_PAGES;page++){
   const data=await gql(LOGOS_QUERY,{slug,page,perPage:ENTRANT_PAGE},token,fetchImpl);
   const nodes=data?.event?.entrants?.nodes||[];
   for(const node of nodes){const images=node?.team?.images||[];const image=images.find((i:any)=>i?.type==='profile')||images[0];if(image?.url) logos.set(String(node.id),String(image.url))}
   if(nodes.length<ENTRANT_PAGE) break;
  }
  for(const entrant of entrants) entrant.logoUrl=logos.get(entrant.id)||null;
 }catch{}
 return {slug,tournament,name,entrants,groups:[...groups.values()],sets};
}

// ---- pure transforms (also used by the panel)

// A start.gg entrant as one of SCOUT's two teams. The team keeps its slot id, and any roster entry
// the operator already enriched (SteamID, alias, photo, role) survives when the same player is in the
// imported roster, matched by name. Tag, colour and logo are kept when the team is the same one.
export function teamFromEntrant(entrant:StartggEntrant,current:TeamConfig):TeamConfig {
 const same=current.name.trim().toLowerCase()===entrant.name.trim().toLowerCase();
 const known=new Map(current.players.map(player=>[player.name.trim().toLowerCase(),player]));
 const players:PlayerConfig[]=entrant.players.slice(0,10).map(tag=>known.get(tag.toLowerCase())||{...emptyPlayer(),name:tag});
 // The colour belongs to the slot (it is how viewers tell the two sides apart), so it always stays.
 return {...current,name:entrant.name.slice(0,64)||current.name,tag:same?current.tag:'',logo:same?current.logo:'',players};
}

// The sets of one bracket, as SCOUT's single-elimination tree. start.gg describes each set by what
// feeds it (prereqType "set" + prereqId), so the tree is rebuilt from the final backwards: every match
// at depth d is fed by the two matches beneath it, in slot order. SCOUT's tree is positional (match i
// feeds match ⌊i/2⌋ of the next round), so a slot fed by a seed instead of a set — a bye — gets a
// "vs BYE" match beneath it that the entrant has already won, keeping every position honest.
// Only the winners side is imported (start.gg numbers losers rounds below zero), and at most the last
// MAX_DEPTH rounds: SCOUT's tree holds 16 matches per round.
const MAX_DEPTH=5;
export function buildBracket(event:Pick<StartggEvent,'sets'>,groupId:string,teams:TeamConfig[],title=''):BracketConfig|null {
 const sets=event.sets.filter(set=>set.groupId===groupId&&set.round>0);
 if(!sets.length) return null;
 const byId=new Map(sets.map(set=>[set.id,set]));
 const fedBy=(slot:StartggSlot)=>slot.prereqType==='set'&&slot.prereqId?byId.get(slot.prereqId):undefined;
 // A grand-final reset is fed twice by the grand final. Its place in the tree is the grand final's,
 // so its feeders are the grand final's feeders.
 const feedersOf=(set:StartggSet):StartggSlot[]=>{const a=fedBy(set.slots[0]),b=fedBy(set.slots[1]);return a&&b&&a.id===b.id?a.slots:set.slots};
 // The final is the latest-round set nothing else is fed from. A grand-final reset shares the
 // final's round; the later one (by id order) is the one that decided the bracket.
 const feeding=new Set(sets.flatMap(set=>set.slots.map(slot=>fedBy(slot)?.id).filter(Boolean) as string[]));
 const tops=sets.filter(set=>!feeding.has(set.id)).sort((a,b)=>b.round-a.round||String(b.id).localeCompare(String(a.id),undefined,{numeric:true}));
 const final=tops[0];
 if(!final) return null;
 // Depth of the tree under the final, capped.
 const depthOf=(set:StartggSet,seen=new Set<string>()):number=>{
  if(seen.has(set.id)) return 0;seen.add(set.id);
  return 1+Math.max(0,...feedersOf(set).map(slot=>{const child=fedBy(slot);return child&&!seen.has(child.id)?depthOf(child,seen):0}));
 };
 const depth=Math.min(MAX_DEPTH,depthOf(final));
 const teamFor=(name:string|null)=>{const wanted=(name||'').trim().toLowerCase();return wanted?teams.find(team=>team.name.trim().toLowerCase()===wanted)?.id||'':''};
 const slotOf=(slot:StartggSlot)=>({label:slot.name||'TBD',team:teamFor(slot.name)});
 const clamp=(value:number|null)=>Math.max(0,Math.min(99,Math.round(value??0)));
 const matchOf=(set:StartggSet):BracketMatch=>{
  const [a,b]=set.slots;
  const winner=set.winnerId&&a.entrantId===set.winnerId?'a':set.winnerId&&b.entrantId===set.winnerId?'b':null;
  return {id:('sgg-'+set.id).replace(/[^\w-]/g,'').slice(0,32),a:slotOf(a),b:slotOf(b),aScore:clamp(a.score),bScore:clamp(b.score),winner,status:winner||set.state===3?'done':set.state===2||set.state===6?'live':'upcoming'};
 };
 let byes=0;
 const byeFor=(slot:{label:string;team:string}):BracketMatch=>({id:`bye-${++byes}`,a:{...slot},b:{label:'BYE',team:''},aScore:0,bScore:0,winner:slot.label!=='TBD'?'a':null,status:slot.label!=='TBD'?'done':'upcoming'});
 // Walk level by level from the final. Each entry is either a real set or the slot it stands for.
 type Node={set?:StartggSet;slot?:{label:string;team:string}};
 const levels:Node[][]=[[{set:final}]];
 for(let d=1;d<depth;d++){
  const next:Node[]=[];
  for(const node of levels[d-1]){
   if(node.set) for(const slot of feedersOf(node.set)){const child=fedBy(slot);next.push(child?{set:child}:{slot:slotOf(slot)})}
   else next.push({slot:node.slot},{slot:{label:'BYE',team:''}});
  }
  levels.push(next);
 }
 const roundName=(nodes:Node[],index:number)=>nodes.find(node=>node.set?.roundText)?.set?.roundText||`Round ${index+1}`;
 const rounds:BracketRound[]=levels.reverse().map((nodes,index)=>({
  name:roundName(nodes,index).slice(0,64),
  matches:nodes.map(node=>node.set?matchOf(node.set):node.slot!.label==='BYE'?{id:`bye-${++byes}`,a:{label:'BYE',team:''},b:{label:'BYE',team:''},aScore:0,bScore:0,winner:null,status:'upcoming' as const}:byeFor(node.slot!)),
 }));
 return {title:title.slice(0,120),rounds};
}

// The matches the operator can pick to put on air: both sides known, finals first within a bracket.
export function playableSets(event:Pick<StartggEvent,'sets'>,groupId?:string):StartggSet[]{
 return event.sets.filter(set=>(!groupId||set.groupId===groupId)&&set.slots[0].entrantId&&set.slots[1].entrantId)
  .sort((a,b)=>(a.state===3?1:0)-(b.state===3?1:0)||Math.abs(b.round)-Math.abs(a.round));
}
