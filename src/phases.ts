import type {MatchState} from '../server/state';
// Which HUD elements the current phase allows. Kept pure and separate from the JSX so the mapping
// can be tested without a browser, and so the operator preview and the output routes share it.
export type MapPhase='warmup'|'live'|'intermission'|'gameover'|'unknown';
export type RoundPhase='freezetime'|'live'|'over'|'paused'|'unknown';
export type HudBanner='freezetime'|'round-over'|'tech-pause';
export interface PhaseView {
 phase:MapPhase; round:RoundPhase; rosters:boolean; lowerThird:boolean; killfeed:boolean; clock:boolean;
 banner?:HudBanner; card?:{kind:'warmup'|'intermission'|'final';winner?:'CT'|'T'};
}
const asMapPhase=(value?:string):MapPhase=>value==='warmup'||value==='live'||value==='intermission'||value==='gameover'?value:value?'live':'unknown';
const asRoundPhase=(value?:string):RoundPhase=>value==='freezetime'||value==='live'||value==='over'||value==='paused'?value:value?'live':'unknown';
export function phaseView(state:MatchState,controls:{techPause?:boolean}={}):PhaseView {
 const phase=state.map?.name?asMapPhase(state.map.phase):'unknown';
 const round=asRoundPhase(state.round?.phase??state.phase_countdowns?.phase);
 const playing=phase==='live';
 const card=phase==='warmup'?{kind:'warmup' as const}:phase==='intermission'?{kind:'intermission' as const}:phase==='gameover'?{kind:'final' as const,winner:state.round?.win_team}:undefined;
 // The warmup/intermission/final card owns the screen; the operator's pause switch outranks the
 // round banner, which only speaks while the map is live.
 const banner:HudBanner|undefined=card?undefined:controls.techPause?'tech-pause':round==='paused'?'tech-pause':round==='over'&&playing?'round-over':round==='freezetime'&&playing?'freezetime':undefined;
 return {phase,round,rosters:playing,lowerThird:playing&&round!=='over',killfeed:playing,clock:phase==='live'||phase==='warmup',banner,card};
}
