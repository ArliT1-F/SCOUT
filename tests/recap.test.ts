import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecap,formatDuration,recapCsv,snapshotFromState} from '../server/recap.js';
import {recapCaption,recapCardSvg,CARD_SIZES} from '../server/recap-card.js';
import {MatchArchiveStore} from '../server/recordings.js';
import {normalizeConfig} from '../server/config.js';
import type {MatchArchive,RoundSnapshot} from '../server/recordings.js';
import type {KillEvent,RoundEvent} from '../server/events.js';

// Recap Kit (docs/LAUNCH-FEATURES.md §4). The archive is the only source: a recap may not invent a
// number, and an archive recorded before snapshots existed must say "not captured" rather than zero.
const kill=(round:number,killer:string,killerName:string,victim:string,victimName:string,headshot=false,at=1_000+round*10):KillEvent=>({round,killer,killerName,victim,victimName,headshot,at} as any);
const round=(round:number,map:string,ct:number,t:number,winner:'CT'|'T',endedAt=1_500+round*10):RoundEvent=>({round,map,ctScore:ct,tScore:t,winner,reason:'elimination',endedAt} as any);
const snapshot=(map:string,round:number,players:Array<Partial<SnapshotSnapshotPlayer>>):RoundSnapshot=>({at:round*100,map,round,players:players.map(player=>({steamid:'1',name:'p',side:'CT',kills:0,deaths:0,assists:0,mvps:0,roundKills:0,roundKillhs:0,roundDamage:0,teamIndex:0,...player}))});
type SnapshotSnapshotPlayer={steamid:string;name:string;side:string;kills:number;deaths:number;assists:number;mvps:number;roundKills:number;roundKillhs:number;roundDamage:number;teamIndex:number};
const archive=(over:Partial<MatchArchive>={}):MatchArchive=>({
 id:'match_1',name:'Autumn Cup final',startedAt:1_000_000,endedAt:1_006_000,
 event:'Autumn Cup',stage:'Final',teams:['Vertex','Parallax'],maps:['de_mirage'],format:'bo3',
 events:[
  {at:1,type:'round',data:round(0,'de_mirage',1,0,'CT')},
  {at:2,type:'kill',data:kill(0,'765','ada','512','grace',true)},
  {at:3,type:'kill',data:kill(0,'765','ada','512','grace')},
  {at:4,type:'kill',data:kill(0,'512','grace','765','ada')},
  {at:5,type:'round',data:round(1,'de_mirage',1,1,'T')},
  {at:6,type:'kill',data:kill(1,'866','linus','765','ada',false)},
  {at:7,type:'round',data:round(2,'de_mirage',2,1,'CT')},
 ],
 ...over,
});

test('a recap is built from the archive and counts what the archive holds',()=>{
 const recap=buildRecap(archive());
 assert.equal(recap.archiveId,'match_1');
 assert.equal(recap.totals.kills,4);
 assert.equal(recap.totals.headshots,1);
 assert.equal(recap.totals.rounds,3);
 assert.equal(recap.totals.maps,1);
 const ada=recap.players.find(player=>player.name==='ada');
 assert.ok(ada);
 assert.equal(ada.kills,2);
 assert.equal(ada.deaths,2);
 assert.equal(ada.headshots,1);
 assert.equal(ada.hsPct,50);
 assert.equal(ada.kd,1);
 assert.equal(ada.assists,null,'no snapshot means assists are unknown, not zero');
 assert.equal(ada.damage,null);
});

test('an archive without snapshots says so instead of pretending',()=>{
 const recap=buildRecap(archive());
 assert.deepEqual(recap.captured,{snapshots:false,assists:false,damage:false});
 assert.equal(recap.players.every(player=>player.assists===null&&player.adr===null),true);
});

test('snapshots fill in assists, MVPs, damage and ADR',()=>{
 const recap=buildRecap(archive({snapshots:[
  snapshot('de_mirage',0,[{steamid:'765',name:'ada',assists:1,mvps:1,roundDamage:180,teamIndex:0}]),
  snapshot('de_mirage',1,[{steamid:'765',name:'ada',assists:2,mvps:1,roundDamage:120,teamIndex:0}]),
 ]}));
 const ada=recap.players.find(player=>player.name==='ada');
 assert.ok(ada);
 assert.equal(ada.assists,2);
 assert.equal(ada.mvps,1);
 assert.equal(ada.damage,300);
 assert.equal(ada.adr,100);
 assert.equal(recap.captured.snapshots,true);
});

test('the map result and the series winner follow the recorded rounds',()=>{
 const recap=buildRecap(archive({snapshots:[snapshot('de_mirage',2,[{steamid:'765',name:'ada',side:'CT',teamIndex:0},{steamid:'512',name:'grace',side:'T',teamIndex:1}])]}));
 assert.equal(recap.maps[0].ctScore,2);
 assert.equal(recap.maps[0].tScore,1);
 assert.equal(recap.maps[0].winnerTeamIndex,0);
 assert.equal(recap.teams[0].mapsWon,1);
 assert.equal(recap.teams[1].mapsWon,0);
 assert.equal(recap.seriesWinner,0);
});

test('the MVP is the top fragger, and the CSV is spreadsheet-safe',()=>{
 const recap=buildRecap(archive());
 assert.equal(recap.mvp?.name,'ada');
 const csv=recapCsv(recap);
 const lines=csv.trim().split('\n');
 assert.equal(lines[0],'player,team,kills,deaths,assists,mvps,headshots,hs_pct,damage,adr,kd');
 assert.ok(lines.length>=4);
 // Without snapshots the archive holds no team binding, so the team column is empty rather than guessed.
 assert.ok(lines[1].startsWith('ada,,2,2,'),lines[1]);
 const injected=recapCsv({...recap,players:[{...recap.players[0],name:'=cmd|calc'}]});
 assert.match(injected,/^player,team.*\n'=cmd\|calc,/m,'a spreadsheet formula is neutralized');
});

test('duration is spoken the way a person would say it',()=>{
 assert.equal(formatDuration(null),'—');
 assert.equal(formatDuration(95_000),'2m');
 assert.equal(formatDuration(3_700_000),'1h 2m');
});

test('the caption and both card sizes are generated from the same recap',()=>{
 const recap=buildRecap(archive());
 const caption=recapCaption(recap,'https://scout.example/t/autumn-cup');
 assert.match(caption,/Autumn Cup/);
 assert.match(caption,/Vertex/);
 assert.match(caption,/https:\/\/scout\.example\/t\/autumn-cup/);
 for(const size of ['feed','story'] as const){
  const svg=recapCardSvg(recap,size);
  assert.match(svg,/^<svg/);
  assert.match(svg,/<\/svg>$/);
  assert.match(svg,new RegExp(`width="${CARD_SIZES[size].width}"`));
  assert.match(svg,new RegExp(`height="${CARD_SIZES[size].height}"`));
  assert.match(svg,/ada/);
 }
 // An archive without captures must not print an invented ADR.
 const bare=recapCardSvg(buildRecap(archive()),'feed');
 assert.equal(/0\.0 ADR/.test(bare),false);
});

test('the archive store keeps one snapshot per round and records a delivery',async()=>{
 const store=new MatchArchiveStore(`/tmp/scout-archive-test-${process.pid}.json`);
 const config=normalizeConfig({name:'Cup',maps:[{name:'de_mirage'}],teams:[{id:'t1',name:'Vertex'},{id:'t2',name:'Parallax'}]});
 const active=store.start('Semi',config,1);
 store.addSnapshot(snapshot('de_mirage',0,[{steamid:'765',name:'ada',roundDamage:100}]));
 store.addSnapshot(snapshot('de_mirage',0,[{steamid:'765',name:'ada',roundDamage:120}]));
 const detail=store.detail(active.id);
 assert.equal(detail?.snapshots?.length,1,'a late duplicate replaces the round, it does not double it');
 assert.equal(detail?.snapshots?.[0].players[0].roundDamage,120);
 store.setDelivery(active.id,{at:2,status:'delivered',target:'discord',detail:'200'});
 assert.equal(store.detail(active.id)?.delivery?.status,'delivered');
 assert.equal(store.list()[0].hasSnapshot,true);
 assert.equal(store.list()[0].delivery?.target,'discord');
});

test('snapshotFromState resolves each player to a team by SteamID',()=>{
 const config=normalizeConfig({name:'Cup',maps:[{name:'de_mirage'}],teams:[{id:'t1',name:'Vertex',players:[{steamid:'76561198000000001',name:'ada'}]},{id:'t2',name:'Parallax'}]});
 const state:any={map:{name:'de_mirage',round:3},allplayers:{'76561198000000001':{name:'ada',team:'CT',match_stats:{kills:5,deaths:2,assists:1,mvps:1},state:{round_kills:1,round_killhs:1,round_totaldmg:120}},'76561198000000009':{name:'stranger',team:'T'}}};
 const snap=snapshotFromState(state,config,9);
 assert.equal(snap.map,'de_mirage');
 assert.equal(snap.players.find(player=>player.name==='ada')?.teamIndex,0);
 assert.equal(snap.players.find(player=>player.name==='stranger')?.teamIndex,-1,'an unlisted player is still counted');
 assert.equal(snap.players.find(player=>player.name==='ada')?.roundDamage,120);
});
