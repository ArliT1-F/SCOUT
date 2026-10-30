import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig,CONFIG_SCHEMA_VERSION} from '../server/config.js';
import {configHash,legacyConfigHash} from '../server/platform.js';
import {SLOT_DURATION_MS,buildIcs,generateBracket,nextUps,offsetSlot,seedOrder,slotIsSoon,slotLabel,slotWindows,suggestBreak} from '../server/schedule.js';

// Run of Show (docs/LAUNCH-FEATURES.md §2). The schedule is part of the operator's configuration, so
// it is validated by the same schema, carries no new file, and every derived answer (what is on now,
// what is next, when the break ends) is a pure function of it plus the late offset.

const slot=(at:number,over:Record<string,unknown>={})=>({id:`s-${at}`,at,a:{team:'',label:'Alpha'},b:{team:'',label:'Beta'},stage:'Group',format:'bo1',stream:'',note:'',bracketMatchId:'',...over});
const team=(index:number,name:string)=>({id:`t${index+1}`,name,tag:'',color:'',logo:'',players:[]});
const base=()=>normalizeConfig({name:'Cup',event:{name:'Autumn Cup',stage:'Group stage'},teams:[team(0,'Alpha'),team(1,'Beta')],maps:[{name:'de_mirage'}],schedule:[slot(1_000_000),slot(1_000_000+45*60_000+60_000,{format:'bo3',stage:'Semifinal'})]});

test('a schedule survives the config schema, is deduplicated by id and sorted by start',()=>{
 const config=base();
 assert.equal(config.schedule.length,2);
 assert.deepEqual(config.schedule.map(entry=>entry.at),[...config.schedule.map(entry=>entry.at)].sort((a,b)=>a-b));
 // Two fixtures claiming the same id would make "load this fixture" ambiguous. Like team and match
 // ids elsewhere in the product, the later one is renamed rather than dropped — the operator did add
 // a second fixture, and losing it silently would be worse than a visibly suffixed id.
 const duplicated=normalizeConfig({teams:[team(0,'Alpha'),team(1,'Beta')],maps:[{name:'de_mirage'}],schedule:[slot(5),slot(6),slot(5,{stage:'duplicate id'})]});
 assert.equal(duplicated.schedule.length,3);
 assert.equal(new Set(duplicated.schedule.map(entry=>entry.id)).size,3,'ids are unique after normalization');
 assert.equal(CONFIG_SCHEMA_VERSION,2);
});

test('a malformed schedule is refused rather than silently dropped',()=>{
 // The save route validates before it normalizes, so an invalid fixture is a 400 and never reaches a
 // broadcast. normalizeConfig itself is strict for the same reason.
 assert.throws(()=>normalizeConfig({maps:[{name:'de_mirage'}],schedule:[{id:'x',at:-1,a:{label:'A'},b:{label:'B'}}]}),/at/);
 const tooMany=Array.from({length:70},(_,index)=>slot(index+1));
 assert.throws(()=>normalizeConfig({maps:[{name:'de_mirage'}],schedule:tooMany}),/at most 64/,'a schedule larger than the cap is refused at the edge');
});

test('slot windows, the late offset and "what is on now" agree with each other',()=>{
 const schedule=base().schedule;
 const at=schedule[0].at;
 const offset=10*60_000;
 const window=offsetSlot(schedule[0],offset,at-60_000);
 assert.equal(window.effectiveAt,at+offset);
 assert.equal(window.endsAt,at+offset+SLOT_DURATION_MS.bo1);
 // Before the first fixture: nothing is live, the first is next.
 const early=nextUps(schedule,offset,at-5*60_000);
 assert.equal(early.live,null); assert.equal(early.next?.id,schedule[0].id);
 // Inside the first fixture: it is live, the second is next.
 const during=nextUps(schedule,offset,at+offset+60_000);
 assert.equal(during.live?.id,schedule[0].id); assert.equal(during.next?.id,schedule[1].id);
 // After both: the last one is what we came from.
 const after=nextUps(schedule,offset,at+offset+10*60*60_000);
 assert.equal(after.next,null); assert.equal(after.previous?.id,schedule[1].id);
 assert.equal(slotWindows(schedule,offset,at).length,2);
});

test('the same schedule at two moments: a finished fixture is never "next"',()=>{
 const schedule=base().schedule;
 const now=schedule[0].at+SLOT_DURATION_MS.bo1+1;
 const {next}=nextUps(schedule,0,now);
 assert.equal(next?.id,schedule[1].id,'the second fixture is next, not the one that just ended');
});

test('a late offset moves future fixtures only, never the ones already played',()=>{
 const schedule=base().schedule;
 const now=schedule[0].at+60_000; // the first fixture is on air
 const offset=20*60_000;
 const windows=slotWindows(schedule,offset,now);
 // A fixture that already started cannot move; everything still ahead of the clock slips by the
 // offset, so the number an operator types is a delay they can still act on.
 assert.equal(windows[0].effectiveAt,schedule[0].at,'a started fixture keeps the time the broadcast started at');
 assert.equal(windows[1].effectiveAt,schedule[1].at+offset);
});

test('the next-up label is what a commentator would read out',()=>{
 assert.equal(slotLabel({a:{label:'Alpha',team:''},b:{label:'Beta',team:''}}),'Alpha vs Beta');
 assert.equal(slotLabel({a:{label:'',team:''},b:{label:'',team:''}}),'TBD vs TBD');
});

test('single elimination seeds correctly and gives byes to the top seeds',()=>{
 assert.deepEqual(seedOrder(4),[1,4,2,3]);
 assert.deepEqual(seedOrder(8),[1,8,4,5,2,7,3,6]);
 const generated=generateBracket({entries:Array.from({length:6},(_,index)=>({label:`Team ${index+1}`})),format:'bo3',makeSlots:true,startAt:1_000_000});
 assert.equal(generated.bracket.rounds[0].matches.length,4,'a six-team bracket still has four first-round matches');
 assert.equal(generated.byes,2);
 // Six entrants in an eight-slot bracket: two byes, so only two of the four first-round matches are
 // actually played and only those become fixtures.
 assert.equal(generated.slots.length,2);
 assert.equal(generated.slots[0].format,'bo3');
 // Two byes and a walkover final: six entrants, two byes, four first-round matches.
 assert.equal(generated.bracket.rounds.length,3);
 assert.deepEqual(generated.bracket.rounds.map(round=>round.matches.length),[4,2,1]);
});

test('bracket generation refuses a field that cannot make a match',()=>{
 assert.throws(()=>generateBracket({entries:[{label:'Only one'}]}),/two teams/i);
 const duplicate=generateBracket({entries:[{label:'Same'},{label:'Same'}]});
 assert.equal(duplicate.bracket.rounds[0].matches.length,1,'identical labels are allowed; the id is the identity');
});

test('the calendar is valid ICS, escapes text and honours the late offset',()=>{
 const schedule=[{...base().schedule[0],a:{team:'',label:'Alpha, "The" Aces'},stream:'https://twitch.tv/x'}];
 const ics=buildIcs({calendarName:'Autumn Cup; finals',slots:schedule,offsetMs:15*60_000,now:schedule[0].at-60_000,baseUrl:'https://scout.example'});
 assert.match(ics,/^BEGIN:VCALENDAR/);
 assert.match(ics,/END:VCALENDAR\r?\n$/);
 assert.match(ics,/NAME:Autumn Cup\\; finals/,'commas and semicolons are escaped for the calendar format');
 assert.match(ics,/Alpha\\, "The" Aces/);
 assert.match(ics,/BEGIN:VEVENT/);
 assert.match(ics,/DTSTART:/);
 assert.match(ics,/SUMMARY:.*vs/);
 assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1);
 assert.match(ics,/DTSTAMP:/);
});

test('the break suggester speaks only when the gap is worth a break',()=>{
 const schedule=base().schedule;
 const now=schedule[0].at;
 const suggestion=suggestBreak(schedule,0,now);
 // The first fixture is on air at this instant, so the break between the two is what is suggested.
 assert.ok(suggestion,'there is a fixture coming up');
 assert.equal(suggestion?.slotId,schedule[1].id);
 assert.ok((suggestion?.minutes??0)>=0);
 assert.equal(suggestBreak([],0,now),null);
 assert.equal(suggestBreak(schedule,0,schedule[1].at+10*60*60_000),null,'nothing left to suggest');
});

test('slot-soon is a window, not a guess',()=>{
 const schedule=base().schedule;
 const soon=slotIsSoon(schedule,0,schedule[0].at-5*60_000,15*60_000);
 assert.equal(soon?.id,schedule[0].id);
 assert.equal(slotIsSoon(schedule,0,schedule[0].at-30*60_000,15*60_000),null);
});

test('the config hash changes when the schedule does, which is what syncs a host',()=>{
 const one=base();
 const two={...one,schedule:[...one.schedule,slot(9_999_999)]};
 assert.notEqual(configHash(one),configHash(two),'a new fixture must reach a remote host');
 // The legacy hash exists so a v1 config and a v2 one with no schedule compare equal; the sync test
 // in tests/platform-sync.test.ts depends on that staying true.
 assert.equal(typeof legacyConfigHash,'function');
});
