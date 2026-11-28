import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig,type TeamConfig} from '../server/config';
import {buildBracket,fetchStartggEvent,parseEventSlug,playableSets,teamFromEntrant,StartggError,type StartggEvent,type StartggSet} from '../server/startgg';

// start.gg import: the link parser, the GraphQL client (against a scripted fetch, never the network)
// and the two pure transforms the panel applies to its draft.

test('event links in every common shape reduce to the API slug',()=>{
 assert.equal(parseEventSlug('https://www.start.gg/tournament/campus-cup-4/event/cs2-5v5/brackets/123/456'),'tournament/campus-cup-4/event/cs2-5v5');
 assert.equal(parseEventSlug('start.gg/tournament/Campus-Cup-4/event/CS2-5v5'),'tournament/campus-cup-4/event/cs2-5v5');
 assert.equal(parseEventSlug('tournament/campus-cup-4/events/cs2-5v5/overview'),'tournament/campus-cup-4/event/cs2-5v5');
 assert.equal(parseEventSlug('https://www.start.gg/tournament/campus-cup-4/details'),null,'a tournament link without an event names no bracket');
 assert.equal(parseEventSlug(''),null);
});

// A scripted start.gg: answers by operation name, records what it was asked.
function scripted(handlers:Record<string,(variables:any)=>any>,status=200){
 const calls:{op:string;variables:any;auth:string|null}[]=[];
 const fetchImpl=(async(_url:string,init:RequestInit)=>{
  const body=JSON.parse(String(init.body));const op=/query (\w+)/.exec(body.query)![1];
  calls.push({op,variables:body.variables,auth:new Headers(init.headers).get('authorization')});
  const answer=handlers[op]?handlers[op](body.variables):{data:{event:null}};
  return new Response(JSON.stringify(answer),{status,headers:{'Content-Type':'application/json'}});
 }) as typeof fetch;
 return {fetchImpl,calls};
}
const set=(id:number,round:number,a:[string|null,number|null,string|null],b:[string|null,number|null,string|null],winner:string|null,state=3,group=7)=>({
 id,round,fullRoundText:round===3?'Grand Final':round===2?'Semi-Final':'Quarter-Final',state,winnerId:winner,phaseGroup:{id:group,displayIdentifier:'1',phase:{name:'Top 8'}},
 slots:[a,b].map(([entrant,score,prereq])=>({prereqType:prereq?'set':'seed',prereqId:prereq,entrant:entrant?{id:entrant,name:`Team ${entrant}`}:null,standing:score===null?null:{stats:{score:{value:score}}}})),
});

test('the client pages through entrants and sets and reduces them, logos best effort',async()=>{
 const {fetchImpl,calls}=scripted({
  ScoutEntrants:({page})=>({data:{event:{id:1,name:'CS2 5v5',tournament:{name:'Campus Cup 4'},entrants:{pageInfo:{totalPages:2},nodes:page===1?[{id:1,name:'Vertex',participants:[{gamerTag:'nova'},{gamerTag:'kite'}]}]:[{id:2,name:'Parallax',participants:[{gamerTag:'zed'}]}]}}}}),
  ScoutSets:()=>({data:{event:{sets:{pageInfo:{totalPages:1},nodes:[set(10,1,['1',2,null],['2',1,null],'1')]}}}}),
  ScoutTeamLogos:()=>({data:{event:{entrants:{nodes:[{id:1,team:{images:[{type:'banner',url:'https://images.start.gg/b.png'},{type:'profile',url:'https://images.start.gg/p.png'}]}},{id:2,team:null}]}}}}),
 });
 const event=await fetchStartggEvent('tournament/campus-cup-4/event/cs2-5v5','tok',fetchImpl);
 assert.equal(event.tournament,'Campus Cup 4');assert.equal(event.name,'CS2 5v5');
 assert.deepEqual(event.entrants.map(e=>[e.name,e.players,e.logoUrl]),[['Vertex',['nova','kite'],'https://images.start.gg/p.png'],['Parallax',['zed'],null]]);
 assert.deepEqual(event.groups,[{id:'7',name:'Top 8 · Pool 1'}]);
 assert.deepEqual(event.sets[0].slots.map(slot=>[slot.entrantId,slot.score]),[['1',2],['2',1]]);
 assert.equal(calls.filter(call=>call.op==='ScoutEntrants').length,2,'both entrant pages were read');
 assert.ok(calls.every(call=>call.auth==='Bearer tok'),'the token travels as a bearer header');
});

test('a logo query error never fails the import',async()=>{
 const {fetchImpl}=scripted({
  ScoutEntrants:()=>({data:{event:{id:1,name:'E',tournament:{name:'T'},entrants:{pageInfo:{totalPages:1},nodes:[{id:1,name:'A',participants:[]}]}}}}),
  ScoutSets:()=>({data:{event:{sets:{pageInfo:{totalPages:1},nodes:[]}}}}),
  ScoutTeamLogos:()=>({errors:[{message:'Cannot query field "team"'}],data:null}),
 });
 const event=await fetchStartggEvent('tournament/t/event/e','tok',fetchImpl);
 assert.equal(event.entrants[0].logoUrl,null);
});

test('missing token, refused token and unknown event are explained, not thrown raw',async()=>{
 await assert.rejects(()=>fetchStartggEvent('tournament/t/event/e','',scripted({}).fetchImpl),(error:any)=>error instanceof StartggError&&error.status===400&&/Import from start.gg/.test(error.message));
 await assert.rejects(()=>fetchStartggEvent('tournament/t/event/e','bad',scripted({},401).fetchImpl),(error:any)=>error.status===401&&/refused the API token/.test(error.message));
 await assert.rejects(()=>fetchStartggEvent('tournament/t/event/e','tok',scripted({ScoutEntrants:()=>({data:{event:null}})}).fetchImpl),(error:any)=>error.status===404);
});

const team=(id:string,name:string,players:string[]=[]):TeamConfig=>({id,name,tag:'',color:'',logo:'',players:players.map(name=>({name,steamid:'',nickname:'',role:'',alias:'',photo:''}))});
const reduce=(raw:any[]):Pick<StartggEvent,'sets'>=>({sets:raw.map(node=>({id:String(node.id),round:node.round,roundText:node.fullRoundText,state:node.state,winnerId:node.winnerId,groupId:String(node.phaseGroup.id),slots:node.slots.map((slot:any)=>({entrantId:slot.entrant?.id??null,name:slot.entrant?.name??null,score:slot.standing?.stats?.score?.value??null,prereqType:slot.prereqType,prereqId:slot.prereqId===null?null:String(slot.prereqId)}))})) as StartggSet[]});

test('a four-team bracket is rebuilt positionally, with results and team bindings',()=>{
 const event=reduce([
  set(3,2,['1',null,'1'],['4',null,'2'],null,2),
  set(1,1,['1',2,null],['2',0,null],'1'),
  set(2,1,['3',1,null],['4',2,null],'4'),
 ]);
 const bracket=buildBracket(event,'7',[team('t1','Team 1'),team('t2','Team 4')],'Campus Cup')!;
 assert.deepEqual(bracket.rounds.map(round=>[round.name,round.matches.length]),[['Quarter-Final',2],['Semi-Final',1]]);
 const [first,second]=bracket.rounds[0].matches;
 assert.deepEqual([first.a.label,first.b.label,first.winner,first.aScore],['Team 1','Team 2','a',2]);
 assert.deepEqual([second.a.label,second.b.label,second.winner],['Team 3','Team 4','b']);
 assert.equal(first.a.team,'t1','an entrant whose name matches a SCOUT team is bound to it');
 assert.equal(bracket.rounds[1].matches[0].status,'live');
 // The host's own normalization agrees with the import: propagation lands the same teams.
 const saved=normalizeConfig({teams:[team('t1','Team 1'),team('t2','Team 4')],maps:[{name:'de_mirage'}],bracket});
 assert.deepEqual([saved.bracket.rounds[1].matches[0].a.label,saved.bracket.rounds[1].matches[0].b.label],['Team 1','Team 4']);
});

test('a bye becomes a decided "vs BYE" match so positions stay honest',()=>{
 // Three teams: team 1 is seeded straight into the final, teams 2 and 3 play for the other slot.
 const event=reduce([
  set(2,2,['1',null,null],[null,null,'1'],null,1),
  set(1,1,['2',2,null],['3',1,null],'2'),
 ]);
 const bracket=buildBracket(event,'7',[])!;
 assert.equal(bracket.rounds.length,2);
 const [bye,real]=bracket.rounds[0].matches;
 assert.deepEqual([bye.a.label,bye.b.label,bye.winner],['Team 1','BYE','a']);
 assert.deepEqual([real.a.label,real.b.label,real.winner],['Team 2','Team 3','a']);
 const saved=normalizeConfig({teams:[team('a','A'),team('b','B')],maps:[{name:'de_mirage'}],bracket});
 assert.deepEqual([saved.bracket.rounds[1].matches[0].a.label,saved.bracket.rounds[1].matches[0].b.label],['Team 1','Team 2']);
});

test('a grand-final reset takes the grand final\'s place, and other brackets are ignored',()=>{
 const event=reduce([
  set(1,1,['1',2,null],['2',1,null],'1'),
  set(2,1,['3',2,null],['4',0,null],'3'),
  set(3,2,['1',2,'1'],['3',3,'2'],'3'),
  set(4,2,['1',3,'3'],['3',1,'3'],'1'),
  set(9,1,['8',2,null],['9',0,null],'8',3,99),
 ]);
 const bracket=buildBracket(event,'7',[])!;
 assert.deepEqual(bracket.rounds.map(round=>round.matches.length),[2,1]);
 assert.equal(bracket.rounds[1].matches[0].id,'sgg-4','the reset decided the bracket');
 assert.equal(bracket.rounds[1].matches[0].winner,'a');
 assert.equal(buildBracket(event,'nope',[]),null);
});

test('an imported team keeps the roster details the operator already added',()=>{
 const current={...team('t1','Vertex',['nova']),tag:'VTX',color:'#ff0000',logo:'uploads/logos/1-v.png'};
 current.players[0]={...current.players[0],steamid:'765',alias:'NOVA',photo:'uploads/players/1-n.png'};
 const same=teamFromEntrant({id:'1',name:'Vertex',players:['Nova','kite'],logoUrl:null},current);
 assert.equal(same.id,'t1');assert.equal(same.tag,'VTX');assert.equal(same.logo,'uploads/logos/1-v.png');
 assert.deepEqual(same.players.map(p=>[p.name,p.steamid,p.alias]),[['nova','765','NOVA'],['kite','','']]);
 const other=teamFromEntrant({id:'2',name:'Parallax',players:['zed'],logoUrl:null},current);
 assert.deepEqual([other.name,other.tag,other.logo,other.color],['Parallax','','','#ff0000'],'a different team drops tag and logo but keeps the slot colour');
});

test('playable matches need both teams, unfinished first',()=>{
 const event=reduce([
  set(1,1,['1',2,null],['2',1,null],'1',3),
  set(2,1,['3',null,null],['4',null,null],null,2),
  set(3,2,['1',null,'1'],[null,null,'2'],null,1),
 ]);
 assert.deepEqual(playableSets(event).map(item=>item.id),['2','1']);
});
