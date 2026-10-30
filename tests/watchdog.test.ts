import test from 'node:test';
import assert from 'node:assert/strict';
import {FEED_SILENCE_MS,FeedWatchdog,buildFeedAlert} from '../server/watchdog.js';
import {defaultAutomation,normalizeAutomation,scheduleForRules} from '../server/automation.js';

// GSI-loss watchdog. The rule the product must keep: a dropped feed during a live map produces exactly
// one safe scene change and one alert — not a retry storm, and not a scene change on a host where CS2
// was never running.
const T0=1_000_000;
const feed=(over:Partial<{now:number;lastSeen:number|null;mapPhase:string|null}>={})=>({now:T0,lastSeen:T0-1000,mapPhase:'live',...over});

test('a host that has never seen GSI is idle, not lost',()=>{
 const watchdog=new FeedWatchdog();
 const transition=watchdog.update({now:T0,lastSeen:null,mapPhase:null});
 assert.equal(transition.action,null);
 assert.equal(transition.state,'idle');
 assert.equal(watchdog.status(T0,null).state,'idle');
});

test('twenty seconds of silence during a live map is one loss',()=>{
 const watchdog=new FeedWatchdog();
 assert.equal(watchdog.update(feed()).action,null,'still receiving');
 const lost=watchdog.update(feed({now:T0+30_000,lastSeen:T0-1000}));
 assert.equal(lost.action,'lost');
 assert.equal(lost.state,'lost');
 assert.ok(lost.silenceMs>=FEED_SILENCE_MS-1000);
 // Further silent samples must not repeat the alarm.
 assert.equal(watchdog.update(feed({now:T0+35_000,lastSeen:T0-1000})).action,null);
 assert.equal(watchdog.update(feed({now:T0+40_000,lastSeen:T0-1000})).action,null);
});

test('a feed that goes quiet after the map ended is not an incident',()=>{
 const watchdog=new FeedWatchdog();
 watchdog.update({now:T0,lastSeen:T0-1000,mapPhase:'live'});
 watchdog.update({now:T0+2000,lastSeen:T0+1500,mapPhase:'gameover'});
 const quiet=watchdog.update({now:T0+60_000,lastSeen:T0+1500,mapPhase:'gameover'});
 assert.equal(quiet.action,null,'CS2 was closed after the match; nothing to interrupt');
});

test('recovery is announced exactly once',()=>{
 const watchdog=new FeedWatchdog();
 watchdog.update(feed());
 assert.equal(watchdog.update({now:T0+30_000,lastSeen:T0-1000,mapPhase:'live'}).action,'lost');
 const restored=watchdog.update({now:T0+31_000,lastSeen:T0+30_900,mapPhase:'live'});
 assert.equal(restored.action,'restored');
 assert.equal(watchdog.update({now:T0+32_000,lastSeen:T0+31_900,mapPhase:'live'}).action,null);
 assert.equal(watchdog.status(T0+32_000,T0+31_900).lastRestoredAt,T0+31_000);
});

test('the status a panel renders carries the age of the last packet',()=>{
 const watchdog=new FeedWatchdog();
 watchdog.update(feed());
 const status=watchdog.status(T0+5000,T0-1000);
 assert.equal(status.state,'watching');
 assert.equal(status.armed,true);
 assert.equal(status.silenceMs,6000);
});

test('a watchdog loss triggers the auto-pilot rule that puts the safe scene up',async()=>{
 const automation=normalizeAutomation({...defaultAutomation(),enabled:false,rules:defaultAutomation().rules.map(rule=>({...rule,enabled:rule.when.type==='feed-lost'}))});
 const actions=scheduleForRules(automation.rules,{type:'feed-lost'},{now:T0,scene:'live',breakEndsAt:null});
 assert.equal(actions.length,1,'the shipped rule is one scene change, not a sequence');
 assert.equal(actions[0].patch.scene,'break');
 assert.deepEqual(Object.keys(actions[0].patch),['scene'],'a feed loss must not touch the score or the config');
});

test('the alert says what happened, where, and for how long — and never pings a role',()=>{
 const lost=buildFeedAlert({kind:'lost',silenceMs:24_000,at:T0,host:'observer-01',scene:'live'});
 assert.match(lost.content,/observer-01/);
 assert.match(lost.content,/24 s/);
 assert.match(lost.content,/safe scene/i);
 assert.deepEqual(lost.allowed_mentions.parse,[],'a webhook that can ping @everyone is a liability');
 const restored=buildFeedAlert({kind:'restored',silenceMs:40_000,at:T0,host:'observer-01',scene:'live'});
 assert.match(restored.content,/again/);
 assert.match(restored.content,/live/);
});
