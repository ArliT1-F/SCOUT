// Seasons and multi-stage events (follow-up §5): one series page that runs group stage → playoffs.
//
// v1 is deliberately two shapes, not a bracket engine: a single stage, or exactly one group stage
// followed by a playoff stage. Swiss is not modelled — a "swiss" label is just a stage with no table,
// because a table that pretends to know Swiss pairing rules would be wrong on the second round.
//
// Everything here is derived from what the operator already entered (schedule stage labels and bracket
// results). Nothing is stored twice, so a corrected result updates the table on the next request.
import type {PublicMatch} from './hub.js';

export type StageKind='group'|'playoff';
export interface StageInput {name:string;matches:PublicMatch[]}
export interface PublicStanding {
 team:string;played:number;won:number;lost:number;
 mapsFor:number;mapsAgainst:number;diff:number;points:number;
}
export interface PublicStage {
 id:string;name:string;kind:StageKind;
 // `table` is empty for a knockout stage: a playoff bracket is read as a bracket, not ranked.
 table:PublicStanding[];
 matches:PublicMatch[];
}
export const POINTS_WIN=3;
export const POINTS_DRAW=1;
// "Group A", "Group stage", "Groups" → group. "Playoffs", "Quarter-final", "Semi", "Final", any
// bracket round → playoff. Anything else is treated as its own stage.
export function stageKind(name:string):StageKind {
 const label=String(name??'').toLowerCase();
 if(/(^|\W)groups?(\W|$)|group [a-z]\b/.test(label)) return 'group';
 return 'playoff';
}
// Swiss is out of scope for v1. Such a stage still renders (the matches are real) but earns no table.
export const isSwiss=(name:string)=>/swiss/i.test(String(name??''));
function slug(value:string,index:number):string {
 const base=String(value??'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
 return base||`stage-${index+1}`;
}
// The table only counts matches between two named teams that have a result. "Winner of SF1" is a slot
// placeholder, not a team, and an upcoming match has not happened yet.
export function standingsFor(teamNames:string[],matches:PublicMatch[]):PublicStanding[] {
 const rows=new Map<string,PublicStanding>();
 const row=(team:string):PublicStanding=>{
  const existing=rows.get(team);
  if(existing) return existing;
  const created={team,played:0,won:0,lost:0,mapsFor:0,mapsAgainst:0,diff:0,points:0};
  rows.set(team,created);return created;
 };
 for(const team of teamNames) row(team);
 for(const match of matches){
  if(match.status!=='done') continue;
  const a=rows.get(match.a),b=rows.get(match.b);
  if(!a||!b) continue;
  a.played++;b.played++;
  a.mapsFor+=match.aScore;a.mapsAgainst+=match.bScore;
  b.mapsFor+=match.bScore;b.mapsAgainst+=match.aScore;
  if(match.aScore>match.bScore){a.won++;b.lost++;a.points+=POINTS_WIN}
  else if(match.bScore>match.aScore){b.won++;a.lost++;b.points+=POINTS_WIN}
  else {a.points+=POINTS_DRAW;b.points+=POINTS_DRAW}
 }
 const table=[...rows.values()];
 for(const standing of table) standing.diff=standing.mapsFor-standing.mapsAgainst;
 // Points, then map difference, then name — the same order every time, so a refresh never reshuffles.
 return table.sort((first,second)=>second.points-first.points||second.diff-first.diff||first.team.localeCompare(second.team));
}
// v1 reducer: one group stage at most. A second group-labelled stage is merged into the first (events
// often name their groups "Group A" and "Group B"), and swiss stages are left as bracket-only stages.
export function collapseStages(stages:StageInput[]):StageInput[] {
 const groups:PublicMatch[]=[];
 const groupNames:string[]=[];
 const others:StageInput[]=[];
 for(const stage of stages){
  if(!stage.matches.length&&!stage.name) continue;
  if(stageKind(stage.name)==='group'&&!isSwiss(stage.name)){groupNames.push(stage.name);groups.push(...stage.matches);continue}
  others.push(stage);
 }
 const collapsed=groupNames.length?[{name:groupNames.length>1?'Group stage':groupNames[0],matches:groups}]:[];
 return [...collapsed,...others];
}
export function buildStages(teamNames:string[],stages:StageInput[]):PublicStage[] {
 return collapseStages(stages).map((stage,index)=>({
  id:slug(stage.name,index),
  name:stage.name||`Stage ${index+1}`,
  kind:stageKind(stage.name),
  table:stageKind(stage.name)==='group'&&!isSwiss(stage.name)?standingsFor(teamNames,stage.matches):[],
  matches:stage.matches,
 }));
}
// The single label a hub shows above the bracket: "Group stage → Playoffs" reads better than a list of
// eight round names, and tells a visitor where they are in the event.
export function stageHeadline(stages:PublicStage[]):string {
 const names=stages.map(stage=>stage.name).filter(Boolean);
 if(names.length<=1) return names[0]??'';
 return `${names[0]} → ${names[names.length-1]}`;
}
