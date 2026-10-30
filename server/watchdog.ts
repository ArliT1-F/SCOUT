// Feed watchdog: the difference between "the overlay is on air" and "the overlay is showing a frozen
// scoreboard during a live round". CS2 pushes GSI at ~20 Hz; twenty seconds of silence in the middle
// of a live map is a problem the operator must hear about even when they are not looking at the panel.
//
// The class is deliberately small and pure-clock: it is fed the same facts the host already has
// (last packet, map phase) and answers with a transition, once. Everything that has side effects — the
// scene change, the audit entry, the webhook — happens in the host, so this stays testable by replay.
export const FEED_SILENCE_MS=20_000;
// A host that has never seen GSI (no CS2 running, or a fresh install) is not "lost": there is nothing
// to interrupt. The watchdog only arms after it has seen a live map, and disarms again once a map ends.
export interface FeedSample {now:number;lastSeen:number|null;mapPhase?:string|null;roundPhase?:string|null}
export type FeedState='idle'|'watching'|'lost';
export interface FeedTransition {state:FeedState;action:'lost'|'restored'|null;silenceMs:number;wasLive:boolean}
const LIVE_PHASES=new Set(['live','freezetime','bomb','paused','timeout']);
const isLive=(sample:FeedSample)=>LIVE_PHASES.has(String(sample.mapPhase||sample.roundPhase||'').toLowerCase());
export class FeedWatchdog {
 private state:FeedState='idle';
 private armed=false;
 private lastLostAt:number|null=null;
 private lastRestoredAt:number|null=null;
 constructor(private readonly silenceMs=FEED_SILENCE_MS){}
 update(sample:FeedSample):FeedTransition {
  const silenceMs=sample.lastSeen===null?Infinity:Math.max(0,sample.now-sample.lastSeen);
  const live=isLive(sample);
  // Fresh data: remember whether the match is being played, and recover from a loss exactly once.
  if(silenceMs<this.silenceMs){
   this.armed=live;
   if(this.state==='lost'){this.state='watching';this.lastRestoredAt=sample.now;return {state:this.state,action:'restored',silenceMs,wasLive:live}}
   this.state=sample.lastSeen===null?'idle':'watching';
   return {state:this.state,action:null,silenceMs,wasLive:live};
  }
  // Silence. Only a match the watchdog saw running is worth interrupting, and only once per gap.
  if(this.state!=='lost'&&this.armed&&live){
   this.state='lost';this.lastLostAt=sample.now;
   return {state:this.state,action:'lost',silenceMs,wasLive:true};
  }
  if(this.state==='lost'&&!this.armed) this.state='idle';
  return {state:this.state,action:null,silenceMs,wasLive:live};
 }
 // What the panel shows: the state, when the last loss was, and how stale the feed is right now.
 status(now=Date.now(),lastSeen:number|null=null){
  return {
   state:this.state,
   armed:this.armed,
   lastLostAt:this.lastLostAt,
   lastRestoredAt:this.lastRestoredAt,
   silenceMs:lastSeen===null?null:Math.max(0,now-lastSeen),
  };
 }
}
// The message that lands in Discord (or any webhook) when the feed goes away. It says what happened,
// how long it has been quiet, and what the overlay did — no stack trace, no match data.
export interface FeedAlert {kind:'lost'|'restored';silenceMs:number;at:number;host:string;scene:string}
export function buildFeedAlert(alert:FeedAlert){
 const seconds=Math.max(0,Math.round(alert.silenceMs/1000));
 const content=alert.kind==='lost'
  ? `⚠️ SCOUT lost the CS2 feed on **${alert.host}** — no GSI data for ${seconds} s during a live map. The overlay switched to the safe scene. Open the panel and check the observer station.`
  : `✅ SCOUT is receiving the CS2 feed again on **${alert.host}** after ${seconds} s. The overlay is on scene “${alert.scene}”.`;
 return {content,username:'SCOUT watchdog',allowed_mentions:{parse:[] as string[]}};
}
