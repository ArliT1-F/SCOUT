import type {MatchState} from './state.js';
// Binding a config team to a side by GSI name alone breaks the moment the roster is empty (the
// shipped default) or the team name arrives as something else. This tracker resolves the sides from
// every piece of evidence available — GSI names, config names/tags, roster SteamIDs — and remembers
// the binding so a >5 s gap mid-map cannot silently flip the teams.
export type Side='CT'|'T';
export type SideSource='names'|'roster'|'stored'|'config'|'stand-in';
export interface ResolvedSide {id:string;name:string;tag?:string;color?:string;logo?:string;source:SideSource}
export interface ResolvedSides {CT:ResolvedSide;T:ResolvedSide;source:SideSource;map?:string;confidence:'engaged'|'inferred'|'guess'}
const normalize=(value?:string)=>value?.trim().toLowerCase();
const rank:Record<SideSource,number>={names:0,roster:1,stored:2,config:3,'stand-in':4};
const stand=(side:Side,name?:string):ResolvedSide=>({id:`${side}:${normalize(name)||'unknown'}`,name:name||side,color:side==='CT'?'#d970c2':'#e8c97e',source:'stand-in'});
export class SideTracker {
 private binding:{CT:string;T:string}|undefined; private map?:string;
 resolve(state:MatchState,config:any):ResolvedSides {
  const teams:any[]=config?.teams||[], mapName=state.map?.name, players=state.allplayers||{};
  const byName=(name?:string)=>teams.find(team=>{const wanted=normalize(name);return !!wanted&&(normalize(team.name)===wanted||normalize(team.tag)===wanted)});
  const bound=(side:Side)=>this.binding&&(mapName===undefined||mapName===this.map)?teams.find(team=>team.id===this.binding![side]):undefined;
  const rostered=(side:Side)=>teams.find(team=>{const steamids:string[]=(team.players||[]).map((player:any)=>player.steamid).filter(Boolean);return steamids.length>0&&steamids.every((steamid:string)=>players[steamid]?.team===side)});
  // Precedence: what CS2 reports about the side, then roster evidence, then the remembered binding,
  // then the GSI name on its own (an unknown name is still the truth — swapping in a config team
  // would be the silent mislabel this tracker exists to remove), and config order only as a last
  // resort with no evidence at all.
  const pick=(side:Side):{team?:any;name?:string;source:SideSource}=>{const raw=side==='CT'?state.map?.team_ct?.name:state.map?.team_t?.name;const named=byName(raw);if(named) return {team:named,source:'names'};const roster=rostered(side);if(roster) return {team:roster,source:'roster'};const stored=bound(side);if(stored) return {team:stored,source:'stored'};return raw?{name:raw,source:'stand-in'}:{source:'config'}};
  const ct=pick('CT'), t=pick('T');
  // Contradictory evidence (both sides naming the same config team) keeps the stronger signal only.
  if(ct.team&&t.team&&ct.team.id===t.team.id){if(rank[t.source]<=rank[ct.source]) ct.team=undefined; else t.team=undefined}
  if(ct.team&&t.team&&ct.source==='names'&&t.source==='names'){this.binding={CT:ct.team.id,T:t.team.id};this.map=mapName??this.map}
  else if(ct.team&&t.team&&ct.source==='roster'&&t.source==='roster'){this.binding={CT:ct.team.id,T:t.team.id};this.map=mapName??this.map}
  const side=(which:Side,inferred:{team?:any;name?:string;source:SideSource},order:number):ResolvedSide=>{
   const {team,name,source}=inferred;
   if(team) return {id:team.id,name:team.name,tag:team.tag,color:team.color,logo:team.logo,source};
   if(name) return {...stand(which,name),source};
   if(teams[order]) return {...teams[order],source:'config'};
   return stand(which);
  };
  const source:SideSource=rank[ct.source]>=rank[t.source]?ct.source:t.source;
  const engaged=source==='names'||source==='roster';
  return {CT:side('CT',ct,0),T:side('T',t,1),source,map:mapName??this.map,confidence:engaged?'engaged':source==='stored'?'inferred':'guess'};
 }
}
// The dashboard still needs a matchup line before any GSI packet arrives.
export function configSides(config:any):ResolvedSides {
 const teams:any[]=config?.teams||[];
 const side=(index:number,which:Side):ResolvedSide=>teams[index]?{id:teams[index].id,name:teams[index].name,tag:teams[index].tag,color:teams[index].color,logo:teams[index].logo,source:'config'}:stand(which);
 return {CT:side(0,'CT'),T:side(1,'T'),source:'config',confidence:'guess'};
}
