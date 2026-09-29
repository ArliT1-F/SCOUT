import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {SideTracker,configSides} from '../server/sides';
import {MatchStore} from '../server/state';
import {parseReplay} from '../server/replay';
import type {MatchState} from '../server/state';

// The shipped config/teams.json has empty rosters, so matching rosters is not enough: sides must be
// resolved from GSI names, follow halftime and OT swaps, and stay put across a >5 s reset.
const config={teams:[{id:'a',name:'Vertex',tag:'VTX',color:'#b6a0ff',players:[]},{id:'b',name:'Parallax',tag:'PRX',color:'#d9ee99',players:[]}]};
const map=(ct:string,t:string,name='de_inferno'):MatchState=>({map:{name,phase:'live',round:1,team_ct:{name:ct,score:9},team_t:{name:t,score:7}}});
const rostered={teams:[{id:'a',name:'Vertex',tag:'VTX',players:[{steamid:'1'},{steamid:'2'}]},{id:'b',name:'Parallax',tag:'PRX',players:[{steamid:'3'},{steamid:'4'}]}]};

test('GSI team names bind a config team to a side',()=>{
 const sides=new SideTracker().resolve(map('Vertex','Parallax'),config);
 assert.equal(sides.CT.name,'Vertex');
 assert.equal(sides.T.name,'Parallax');
 assert.equal(sides.source,'names');
 assert.equal(sides.confidence,'engaged');
 assert.equal(sides.CT.color,'#b6a0ff');
});

test('the binding follows the halftime and overtime swaps',()=>{
 const tracker=new SideTracker();
 assert.equal(tracker.resolve(map('Vertex','Parallax'),config).CT.name,'Vertex');
 const halftime=tracker.resolve(map('Parallax','Vertex'),config);
 assert.equal(halftime.CT.name,'Parallax','first half ends, sides swap');
 assert.equal(halftime.T.name,'Vertex');
 assert.equal(halftime.source,'names');
 // Overtime keeps swapping every three rounds; each new block is authoritative.
 assert.equal(tracker.resolve(map('Vertex','Parallax'),config).CT.name,'Vertex','OT period 1');
 assert.equal(tracker.resolve(map('Parallax','Vertex'),config).CT.name,'Parallax','OT half');
 assert.equal(tracker.resolve(map('Vertex','Parallax'),config).CT.name,'Vertex','OT period 2');
});

test('a >5 s reset keeps the binding while the map is unchanged and re-derives on a new map',()=>{
 const tracker=new SideTracker();
 tracker.resolve(map('Parallax','Vertex'),config);
 const bare=tracker.resolve({},config);
 assert.equal(bare.source,'stored','an empty state after a heartbeat gap must not flip the teams');
 assert.equal(bare.CT.name,'Parallax');
 assert.equal(bare.confidence,'inferred');
 const sameMap=tracker.resolve({map:{name:'de_inferno',phase:'live',round:8,team_ct:{name:'',score:9},team_t:{name:'',score:7}}} as any,config) as any;
 assert.equal(sameMap.CT.name,'Parallax','the same map keeps the binding even without names');
 const newMap=tracker.resolve(map('Vertex','Parallax','de_nuke'),config);
 assert.equal(newMap.CT.name,'Vertex','a different map rebinds from the names it does have');
});

test('unknown GSI names fall back to the names CS2 reports, never to config order',()=>{
 const sides=new SideTracker().resolve(map('Team Liquid','FaZe Clan'),config);
 assert.equal(sides.CT.name,'Team Liquid','an unknown name must not be replaced by Vertex');
 assert.equal(sides.T.name,'FaZe Clan');
 assert.equal(sides.confidence,'guess');
 assert.equal(sides.CT.id,'CT:team liquid');
 assert.equal(new SideTracker().resolve({},config).CT.name,'Vertex','with no evidence at all, config order is the last resort');
});

test('rosters resolve the sides when the names are useless',()=>{
 const state={map:{name:'de_mirage',phase:'live',round:1,team_ct:{name:'T1',score:3},team_t:{name:'T2',score:2}},allplayers:{'1':{team:'T'},'2':{team:'T'},'3':{team:'CT'},'4':{team:'CT'}}} as unknown as MatchState;
 const sides=new SideTracker().resolve(state,rostered);
 assert.equal(sides.CT.name,'Parallax','Parallax holds the CT SteamIDs');
 assert.equal(sides.T.name,'Vertex');
 assert.equal(sides.source,'roster');
 // A partial roster cannot claim a side: one SteamID is missing from allplayers, so all that is
 // left is config order — and the result must admit it is a guess.
 const partial={teams:[rostered.teams[0],{...rostered.teams[1],players:[{steamid:'3'},{steamid:'4'},{steamid:'9'}]}]};
 assert.equal(new SideTracker().resolve(state,partial as any).confidence,'guess');
});

test('a config with no matching teams keeps the GSI names, and only configSides guesses',()=>{
 const sides=new SideTracker().resolve(map('Alpha','Bravo'),{teams:[{id:'a',name:'Vertex'},{id:'b',name:'Parallax'}]});
 assert.equal(sides.CT.name,'Alpha','config order must not overwrite a name CS2 reported');
 assert.equal(sides.T.name,'Bravo');
 assert.equal(sides.source,'stand-in');
 assert.equal(sides.confidence,'guess');
 assert.equal(configSides(config).CT.name,'Vertex','the dashboard matchup before any packet uses config order');
 assert.equal(configSides({}).CT.name,'CT');
});

test('the fixture swaps the binding at halftime and keeps it across the map change',async()=>{
 const entries=parseReplay(await readFile(fileURLToPath(new URL('./fixtures/observer-mirage-nuke.jsonl',import.meta.url)),'utf8'));
 const store=new MatchStore(), tracker=new SideTracker(), names:string[]=[];
 const fixture={teams:[{id:'a',name:'Nordwind',tag:'NW',color:'#b6a0ff',players:[]},{id:'b',name:'Solaris',tag:'SOL',color:'#d9ee99',players:[]}]};
 entries.forEach((entry,index)=>{store.ingest(entry.payload as any,entry.receivedAt); const sides=tracker.resolve(store.state,fixture); if(index>20) names.push(`${sides.CT.name}/${sides.T.name}`)});
 assert.equal(new Set(names).size,2,'the second map must resolve both sides, and nothing else');
 assert.ok(names.includes('Nordwind/Solaris'),'first half: Nordwind on CT');
 assert.ok(names.includes('Solaris/Nordwind'),'after halftime: Solaris on CT');
 const final=tracker.resolve(store.state,fixture);
 assert.equal(final.source,'names');
 assert.equal(final.confidence,'engaged');
});
