import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seriesState,formatOf} from '../server/series';
import type {MatchState} from '../server/state';

const state=(round:number,ct:number,t:number,extra:any={}):MatchState=>({map:{name:'de_ancient',phase:extra.phase||'live',round,team_ct:{name:'Vertex',score:ct,matches_won_this_series:extra.ctMaps??0},team_t:{name:'Parallax',score:t,matches_won_this_series:extra.tMaps??0}}}) as unknown as MatchState;

test('the series format comes from config with a bo3 default',()=>{
 assert.deepEqual(formatOf({format:'bo1'}),{format:'bo1',bestOf:1});
 assert.deepEqual(formatOf({format:'BO5'}),{format:'bo5',bestOf:5});
 assert.deepEqual(formatOf({format:'bo3'}),{format:'bo3',bestOf:3});
 assert.deepEqual(formatOf({bestOf:5}),{format:'bo5',bestOf:5});
 assert.deepEqual(formatOf({}),{format:'bo3',bestOf:3});
 assert.deepEqual(formatOf({format:'mr12'}),{format:'bo3',bestOf:3},'an unknown format must not leak into the pips');
 assert.equal(formatOf({format:'bo1'}).bestOf,1);
});

test('a bo3 mid regulation reports pips from matches_won_this_series',()=>{
 const series=seriesState(state(14,8,6,{ctMaps:1,tMaps:0}),{format:'bo3'});
 assert.equal(series.mapsToWin,2);
 assert.deepEqual(series.pips,{CT:[true,false],T:[false,false]});
 assert.equal(series.phase,'regulation');
 assert.equal(series.roundsThisHalf,2,'round 14 is the second round of the second half');
 assert.equal(series.regulationRounds,24);
 assert.equal(series.otPeriod,undefined);
 assert.equal(series.seriesWinner,undefined);
});

test('a bo1 ends the series with a single map',()=>{
 const series=seriesState(state(24,13,9,{ctMaps:1,phase:'gameover'}),{format:'bo1'});
 assert.equal(series.mapsToWin,1);
 assert.deepEqual(series.pips,{CT:[true],T:[false]});
 assert.equal(series.phase,'complete');
 assert.equal(series.seriesWinner,'CT');
 assert.equal(series.mapWinner,'CT');
});

test('a 15-15 bo5 on MR15 regulation is not a random guess: the OT rules still hold',()=>{
 const series=seriesState(state(30,15,15,{ctMaps:1,tMaps:1}),{format:'bo5',mr:15});
 assert.equal(series.regulationRounds,30);
 assert.equal(series.phase,'overtime');
 assert.equal(series.otPeriod,1,'12-12 in MR12 and 15-15 in MR15 both mean the first OT period');
 assert.equal(series.roundsThisHalf,15,'round 30 is the last round of the second half');
});

test('MR12 overtime counts periods and halves from the round number',()=>{
 const first=seriesState(state(25,12,12),{format:'bo3'});
 assert.equal(first.phase,'overtime');
 assert.equal(first.otPeriod,1);
 assert.equal(first.roundsThisHalf,1);
 const lastOfFirstHalf=seriesState(state(27,13,14),{format:'bo3'});
 assert.equal(lastOfFirstHalf.otPeriod,1);
 assert.equal(lastOfFirstHalf.roundsThisHalf,3);
 const secondHalf=seriesState(state(28,14,14),{format:'bo3'});
 assert.equal(secondHalf.otPeriod,1);
 assert.equal(secondHalf.roundsThisHalf,1,'an OT half is three rounds, so the fourth round starts a new half');
 const ot2=seriesState(state(31,15,15),{format:'bo3'});
 assert.equal(ot2.otPeriod,2,'rounds 25-30 are OT1; 31 starts OT2');
 assert.equal(ot2.roundsThisHalf,1);
});

test('a decided map in overtime ends the series when the map count reaches mapsToWin',()=>{
 const series=seriesState(state(31,16,14,{ctMaps:2,phase:'gameover'}),{format:'bo3'});
 assert.equal(series.phase,'complete');
 assert.equal(series.seriesWinner,'CT');
 assert.equal(series.mapWinner,'CT');
 assert.deepEqual(series.pips,{CT:[true,true],T:[false,false]});
 const tight=seriesState(state(33,17,15,{ctMaps:0,phase:'gameover'}),{format:'bo3'});
 assert.equal(tight.mapWinner,'CT');
 assert.equal(tight.phase,'overtime','the map went to OT even though the series is not over');
 assert.equal(tight.seriesWinner,undefined,'a single map win must not complete a bo3');
});

test('a nonsense config cannot produce a nonsense series',()=>{
 const series=seriesState(state(1,0,0),{format:'bo3',mr:0,otMr:-4});
 assert.equal(series.mr,12,'mr 0 falls back to the CS2 default');
 assert.equal(series.otPerHalf,3);
 const odd=seriesState(state(1,0,0),{format:'bo7'});
 assert.equal(odd.bestOf,3);
 assert.equal(odd.mapsToWin,2);
 const ahead=seriesState(state(1,0,0,{ctMaps:3,phase:'gameover'}),{format:'bo3'});
 assert.deepEqual(ahead.pips.CT,[true,true],'a map count past mapsToWin must not grow the pips');
});
