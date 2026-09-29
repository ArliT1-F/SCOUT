import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {MatchStore} from '../server/state';
import {parseReplay,planDelays,parseArgs,defaultOptions} from '../server/replay';

// Sanitized observer capture (20 Hz, partial blocks, invented names) shared by the schema, merge and
// phase tests, so they run against a realistic sequence instead of hand-written objects.
const path=fileURLToPath(new URL('./fixtures/observer-mirage-nuke.jsonl',import.meta.url));
const entries=parseReplay(await readFile(path,'utf8'));
function replayInto(store:MatchStore){
 return entries.map(entry=>store.ingest(entry.payload as any,entry.receivedAt));
}

test('the sanitized fixture is a well-formed 20 Hz recording',()=>{
 assert.ok(entries.length>=25,'fixture should hold a full round sequence');
 assert.deepEqual(planDelays(entries,1).slice(0,3),[0,50,200]);
 assert.ok(entries.every(entry=>entry.payload.provider?.timestamp),'every accepted packet needs a provider timestamp');
 const ids=JSON.stringify(entries);
 assert.equal(ids.includes('CHANGE_ME'),false,'fixture must not carry a real token');
 assert.match(ids,/76561190000/,'fixture uses invented SteamIDs');
});

test('every fixture packet validates without a single repaired field',()=>{
 const store=new MatchStore(), reports=replayInto(store);
 const issues=reports.flatMap(report=>report?report.issues:[]);
 assert.deepEqual(issues,[],'fixture must be schema-clean; a failure here means the fixture or the schema drifted');
 assert.equal(store.revision,entries.length);
});

test('replaying the fixture drives the match through a round, a defuse, halftime and a map change',()=>{
 const store=new MatchStore(); replayInto(store);
 const state=store.state;
 assert.equal(state.map!.name,'de_nuke','last map wins');
 assert.equal(state.map!.phase,'gameover');
 assert.equal(state.map!.team_ct!.name,'Solaris','sides swap at halftime');
 assert.equal(state.map!.team_t!.name,'Nordwind');
 assert.equal(state.map!.team_ct!.score,1);
 assert.equal(Object.keys(state.allplayers!).length,10,'allplayers stays authoritative across the replay');
 assert.equal(state.round!.win_team,'CT');
 assert.equal(state.bomb,undefined,'a map change clears the previous map, bomb included');
 // Mid-replay: the defuse is retained while later packets omit the bomb block.
 const earlier=new MatchStore(); entries.slice(0,24).forEach(entry=>earlier.ingest(entry.payload as any,entry.receivedAt));
 assert.equal(earlier.state.bomb!.state,'defused','bomb state survives the packets that omit it');
 assert.equal(earlier.state.map!.name,'de_mirage');
 assert.deepEqual((earlier.state.map as any).round_wins['3'],'ct','unknown GSI keys survive validation for the round-history work');
});

test('the fixture records the transitions the killfeed and phase work need',()=>{
 const deaths:string[]=[], plants:number[]=[], rounds:any[]=[];
 entries.forEach(entry=>{
  const payload:any=entry.payload;
  if(payload.allplayers) for(const player of Object.values<any>(payload.allplayers)) if(player.state?.health===0) deaths.push(player.name);
  if(payload.bomb?.state==='planted') plants.push(entry.receivedAt);
  if(payload.round?.phase==='over') rounds.push(payload.round.win_team);
 });
 assert.ok(deaths.length>=5,'expected health→0 transitions to derive kills from');
 assert.ok(plants.length>=3,'expected a carried → planted sequence');
 assert.ok(deaths.length>=15,'expected repeated health→0 transitions');
 assert.deepEqual(rounds,['CT','T','CT','CT','T','T','CT'],'round winners in order: four rounds, the two halftime score lines, then the gameover packet');
});

test('replay timing scales with --speed and honours --max-gap',()=>{
 assert.deepEqual(planDelays(entries,2).slice(0,3),[0,25,100]);
 assert.deepEqual(planDelays([{receivedAt:0,payload:{}},{receivedAt:60000,payload:{}},{receivedAt:60050,payload:{}}],1,2000),[0,2000,50]);
 assert.deepEqual(planDelays([{receivedAt:100,payload:{}},{receivedAt:50,payload:{}}],1),[0,0],'out-of-order stamps never wait');
});

test('replay arguments are validated before anything runs',()=>{
 assert.deepEqual(parseArgs(['rec.jsonl']).options,defaultOptions);
 assert.equal(parseArgs(['rec.jsonl','--speed','4','--limit=10']).options.speed,4);
 assert.equal(parseArgs(['rec.jsonl','--limit=10']).options.limit,10);
 assert.throws(()=>parseArgs([]),/expected a recording file/);
 assert.throws(()=>parseArgs(['rec.jsonl','--speed','0']),/speed must be greater than 0/);
 assert.throws(()=>parseArgs(['rec.jsonl','--nope','1']),/unknown option --nope/);
 assert.throws(()=>parseArgs(['rec.jsonl','--url']),/missing value for --url/);
 assert.throws(()=>parseReplay('{"payload":{}}'),/not a SCOUT recording entry/);
 assert.throws(()=>parseReplay('{oops}'),/not valid JSON/);
 assert.throws(()=>parseReplay('\n\n'),/contains no packets/);
});
