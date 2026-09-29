import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpolatedClock,formatClock} from '../src/clock';
import type {MatchState} from '../server/state';

const state=(fields:any):MatchState=>({map:{name:'de_ancient',phase:fields.mapPhase||'live'},round:{phase:fields.roundPhase||'live'},phase_countdowns:fields.phase_ends_in!==undefined?{phase_ends_in:fields.phase_ends_in}:undefined,bomb:fields.bomb}) as unknown as MatchState;

test('the round clock extrapolates between packets from the last packet value',()=>{
 const s=state({phase_ends_in:'95.4'});
 assert.equal(interpolatedClock(s,1000,1000).seconds,95.4,'the packet value is used verbatim at packet time');
 assert.equal(interpolatedClock(s,1000,2000).seconds,94.4);
 assert.equal(interpolatedClock(s,1000,1400).seconds,95,'half a second closer to the end');
 assert.equal(interpolatedClock(s,1000,1200).whole,96,'whole seconds round up: 95.2 s left reads as 96');
 assert.equal(interpolatedClock(s,1000,1000).running,true);
 assert.equal(interpolatedClock(s,1000,1000).source,'round');
});

test('a fresh packet resyncs the clock instead of trusting the extrapolation',()=>{
 const s=state({phase_ends_in:'95.4'});
 const drifted=interpolatedClock(s,1000,3400).seconds;
 assert.equal(drifted,93,'three seconds of extrapolation');
 assert.equal(interpolatedClock(s,3000,3400).seconds,95,'a new packet at t=3000 puts the clock back on the game');
});

test('a planted bomb takes over the clock, and the round clock comes back after it',()=>{
 const planted=state({phase_ends_in:'40.2',bomb:{state:'planted',countdown:'35.4'}});
 const clock=interpolatedClock(planted,1000,2000);
 assert.equal(clock.source,'bomb');
 assert.equal(clock.seconds,34.4,'the bomb countdown is the one that matters once planted');
 assert.equal(interpolatedClock(state({phase_ends_in:'40.2',bomb:{state:'defused',countdown:'12.0'}}),1000,2000).source,'round');
 // The game reports the defuse itself (bomb.state defusing); the overlay surfaces it rather than
 // guessing from a frozen countdown.
 const defusing=interpolatedClock(state({phase_ends_in:'33.0',bomb:{state:'defusing',countdown:'33.0'}}),1000,2500);
 assert.equal(defusing.source,'bomb');
 assert.equal(defusing.defusing,true);
 assert.equal(defusing.seconds,31.5,'the C4 clock keeps running while the defuse is played out');
 assert.equal(interpolatedClock(state({phase_ends_in:'33.0',bomb:{state:'planted',countdown:'33.0'}}),1000,2500).defusing,false);
 assert.equal(interpolatedClock(state({phase_ends_in:'40.2'}),1000,1000).source,'round');
});

test('a paused round or an intermission freezes the clock instead of counting down',()=>{
 const paused=state({phase_ends_in:'95.4',roundPhase:'paused'});
 assert.equal(interpolatedClock(paused,1000,9000).seconds,95.4,'a pause stops the countdown');
 assert.equal(interpolatedClock(paused,1000,9000).running,false);
 assert.equal(interpolatedClock(paused,1000,9000).paused,true);
 const intermission=state({phase_ends_in:'9.2',mapPhase:'intermission'});
 assert.equal(interpolatedClock(intermission,1000,5000).seconds,9.2);
});

test('a stale feed freezes the last reported value and says so',()=>{
 const s=state({phase_ends_in:'95.4'});
 const stale=interpolatedClock(s,1000,7000);
 assert.equal(stale.stale,true);
 assert.equal(stale.seconds,95.4,'inventing a countdown for a dead feed would be a lie');
 assert.equal(stale.running,false);
 assert.equal(interpolatedClock(s,1000,6000).stale,true,'5 s is the same limit the live indicator uses');
 assert.equal(interpolatedClock(s,1000,5999).stale,false);
});

test('a clock that has run out clamps at zero, and skew never grows the clock',()=>{
 assert.equal(interpolatedClock(state({phase_ends_in:'0.4'}),1000,2000).seconds,0);
 assert.equal(interpolatedClock(state({phase_ends_in:'0.4'}),1000,2000).running,false);
 assert.equal(interpolatedClock(state({phase_ends_in:'0.4'}),1000,2000).whole,0);
 const skewed=interpolatedClock(state({phase_ends_in:'40'}),5000,1000);
 assert.equal(skewed.seconds,40,'a clock ahead of the host must not add time');
 assert.equal(skewed.stale,false,'skew is not staleness');
 assert.equal(skewed.running,false);
});

test('a payload without a usable countdown reports none rather than zero seconds left',()=>{
 const clock=interpolatedClock(state({phase_ends_in:''}),1000,1000);
 assert.equal(clock.source,'none');
 assert.equal(clock.seconds,0);
 assert.equal(clock.running,false);
 assert.equal(interpolatedClock(state({phase_ends_in:'soon'}),1000,1000).source,'none');
 assert.equal(interpolatedClock({} as unknown as MatchState,1000,1000).source,'none');
});

test('formatClock renders match clocks and tenths',()=>{
 assert.equal(formatClock(95.4),'1:36','whole seconds round up');
 assert.equal(formatClock(95.4,1),'1:35.4','with tenths the value is shown as reported');
 assert.equal(formatClock(9.2),'0:10','0:09.8 s is still ten seconds of clock');
 assert.equal(formatClock(40.5,1),'0:40.5');
 assert.equal(formatClock(0),'0:00');
 assert.equal(formatClock(-3),'0:00');
 assert.equal(formatClock(NaN),'0:00');
});
