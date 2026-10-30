// Run of Show (docs/LAUNCH-FEATURES.md §2): a fixture list, a bracket generated from it, and the
// calendar an organiser actually lives in. Everything here is pure — no filesystem, no clock of its
// own — so the panel, the host, the public hub and the tests all agree on what "next" means.
//
// One rule runs through the module: a slot stores an absolute instant (epoch ms). A local time would
// mean one thing on the operator's laptop and another on the venue machine, and a DST change in the
// middle of a tournament would move a match without anybody touching it.
import {propagateBracket,type BracketConfig,type BracketMatch,BracketRound,ScheduleSlot} from './config.js';
import type {SceneId} from './controls.js';

// A match is not a five-minute meeting: the calendar blocks a realistic window per format so an
// organiser's day does not look double-booked. These are planning defaults, never broadcast state.
export const SLOT_DURATION_MS:Record<ScheduleSlot['format'],number>={'bo1':45*60_000,'bo3':90*60_000,'bo5':150*60_000};
export const MAX_SLOTS=64;

export interface SlotWindow extends ScheduleSlot {effectiveAt:number;durationMs:number;endsAt:number}

// Running late is a real, everyday event. The offset applies to slots that have not started yet at
// the moment it is computed — moving a finished match in the past would rewrite history, and moving
// one that is live would make its countdown jump.
export function offsetSlot(slot:ScheduleSlot,offsetMs:number,now:number):SlotWindow {
 const effectiveAt=slot.at>now?slot.at+Math.max(0,offsetMs):slot.at;
 const durationMs=SLOT_DURATION_MS[slot.format];
 return {...slot,effectiveAt,durationMs,endsAt:effectiveAt+durationMs};
}
export function slotWindows(schedule:ScheduleSlot[],offsetMs:number,now:number):SlotWindow[] {
 return schedule.map(slot=>offsetSlot(slot,offsetMs,now)).sort((first,second)=>first.effectiveAt-second.effectiveAt||first.id.localeCompare(second.id));
}
export interface NextUp {next:SlotWindow|null;live:SlotWindow|null;previous:SlotWindow|null}
export function nextUps(schedule:ScheduleSlot[],offsetMs:number,now:number):NextUp {
 const windows=slotWindows(schedule,offsetMs,now);
 const live=windows.find(window=>window.effectiveAt<=now&&window.endsAt>now)||null;
 const next=windows.find(window=>window.effectiveAt>now)||null;
 const previous=[...windows].reverse().find(window=>window.endsAt<=now)||null;
 return {next,live,previous};
}
export function slotLabel(slot:Pick<ScheduleSlot,'a'|'b'>):string {
 const side=(value:ScheduleSlot['a'])=>value.label||value.team||'TBD';
 return `${side(slot.a)} vs ${side(slot.b)}`;
}

// ------------------------------------------------------------------ bracket generation
const SEED_NAMES:Record<number,string[]>={2:['Final'],4:['Semifinals','Final'],8:['Quarterfinals','Semifinals','Final'],16:['Round of 16','Quarterfinals','Semifinals','Final'],32:['Round of 32','Round of 16','Quarterfinals','Semifinals','Final']};
function roundNames(size:number):string[] {
 if(SEED_NAMES[size]) return SEED_NAMES[size];
 const names:string[]=[];
 for(let teams=size;teams>=2;teams/=2) names.push(teams===2?'Final':`Round of ${teams}`);
 return names;
}
// Standard single-elimination seeding: 1 v 8, 4 v 5, 3 v 6, 2 v 7 for a bracket of eight, so the
// top seeds can only meet late. Recursive, so a bracket of 32 needs no second table.
export function seedOrder(size:number):number[] {
 let seeds=[1,2];
 while(seeds.length<size) {
  const nextSize=seeds.length*2;
  const expanded:number[]=[];
  for(const seed of seeds){expanded.push(seed,nextSize+1-seed)}
  seeds=expanded;
 }
 return seeds;
}
export interface GenerateInput {entries:Array<{label:string;team?:string}>;title?:string;format?:ScheduleSlot['format'];startAt?:number;gapMs?:number;makeSlots?:boolean}
export interface GeneratedBracket {bracket:BracketConfig;slots:ScheduleSlot[];byes:number}
// Entries are seeds in order (the panel sorts them, the operator can reorder before generating).
// Sizes that are not a power of two get byes in the first round — a bye is written as a decided
// match, which is exactly how the rest of the product already treats a finished match.
export function generateBracket(input:GenerateInput):GeneratedBracket {
 const entries=input.entries.filter(entry=>entry.label.trim()).slice(0,32);
 if(entries.length<2) throw new Error('A bracket needs at least two teams.');
 let size=2;
 while(size<entries.length) size*=2;
 const names=roundNames(size);
 const order=seedOrder(size);
 const bracketRounds:BracketRound[]=[];
 // Round one: pair seeds, giving a bye (and therefore a winner) when only one side exists.
 const firstRoundMatches:BracketMatch[]=[];
 for(let index=0;index<order.length;index+=2){
  const upper=entries[order[index]-1];
  const lower=entries[order[index+1]-1];
  const match:BracketMatch={id:`r1m${index/2+1}`,a:{label:upper?.label||'BYE',team:upper?.team||''},b:{label:lower?.label||'BYE',team:lower?.team||''},aScore:0,bScore:0,winner:null,status:'upcoming'};
  // A bye is a decided match, not an empty one: it advances the present team without inventing a score.
  if(upper&&!lower){match.winner='a';match.status='done'}
  else if(!upper&&lower){match.winner='b';match.status='done'}
  else if(!upper&&!lower){match.a={label:'BYE',team:''};match.b={label:'BYE',team:''};match.status='done'}
  firstRoundMatches.push(match);
 }
 bracketRounds.push({name:names[0],matches:firstRoundMatches});
 let count=firstRoundMatches.length;
 for(let round=1;round<names.length;round++){
  count/=2;
  const matches:BracketMatch[]=[];
  for(let index=0;index<count;index++) matches.push({id:`r${round+1}m${index+1}`,a:{label:'',team:''},b:{label:'',team:''},aScore:0,bScore:0,winner:null,status:'upcoming'});
  bracketRounds.push({name:names[round],matches});
 }
 // propagateBracket writes every bye's winner forward, so round two already knows who is waiting.
 const bracket=propagateBracket({title:input.title||'',rounds:bracketRounds});
 const slots:ScheduleSlot[]=[];
 if(input.makeSlots!==false){
  const startAt=input.startAt??Date.now();
  const gapMs=Math.max(SLOT_DURATION_MS[input.format||'bo3'],input.gapMs??SLOT_DURATION_MS[input.format||'bo3']);
  const playable=firstRoundMatches.filter((match,index)=>entries[order[index*2]-1]&&entries[order[index*2+1]-1]);
  playable.forEach((match,index)=>{
   slots.push({id:`slot-${match.id}`,at:startAt+index*gapMs,a:{team:match.a.team,label:match.a.label},b:{team:match.b.team,label:match.b.label},stage:names[0],format:input.format||'bo3',stream:'',note:'',bracketMatchId:match.id});
  });
 }
 // A bye is a first-round match with exactly one real team and one empty side.
 const byes=firstRoundMatches.filter(match=>(match.a.label==='BYE')!==(match.b.label==='BYE')).length;
 return {bracket,slots,byes};
}

// ------------------------------------------------------------------ calendar (ICS, RFC 5545)
// Only what an organiser's phone needs: when, what, and where to watch. `escapeIcs` is the RFC's own
// rule (backslash, semicolon, comma and newline), applied to every free-text field without exception.
export function escapeIcs(value:string):string {
 return String(value??'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
}
const pad=(value:number,width=2)=>String(value).padStart(width,'0');
function icsStamp(at:number):string {
 const date=new Date(at);
 // UTC on purpose: the calendar app renders it in the reader's own zone, which is the only honest
 // way to schedule a match for an international crew.
 return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
function foldIcsLine(line:string):string {
 // RFC 5545 says 75 octets, and a long team name is exactly the thing that breaks a strict parser.
 if(Buffer.byteLength(line)<=74) return line;
 const parts:string[]=[];let current='';
 for(const character of line){if(Buffer.byteLength(current+character)>73){parts.push(current);current=character}else current+=character}
 if(current) parts.push(current);
 return parts.join('\r\n ');
}
export interface IcsOptions {calendarName:string;slots:ScheduleSlot[];offsetMs?:number;now?:number;baseUrl?:string;productId?:string}
export function buildIcs(options:IcsOptions):string {
 const now=options.now??Date.now(),offset=options.offsetMs??0;
 const windows=slotWindows(options.slots,offset,now);
 const lines:string[]=['BEGIN:VCALENDAR','VERSION:2.0',`PRODID:${options.productId||'-//SCOUT//Run of Show//EN'}`,'CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${escapeIcs(options.calendarName)}`];
 for(const window of windows){
  const summary=slotLabel(window)+(window.stage?` · ${window.stage}`:'');
  const description=[window.stage?`Stage: ${window.stage}`:'',`Format: ${window.format.toUpperCase()}`,window.stream?`Watch: ${window.stream}`:'',window.note?window.note:''].filter(Boolean).join('\n');
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${escapeIcs(window.id)}@scout`);
  lines.push(`DTSTAMP:${icsStamp(now)}`);
  lines.push(`DTSTART:${icsStamp(window.effectiveAt)}`);
  lines.push(`DTEND:${icsStamp(window.endsAt)}`);
  lines.push(foldIcsLine(`SUMMARY:${escapeIcs(summary)}`));
  if(description) lines.push(`DESCRIPTION:${escapeIcs(description)}`);
  if(window.stream) lines.push(`URL:${escapeIcs(window.stream)}`);
  lines.push('END:VEVENT');
 }
 lines.push('END:VCALENDAR');
 return lines.join('\r\n')+'\r\n';
}

// ------------------------------------------------------------------ break helper
// "Next match in 12 minutes" is the one thing an operator wants to see while a series is finishing.
export function minutesUntil(at:number,now:number):number {
 return Math.max(0,Math.ceil((at-now)/60_000));
}
export interface BreakSuggestion {at:number;minutes:number;label:string;stage:string;slotId:string}
export function suggestBreak(schedule:ScheduleSlot[],offsetMs:number,now:number):BreakSuggestion|null {
 const {next}=nextUps(schedule,offsetMs,now);
 if(!next) return null;
 return {at:next.effectiveAt,minutes:minutesUntil(next.effectiveAt,now),label:slotLabel(next),stage:next.stage,slotId:next.id};
}
// The scene an operator would want when the next fixture is close. Deliberately a suggestion for the
// panel and the auto-pilot rules, never a transition decided by the schedule module itself.
export const SLOT_SOON_MS=15*60_000;
export function slotIsSoon(schedule:ScheduleSlot[],offsetMs:number,now:number,withinMs=SLOT_SOON_MS):SlotWindow|null {
 const {next}=nextUps(schedule,offsetMs,now);
 if(!next) return null;
 const delta=next.effectiveAt-now;
 return delta>=0&&delta<=withinMs?next:null;
}
export type {SceneId};
