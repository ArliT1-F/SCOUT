import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MatchArchiveStore,MAX_MARKERS,markerTimecode,markersCsv,type MatchArchive} from '../server/recordings.js';
import {normalizeConfig} from '../server/config.js';

// Highlight markers: a timecode list the editor can use, not a video pipeline. The export is the
// product, so the format — and the CSV injection guard that already exists for stats — is pinned here.
const T0=1_700_000_000_000;
const archive=(over:Partial<MatchArchive>={}):MatchArchive=>({
 id:'arc_1',name:'Nova vs Falcons',startedAt:T0,endedAt:T0+3_600_000,event:'Autumn Cup',stage:'Group A',
 teams:['Nova','Falcons'],maps:['de_mirage'],format:'bo1',events:[],
 markers:[
  {id:'mark_2',at:T0+125_500,label:'ace',kind:'kill',round:4,map:'de_mirage',steamid:''},
  {id:'mark_1',at:T0+65_000,label:'pistol',kind:'round',round:1,map:'de_mirage',steamid:''},
 ],...over});

test('a marker becomes an editor timecode, not a wall clock',()=>{
 assert.equal(markerTimecode(T0,T0),'00:00:00.000');
 assert.equal(markerTimecode(T0,T0+65_000),'00:01:05.000');
 assert.equal(markerTimecode(T0,T0+3_600_000+125),'01:00:00.125');
 assert.equal(markerTimecode(T0,T0-5000),'00:00:00.000','a clock skew must not print a negative timecode');
});

test('the CSV is sorted by time and carries the fields an editor needs',()=>{
 const csv=markersCsv(archive());
 const lines=csv.trim().split('\n');
 assert.equal(lines[0],'marker,kind,timecode,seconds,label,map,round,steamid');
 assert.match(lines[1],/^mark_1,round,00:01:05\.000,65\.000,pistol,de_mirage,1,$/);
 assert.match(lines[2],/^mark_2,kill,00:02:05\.500,125\.500,ace,de_mirage,4,$/);
});

test('a label that looks like a spreadsheet formula is neutralised',()=>{
 const csv=markersCsv(archive({markers:[{id:'mark_3',at:T0+1000,label:'=HYPERLINK("http://evil","x")',kind:'manual',round:null,map:'de_mirage',steamid:''}]}));
 assert.match(csv,/'=HYPERLINK/);
 assert.doesNotMatch(csv,/,="?HYPERLINK/);
});

test('markers are added, capped and removed on the archive, and survive a reload',async()=>{
 const file=join(await mkdtemp(join(tmpdir(),'scout-markers-')),'matches.json');
 const store=new MatchArchiveStore(file);
 await store.load();
 const config=normalizeConfig({event:{name:'Autumn Cup',stage:'Group A'},format:'bo1',maps:[{name:'de_mirage'}],teams:[{id:'t1',name:'Nova'},{id:'t2',name:'Falcons'}]});
 const record=store.start('Nova vs Falcons',config,T0);
 const added=store.addMarker(record.id,{id:'mark_1',at:T0+10_000,label:'first blood',kind:'kill',round:1,map:'de_mirage',steamid:''});
 assert.equal(added?.length,1);
 const many=Array.from({length:MAX_MARKERS+25},(_,index)=>({id:`mark_x${index}`,at:T0+index,label:'x',kind:'manual' as const,round:null,map:'de_mirage',steamid:''}));
 for(const marker of many) store.addMarker(record.id,marker);
 assert.equal(store.detail(record.id)?.markers?.length,MAX_MARKERS,'the file must not grow with every click');
 await store.flush();
 const reloaded=new MatchArchiveStore(file);
 await reloaded.load();
 assert.equal(reloaded.detail(record.id)?.markers?.length,MAX_MARKERS);
 assert.equal(reloaded.detail(record.id)?.markers?.[0]?.id,'mark_x25','the cap keeps the newest markers');
 assert.equal(reloaded.removeMarker(record.id,'mark_x25')?.length,MAX_MARKERS-1);
 assert.equal(reloaded.removeMarker('nope','mark_x1'),null);
});
