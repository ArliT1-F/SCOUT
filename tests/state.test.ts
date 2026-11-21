import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeDelta,MatchStore} from '../server/state';
test('merges partial nested score updates without losing map metadata',()=>{assert.deepEqual(mergeDelta({map:{name:'de_inferno',team_ct:{score:3,name:'A'}}},{map:{team_ct:{score:4}}}),{map:{name:'de_inferno',team_ct:{score:4,name:'A'}}})});
test('authoritative inventories remove dropped weapons and disconnected players',()=>{assert.deepEqual(mergeDelta({player:{weapons:{old:{name:'ak'},knife:{name:'knife'}}},allplayers:{a:{},b:{}}},{player:{weapons:{knife:{name:'knife'}}},allplayers:{a:{}}}),{player:{weapons:{knife:{name:'knife'}}},allplayers:{a:{}}})});
test('omitted dynamic blocks retained, empty blocks cleared',()=>{assert.deepEqual(mergeDelta({allplayers:{a:{}}},{}),{allplayers:{a:{}}});assert.deepEqual(mergeDelta({grenades:{a:{}}},{grenades:{}}),{grenades:{}})});
test('metadata and dangerous keys are never merged',()=>{const result=mergeDelta({},JSON.parse('{"__proto__":{"polluted":true},"auth":{"token":"secret"},"previously":{"map":{}},"map":{"constructor":1,"round":4}}'));assert.deepEqual(result,{map:{round:4}});assert.equal(({} as any).polluted,undefined)});
test('late packets ignored, reconnects reset stale game data',()=>{const store=new MatchStore();store.ingest({provider:{timestamp:10},round:{phase:'live'}},10000);assert.equal(store.ingest({provider:{timestamp:9}},10050),false);store.ingest({provider:{timestamp:11}},16001);assert.equal(store.state.round,undefined)});
test('map changes clear previous map state',()=>{const store=new MatchStore();store.ingest({provider:{timestamp:1},map:{name:'de_mirage'} as any,allplayers:{a:{} as any}},10000);store.ingest({provider:{timestamp:2},map:{name:'de_inferno'} as any},10050);assert.equal(store.state.allplayers,undefined)});

// CS2 sends `round`, `bomb` and `phase_countdowns` whole and simply leaves out keys that no longer
// apply. Merging them key by key kept last round's winner and bomb outcome alive into the next round.
test('a new round block does not inherit the previous round winner or bomb outcome',()=>{
 const store=new MatchStore();
 store.ingest({provider:{steamid:'obs',timestamp:100},map:{name:'de_mirage',phase:'live',round:3} as any,round:{phase:'over',win_team:'CT',bomb:'exploded'} as any,bomb:{state:'exploded',countdown:'0.0',position:'1, 2, 3'} as any},10000);
 store.ingest({provider:{steamid:'obs',timestamp:101},round:{phase:'freezetime'} as any,bomb:{state:'carried',position:'4, 5, 6'} as any,phase_countdowns:{phase:'freezetime',phase_ends_in:'15'}},10050);
 assert.deepEqual(store.state.round,{phase:'freezetime'});
 assert.deepEqual(store.state.bomb,{state:'carried',position:'4, 5, 6'},'no countdown left over from the planted bomb');
 assert.equal(store.state.map?.name,'de_mirage','map stays merged: CS2 sends partial map updates between packets');
 store.ingest({provider:{steamid:'obs',timestamp:102},player:{steamid:'obs',name:'cam'} as any},10100);
 assert.deepEqual(store.state.round,{phase:'freezetime'},'a packet without a round block keeps the last one');
});

test('a round decided by round_wins is not credited to the previous round winner',async()=>{
 const {EventTracker}=await import('../server/events');
 const store=new MatchStore(),events=new EventTracker();
 const feed=(payload:any,at:number)=>{const result=store.ingest(payload,at);if(result) return events.observe(store.state,at,result.reset)};
 feed({provider:{steamid:'obs',timestamp:1},map:{name:'de_mirage',phase:'live',round:1,team_ct:{score:1},team_t:{score:0},round_wins:{'1':'ct'}},round:{phase:'over',win_team:'CT'}},10000);
 feed({provider:{steamid:'obs',timestamp:2},map:{name:'de_mirage',phase:'live',round:2,team_ct:{score:1},team_t:{score:0},round_wins:{'1':'ct'}},round:{phase:'live'}},10050);
 const ended=feed({provider:{steamid:'obs',timestamp:3},map:{name:'de_mirage',phase:'live',round:2,team_ct:{score:1},team_t:{score:1},round_wins:{'1':'ct','2':'t'}},round:{phase:'over'}},10100)?.ended;
 assert.equal(ended?.winner,'T');
});

test('an older recording replays after the live feed has gone quiet, without a host restart',()=>{
 const store=new MatchStore();
 store.ingest({provider:{steamid:'obs',timestamp:2000},map:{name:'de_nuke'} as any},0);
 assert.equal(store.ingest({provider:{steamid:'other',timestamp:1999},map:{name:'de_nuke'} as any},1000),false,'while the feed is live, an older packet is still dropped — even from a second observer');
 const replay=store.ingest({provider:{steamid:'obs',timestamp:1000},map:{name:'de_mirage'} as any},10*60_000);
 assert.ok(replay,'ten minutes later the older recording is accepted');
 assert.equal(replay&&replay.reset,true);
 assert.equal(store.state.map?.name,'de_mirage');
 assert.ok(store.ingest({provider:{steamid:'obs',timestamp:1001}},10*60_000+50),'and its following packets keep flowing');
});
