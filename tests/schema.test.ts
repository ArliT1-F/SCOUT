import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateGsi} from '../server/schema';
import {mergeDelta,MatchStore} from '../server/state';

// CS2 sends partial payloads at ~20 Hz and stringifies some numbers. Validation must repair what it
// can, drop what it cannot, and never throw — a live broadcast cannot afford a 500 on a bad packet.

test('coerces the strings CS2 sends for numbers',()=>{
 const {payload,issues}=validateGsi({provider:{appid:'730',version:'14056',timestamp:'1750000100'},map:{name:'de_inferno',round:'7',team_ct:{score:'4',consecutive_round_losses:'2'},team_t:{score:'3'}},player:{steamid:'1',state:{health:'100',armor:'100',money:'3400',round_kills:'1',flashed:'12'},weapons:{weapon_0:{name:'weapon_ak47',ammo_clip:'30',ammo_reserve:'90'}},match_stats:{kills:'9',deaths:'4',assists:'2'}},phase_countdowns:{phase:'live',phase_ends_in:'71.4'},bomb:{state:'planted',countdown:'38.6'}});
 assert.deepEqual(issues,[]);
 assert.equal(payload.provider.timestamp,1750000100);
 assert.equal(payload.map.round,7);
 assert.equal(payload.map.team_ct.score,4);
 assert.equal(payload.player.state.money,3400);
 assert.equal(payload.player.weapons.weapon_0.ammo_clip,30);
 assert.equal(payload.phase_countdowns.phase_ends_in,'71.4');
 assert.equal(payload.bomb.countdown,'38.6');
 assert.ok(!('warmup' in payload.map));
});

test('repairs a bad field and keeps the rest of the subtree',()=>{
 const {payload,issues}=validateGsi({map:{name:'de_nuke',round:'not-a-round',team_ct:{score:5},team_t:{score:'x'}},player:{steamid:'1',name:'nova',state:{health:72,money:'lots'},weapons:{weapon_0:{name:'weapon_awp'}}},round:{phase:'live',win_team:''}});
 assert.deepEqual(issues,[{path:'map.round',reason:'expected an integer'},{path:'map.team_t.score',reason:'expected an integer'},{path:'player.state.money',reason:'expected an integer'}]);
 assert.deepEqual(mergeDelta({},payload),{map:{name:'de_nuke',team_ct:{score:5},team_t:{}},player:{steamid:'1',name:'nova',state:{health:72},weapons:{weapon_0:{name:'weapon_awp'}}},round:{phase:'live'}});
});

test('drops a subtree that is not an object and keeps its siblings',()=>{
 const {payload,issues}=validateGsi({map:'de_inferno',round:7,allplayers:['nova'],bomb:null,player:{steamid:'1',name:'observer'},grenades:{g1:'smoke'}});
 assert.deepEqual(issues.map(issue=>issue.path),['map','round','allplayers','bomb','grenades.g1']);
 assert.deepEqual(payload,{player:{steamid:'1',name:'observer'},grenades:{}});
});

test('allplayers keeps valid players and drops only broken entries',()=>{
 const {payload,issues}=validateGsi({allplayers:{ok:{steamid:'1',name:'nova',state:{health:'100'}},wrong:{steamid:'2',observer_slot:'x'},junk:'nova'}});
 assert.deepEqual(issues,[{path:'allplayers.wrong.observer_slot',reason:'expected an integer'},{path:'allplayers.junk',reason:'expected an object'}]);
 assert.deepEqual(Object.keys(payload.allplayers),['ok','wrong']);
 assert.deepEqual(payload.allplayers.wrong,{steamid:'2'});
 assert.equal(payload.allplayers.ok.state.health,100);
});

test('hostile keys are stripped at every depth without polluting prototypes',()=>{
 const raw=JSON.parse('{"map":{"name":"de_nuke","constructor":{"prototype":{"x":1}}},"player":{"steamid":"1","weapons":{"weapon_0":{"name":"ak","__proto__":{"polluted":true}}},"state":{"money":100}},"allplayers":{"1":{"steamid":"1","name":"nova"}},"__proto__":{"polluted":true},"auth":{"token":"secret"},"previously":{"map":{"round":1}},"added":{"allplayers":{"2":{}}},"unknownblock":{"deep":{"__proto__":{"polluted":true},"keep":1}}}');
 const {payload,issues}=validateGsi(raw);
 assert.deepEqual(issues,[]);
 assert.equal(({} as any).polluted,undefined);
 assert.equal(Object.getPrototypeOf(payload),Object.prototype);
 assert.equal(Object.getPrototypeOf(payload.player.weapons.weapon_0),Object.prototype);
 assert.equal(Object.prototype.hasOwnProperty.call(payload.map,'constructor'),false);
 assert.equal(Object.prototype.hasOwnProperty.call(payload.player.weapons.weapon_0,'__proto__'),false);
 assert.deepEqual(payload.unknownblock,{deep:{keep:1}});
 assert.equal('auth' in payload,false);
 assert.equal('previously' in payload,false);
 assert.equal('added' in payload,false);
});

test('never throws on deep or hostile nesting',()=>{
 let deep:any='leaf';
 for(let i=0;i<200;i++) deep={nested:deep};
 const {payload,issues}=validateGsi({map:{name:'de_mirage',team_ct:deep},player:deep,allplayers:deep,round:{deep},grenades:Object.fromEntries(Array.from({length:400},(_,i)=>['g'+i,{type:'smoke',lifetime:String(i)}]))});
 assert.ok(issues.every(issue=>issue.path.startsWith('map.team_ct')||issue.path.startsWith('player')||issue.path.startsWith('allplayers')||issue.path.startsWith('round')));
 assert.equal(payload.map.name,'de_mirage');
 assert.equal(Object.keys(payload.grenades).length,400);
 assert.deepEqual(payload.grenades.g399,{type:'smoke',lifetime:'399'});
});

test('MatchStore reports issues and still merges the valid subtrees of the same packet',()=>{
 const store=new MatchStore();
 const report=store.ingest({provider:{timestamp:100,steamid:'76561198000000000'},map:{name:'de_inferno',round:'7' as any,team_ct:{score:'4' as any}},allplayers:{'1':{steamid:'1',name:'nova',state:{health:'0' as any,money:'bad' as any}}}} as any,10000);
 assert.ok(report&&report.issues.length===1&&report.issues[0].path==='allplayers.1.state.money');
 assert.equal(store.revision,1);
 assert.deepEqual(store.state.map,{name:'de_inferno',round:7,team_ct:{score:4}});
 assert.equal(store.state.allplayers!['1'].state.health,0);
 // A late packet is still rejected and reports no issues, so a repeated payload cannot double-count.
 assert.equal(store.ingest({provider:{timestamp:99},map:{name:'de_mirage',round:'x' as any}} as any,10050),false);
});

test('allplayers entries carry the SteamID they are keyed by, because CS2 does not repeat it inside them',()=>{
 // The shape CS2 really sends: the id is the key and the entry has no steamid of its own.
 const {payload}=validateGsi({player:{steamid:'76561198000000001',name:'observer'},allplayers:{'76561198000000001':{name:'nova',team:'CT',observer_slot:1},'76561198000000002':{name:'kairo',team:'T'}}});
 assert.deepEqual(Object.values<any>(payload.allplayers).map(entry=>entry.steamid),['76561198000000001','76561198000000002']);
 assert.equal(Object.values<any>(payload.allplayers).find(entry=>entry.steamid===payload.player.steamid)?.name,'nova','the observed player is found among allplayers');
 // An entry that already states an id is left alone, and a merge keeps the id on every entry.
 const claimed=validateGsi({allplayers:{a:{steamid:'own-id',name:'x'}}}).payload;
 assert.equal(claimed.allplayers.a.steamid,'own-id');
 assert.equal(mergeDelta({},payload).allplayers['76561198000000002'].steamid,'76561198000000002');
});
