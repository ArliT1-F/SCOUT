import type {MatchState} from '../server/state';
// GSI only reports the countdown that was true when the packet was sent, and packets are neither
// perfectly spaced nor guaranteed — so the HUD extrapolates with the local clock between packets and
// resyncs to every packet (the packet value always wins). A paused game freezes the clock, and a feed
// that has gone quiet freezes it at the last reported value instead of inventing a countdown.
export interface Clock {seconds:number;whole:number;running:boolean;source:'bomb'|'round'|'none';paused:boolean;stale:boolean;defusing:boolean}
const STALE_AFTER=5000;
// Whole seconds round up so a clock never reads 0:00 while time is left; with tenths (the C4 timer)
// the value is shown as reported.
export function formatClock(seconds:number,decimals=0):string {
 const safe=Number.isFinite(seconds)&&seconds>0?seconds:0;
 const shown=decimals>0?safe.toFixed(decimals):'';
 const text=decimals>0?shown:`${Math.ceil(safe)}`;
 const [minutes,rest]=text.split('.');
 return `${Math.floor(Number(minutes)/60)}:${String(Number(minutes)%60).padStart(2,'0')}${rest?'.'+rest:''}`;
}
export function interpolatedClock(state:MatchState,lastSeen:number,now=Date.now()):Clock {
 const bombState=state.bomb?.state, planted=bombState==='planted'||bombState==='defusing';
 const reported=planted?state.bomb?.countdown:state.phase_countdowns?.phase_ends_in;
 const raw=reported===''||reported===undefined||reported===null?NaN:Number(reported);
 const finite=Number.isFinite(raw), elapsed=(now-lastSeen)/1000;
 const paused=state.round?.phase==='paused'||state.map?.phase==='gameover'||state.map?.phase==='intermission';
 const fresh=finite&&elapsed*1000<STALE_AFTER;
 const extrapolating=fresh&&!paused&&elapsed>=0;
 const seconds=finite?Math.max(0,raw-(extrapolating?elapsed:0)):0;
 return {seconds,whole:Math.ceil(seconds),running:!!finite&&!!extrapolating&&seconds>0,source:finite?(planted?'bomb':'round'):'none',paused,stale:finite&&!fresh,defusing:bombState==='defusing'};
}
