import type {MatchState} from './state.js';
// Series state derived from GSI plus operator config. GSI carries matches_won_this_series and the
// live round number, but not the best-of, the MR or the OT length, so those come from config with
// CS2 defaults (bo3, MR12, 3 rounds per OT half). Everything is computed in CT/T space; the sides
// tracker supplies the names.
export type Side='CT'|'T';
export type SeriesPhase='regulation'|'overtime'|'complete';
export interface SeriesState {
 format:string; bestOf:number; mapsToWin:number; mr:number; otPerHalf:number; regulationRounds:number;
 phase:SeriesPhase; round:number; roundsPlayed:number; roundsThisHalf:number; otPeriod?:number;
 score:{CT:number;T:number}; maps:{CT:number;T:number}; pips:{CT:boolean[];T:boolean[]};
 mapWinner?:Side; seriesWinner?:Side;
}
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
export function formatOf(config:any):{format:string;bestOf:number} {
 const raw=String(config?.format||'').toLowerCase(), matched=/^bo([135])$/.exec(raw);
 const bestOf=matched?Number(matched[1]):[1,3,5].includes(Number(config?.bestOf))?Number(config.bestOf):3;
 return {format:bestOf===1?'bo1':`bo${bestOf}`,bestOf};
}
export function seriesState(state:MatchState,config:any={}):SeriesState {
 const {format,bestOf}=formatOf(config), mapsToWin=Math.ceil(bestOf/2);
 const mr=clamp(Number(config?.mr)>0?Number(config.mr):12,1,30), otPerHalf=clamp(Number(config?.otMr)>0?Number(config.otMr):3,1,15);
 const regulationRounds=2*mr;
 const score={CT:Number(state.map?.team_ct?.score??0),T:Number(state.map?.team_t?.score??0)};
 const maps={CT:Number((state.map?.team_ct as any)?.matches_won_this_series??0),T:Number((state.map?.team_t as any)?.matches_won_this_series??0)};
 const round=Math.max(1,Number(state.map?.round??1)), played=score.CT+score.T;
 // Level scores only mean overtime once both teams have reached the regulation half target (12-12 in
 // MR12); 7-7 in round 14 is ordinary regulation, not the first OT period.
 const tied=score.CT===score.T&&score.CT>=mr;
 const beyond=round>regulationRounds;
 const otPeriod=beyond?Math.floor((round-1-regulationRounds)/(2*otPerHalf))+1:tied?1:undefined;
 const roundsThisHalf=beyond?((round-1-regulationRounds)%otPerHalf)+1:((round-1)%mr)+1;
 const mapWinner:Side|undefined=state.map?.phase==='gameover'&&state.map?.name?(score.CT>score.T?'CT':score.T>score.CT?'T':undefined):undefined;
 const seriesWinner:Side|undefined=maps.CT>=mapsToWin?'CT':maps.T>=mapsToWin?'T':undefined;
 const pip=(won:number)=>Array.from({length:mapsToWin},(_,index)=>index<Math.min(won,mapsToWin));
 return {format,bestOf,mapsToWin,mr,otPerHalf,regulationRounds,phase:seriesWinner?'complete':otPeriod?'overtime':'regulation',round,roundsPlayed:played,roundsThisHalf,otPeriod,score,maps,pips:{CT:pip(maps.CT),T:pip(maps.T)},mapWinner,seriesWinner};
}
