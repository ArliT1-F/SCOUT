import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {EventTracker,type KillEvent} from '../server/events';
import {MatchStore} from '../server/state';
import {parseReplay} from '../server/replay';

// Derived events are what the killfeed and the round history render, so the tracker is tested on
// synthetic transitions first (repeat, reset, ambiguous packets) and then on the whole fixture.
const player=(name:string,team:'CT'|'T',health:number,extra:any={})=>({steamid:name,name,team,state:{health,armor:100,money:800,round_kills:extra.round_kills??0,round_killhs:extra.round_killhs??0},weapons:extra.weapons??{weapon_0:{name:'weapon_ak47',type:'Rifle',state:'active'}},match_stats:{kills:extra.kills??0,deaths:extra.deaths??0,assists:0}});
const snap=(round:number,phase:string,allplayers:any,extra:any={})=>({map:{name:'de_mirage',phase:'live',round,team_ct:{name:'Nordwind',score:extra.ct??0},team_t:{name:'Solaris',score:extra.t??0}},round:{phase,...(extra.win_team?{win_team:extra.win_team}:{})},allplayers,...(extra.bomb?{bomb:extra.bomb}:{})} as any);

test('a health→0 transition yields one kill credited to the round_kills increment',()=>{
 const tracker=new EventTracker();
 const before=snap(3,'live',{a:player('arvo','CT',100,{round_kills:0}),b:player('susi','T',100)});
 tracker.observe(before,1000);
 const after=snap(3,'live',{a:player('arvo','CT',100,{round_kills:1,round_killhs:1,weapons:{weapon_0:{name:'weapon_awp',type:'Sniper',state:'active'}}}),b:player('susi','T',0)});
 assert.deepEqual(tracker.observe(after,1050).kills,[{id:1,at:1050,round:3,map:'de_mirage',killer:'a',killerName:'arvo',killerSide:'CT',victim:'b',victimName:'susi',victimSide:'T',weapon:'weapon_awp',headshot:true}]);
});

test('repeated packets and an already-dead player never double-count',()=>{
 const tracker=new EventTracker();
 const before=snap(3,'live',{a:player('arvo','CT',100,{round_kills:0}),b:player('susi','T',100)});
 const after=snap(3,'live',{a:player('arvo','CT',100,{round_kills:1}),b:player('susi','T',0)});
 tracker.observe(before,1000); tracker.observe(after,1050);
 assert.equal(tracker.observe(after,1100).kills.length,0,'a repeated packet must not re-emit the kill');
 assert.equal(tracker.observe(after,1150).kills.length,0);
 assert.equal(tracker.kills.length,1);
 assert.equal(tracker.kills[0].headshot,false,'the round_killhs counter did not move');
});

test('an unattributed death still produces a kill with no invented killer',()=>{
 const tracker=new EventTracker();
 tracker.observe(snap(3,'live',{a:player('arvo','CT',100),b:player('susi','T',100)}),1000);
 const kills=tracker.observe(snap(3,'live',{a:player('arvo','CT',100),b:player('susi','T',0)}),1050).kills;
 assert.equal(kills.length,1);
 assert.equal(kills[0].killer,undefined);
 assert.equal(kills[0].victimName,'susi');
});

test('round ends are recorded once with the bomb reason and the winner',()=>{
 const tracker=new EventTracker();
 tracker.observe(snap(5,'live',{a:player('arvo','CT',100),b:player('susi','T',100)}),1000);
 const planted=snap(5,'live',{a:player('arvo','CT',100),b:player('susi','T',100)},{bomb:{state:'planted',countdown:'30.0'}});
 tracker.observe(planted,2000);
 const over=snap(5,'over',{a:player('arvo','CT',0),b:player('susi','T',100)},{win_team:'T',t:1,bomb:{state:'exploded',countdown:'0.0'}});
 const ended=tracker.observe(over,40000).ended;
 assert.equal(ended!.winner,'T');
 assert.equal(ended!.reason,'bomb');
 assert.equal(ended!.tScore,1);
 assert.equal(ended!.startedAt,1000);
 assert.equal(tracker.observe(over,40100).ended,undefined,'the same round end must not repeat');
 assert.equal(tracker.rounds.length,1);
});

test('a defuse is recorded as a defuse, an elimination by the empty roster',()=>{
 const tracker=new EventTracker();
 tracker.observe(snap(2,'live',{a:player('arvo','CT',100),b:player('susi','T',100)}),1000);
 tracker.observe(snap(2,'live',{a:player('arvo','CT',100),b:player('susi','T',100)},{bomb:{state:'defusing',countdown:'12.0'}}),2000);
 assert.equal(tracker.observe(snap(2,'over',{a:player('arvo','CT',100),b:player('susi','T',0)},{win_team:'CT',ct:1,bomb:{state:'defused',countdown:'9.0'}}),3000).ended!.reason,'defuse');
 const wiped=new EventTracker();
 wiped.observe(snap(7,'live',{a:player('arvo','CT',100),b:player('susi','T',100),c:player('noki','T',100)}),1000);
 assert.equal(wiped.observe(snap(7,'over',{a:player('arvo','CT',100),b:player('susi','T',0),c:player('noki','T',0)},{win_team:'CT'}),2000).ended!.reason,'elimination');
});

test('the kill ring keeps only the last 8 events and a reset clears everything',()=>{
 const tracker=new EventTracker();
 let kills=0;
 for(let i=0;i<12;i++){
  tracker.observe(snap(1,'live',{a:player('arvo','CT',100,{round_kills:i}),b:player(`v${i}`,'T',100)}),1000+i*100);
  kills+=tracker.observe(snap(1,'live',{a:player('arvo','CT',100,{round_kills:i+1}),b:player(`v${i}`,'T',0)}),1050+i*100).kills.length;
 }
 assert.equal(kills,12);
 assert.equal(tracker.kills.length,8);
 assert.equal(tracker.kills[7].victimName,'v11');
 tracker.observe(snap(1,'live',{a:player('arvo','CT',100)}),9000,true);
 assert.deepEqual(tracker.snapshot(),{kills:[],rounds:[]});
});

test('replaying the fixture derives every round and kill exactly once',async()=>{
 const entries=parseReplay(await readFile(fileURLToPath(new URL('./fixtures/observer-mirage-nuke.jsonl',import.meta.url)),'utf8'));
 const store=new MatchStore(), tracker=new EventTracker(), derived:KillEvent[]=[];
 entries.forEach(entry=>{const report=store.ingest(entry.payload as any,entry.receivedAt); derived.push(...tracker.observe(store.state,entry.receivedAt,!!report&&report.reset).kills)});
 assert.deepEqual(tracker.rounds.map(event=>[event.map,event.round,event.winner]),[['de_mirage',1,'CT'],['de_mirage',2,'T'],['de_mirage',3,'CT'],['de_mirage',4,'CT'],['de_nuke',1,'CT']]);
 assert.deepEqual(tracker.rounds.map(event=>event.reason),['time','bomb','defuse','time','elimination']);
 const victims=derived.map(kill=>kill.victimName);
 assert.ok(victims.includes('susi')&&victims.includes('ukko'),`expected known deaths, got ${victims}`);
 const deaths=new Set(derived.map(kill=>`${kill.map}:${kill.round}:${kill.victim}`));
 assert.equal(deaths.size,derived.length,'each death must appear exactly once per map and round');
 const killed=derived.find(kill=>kill.victimName==='susi');
 assert.equal(killed!.killerName,'loki','the pistol round kill is credited to Loki');
 assert.ok(tracker.kills.length<=8,`the ring must not grow past 8, got ${tracker.kills.length}`);
});
