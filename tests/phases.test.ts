import {test} from 'node:test';
import assert from 'node:assert/strict';
import {phaseView} from '../src/phases';
import type {MatchState} from '../server/state';

const state=(mapPhase:string|undefined,roundPhase:string|undefined):MatchState=>({map:{name:'de_ancient',phase:mapPhase},round:{phase:roundPhase}} as unknown as MatchState);
const controls=(techPause=true)=>({techPause});

test('a live round shows the rosters, lower third, killfeed and clock',()=>{
 const view=phaseView(state('live','live'));
 assert.equal(view.rosters,true);
 assert.equal(view.lowerThird,true);
 assert.equal(view.killfeed,true);
 assert.equal(view.clock,true);
 assert.equal(view.banner,undefined,'nothing is playing over a normal round');
 assert.equal(view.card,undefined);
});

test('freezetime and round over replace the lower third with the phase banner',()=>{
 assert.equal(phaseView(state('live','freezetime')).banner,'freezetime');
 assert.equal(phaseView(state('live','over')).banner,'round-over');
 assert.equal(phaseView(state('live','freezetime')).lowerThird,true,'the matchup card is exactly what freezetime is for');
 assert.equal(phaseView(state('live','over')).lowerThird,false,'the round result owns the lower third');
 assert.equal(phaseView(state('live','over')).killfeed,true,'kills of the round that just ended stay readable');
});

test('a technical pause or a paused round beats every other banner',()=>{
 assert.equal(phaseView(state('live','paused')).banner,'tech-pause');
 assert.equal(phaseView(state('live','live'),controls()).banner,'tech-pause');
 assert.equal(phaseView(state('live','over'),controls()).banner,'tech-pause','the operator pause outranks the round result');
});

test('warmup hides the match HUD and shows the warmup card',()=>{
 const view=phaseView(state('warmup','paused'));
 assert.deepEqual(view.card,{kind:'warmup'});
 assert.equal(view.rosters,false,'nobody is playing yet');
 assert.equal(view.killfeed,false);
 assert.equal(view.clock,true,'the warmup clock is still useful');
 assert.equal(view.banner,undefined,'the card replaces every banner during warmup, the pause switch included');
});

test('intermission and gameover show their cards and keep the round result',()=>{
 const intermission=phaseView(state('intermission','over'));
 assert.deepEqual(intermission.card,{kind:'intermission'});
 assert.equal(intermission.killfeed,false);
 const final=phaseView({map:{name:'de_ancient',phase:'gameover'},round:{phase:'over',win_team:'T'}} as unknown as MatchState);
 assert.deepEqual(final.card,{kind:'final',winner:'T'});
 assert.equal(final.rosters,false);
});

test('a missing or unknown phase falls back to visible sections, not to a blank screen',()=>{
 const unknownPhase=phaseView(state(undefined,undefined));
 assert.equal(unknownPhase.phase,'unknown');
 assert.equal(unknownPhase.round,'unknown');
 assert.equal(unknownPhase.rosters,false,'no map name means no match to show');
 assert.equal(unknownPhase.clock,false);
 const madeUp=phaseView(state('nonsense','nonsense'));
 assert.equal(madeUp.phase,'live','an unrecognised phase is treated as live rather than hiding everything');
 assert.equal(madeUp.rosters,true);
 assert.equal(madeUp.clock,true);
});
