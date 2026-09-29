import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig,propagateBracket,resolveSlotLabel,configSchema,type ScoutConfig} from '../server/config';

// The admin panel owns teams, rosters, the map series and the tournament tree. These tests pin the
// contract behind PUT /api/config: defaults, clamping, id uniqueness and single-elimination
// propagation (match i of round r feeds match floor(i/2) of round r+1).

const base=()=>{
 const raw:any={
  event:{name:'Campus Cup',stage:'Grand final'},
  format:'bo3',
  teams:[
   {id:'a',name:'Vertex',tag:'VTX',color:'#d970c2',logo:'uploads/logos/a.png',players:[{steamid:'1',name:'nova'}]},
   {id:'b',name:'Parallax',tag:'PRX',color:'#e8c97e',logo:'',players:[]},
  ],
  maps:[{name:'de_mirage',pick:'A',score:[13,9],status:'done',image:'uploads/maps/mirage.png'},{name:'de_nuke',pick:'decider',status:'upcoming'}],
  bracket:{title:'Playoffs',rounds:[
   {name:'Semifinals',matches:[
    {id:'sf1',a:{label:'Vertex',team:'a'},b:{label:'Parallax',team:'b'},aScore:2,bScore:0,winner:'a',status:'done'},
    {id:'sf2',a:{label:'Alpha',team:''},b:{label:'Zeta',team:''},aScore:1,bScore:2,winner:'b',status:'done'},
   ]},
   {name:'Final',matches:[{id:'gf'}]},
  ]},
 };
 return raw;
};

test('a valid configuration round-trips with defaults filled in',()=>{
 const config=normalizeConfig(base());
 assert.equal(config.format,'bo3');
 assert.equal(config.mr,12);
 assert.equal(config.otMr,3);
 assert.equal(config.maps[1].pick,'decider');
 assert.deepEqual(config.maps[1].score,undefined);
 assert.equal(config.teams[0].players[0].nickname,'');
 assert.equal(config.bracket.rounds[0].matches[0].winner,'a');
});

test('the tournament tree advances winners positionally into the next round',()=>{
 const config=normalizeConfig(base());
 const final=config.bracket.rounds[1].matches[0];
 // sf1 (index 0) feeds final slot a; sf2 (index 1) feeds final slot b.
 assert.deepEqual(final.a,{label:'Vertex',team:'a'});
 assert.deepEqual(final.b,{label:'Zeta',team:''});
 assert.equal(final.status,'upcoming');
});

test('clearing a winner leaves the next slot alone instead of guessing',()=>{
 const raw=base();
 raw.bracket.rounds[0].matches[0].winner=null;
 const config=normalizeConfig(raw);
 const final=config.bracket.rounds[1].matches[0];
 assert.deepEqual(final.a,{label:'',team:''},'no winner means nothing advanced');
 assert.deepEqual(final.b,{label:'Zeta',team:''},'the other match still propagates');
});

test('setting a winner mid-bracket rewrites the fed slot even if the admin typed something there',()=>{
 const raw=base();
 raw.bracket.rounds[1].matches[0].a={label:'Manual text',team:''};
 raw.bracket.rounds[0].matches[0].winner='b';
 const config=normalizeConfig(raw);
 const final=config.bracket.rounds[1].matches[0];
 assert.deepEqual(final.a,{label:'Parallax',team:'b'},'the match result is the truth');
});

test('duplicate team and match ids are made unique rather than corrupting the editors',()=>{
 const raw=base();
 raw.teams[1].id='a';
 raw.bracket.rounds[1].matches[0].id='sf1';
 const config=normalizeConfig(raw);
 const teamIds=config.teams.map(team=>team.id);
 assert.equal(new Set(teamIds).size,2);
 const matchIds=config.bracket.rounds.flatMap(round=>round.matches.map(match=>match.id));
 assert.equal(new Set(matchIds).size,matchIds.length);
});

test('the schema refuses a one-team league, empty map series and junk formats',()=>{
 assert.throws(()=>normalizeConfig({...base(),teams:[base().teams[0]]}));
 assert.throws(()=>normalizeConfig({...base(),maps:[]}));
 assert.throws(()=>normalizeConfig({...base(),format:'mr12'}));
 assert.throws(()=>normalizeConfig({...base(),maps:[{name:'',status:'upcoming'}]}));
 // Structural junk never parses: bracket matches need unique round shapes at minimum.
 assert.equal(configSchema.safeParse(null).success,false);
});

test('scores are integers within a sane range, not whatever was typed',()=>{
 const raw=base();
 raw.maps[0].score=[13.7,-4];
 assert.throws(()=>normalizeConfig(raw),'a negative or fractional map score is invalid input');
 raw.maps[0].score=[13,9];
 raw.bracket.rounds[0].matches[0].aScore=1000;
 assert.throws(()=>normalizeConfig(raw));
});

test('slot labels resolve through the team binding, with TBD for empty seeds',()=>{
 const config=normalizeConfig(base());
 const teams=config.teams;
 assert.equal(resolveSlotLabel({label:'ignored',team:'a'},teams),'Vertex');
 assert.equal(resolveSlotLabel({label:'Winner SF2',team:''},teams),'Winner SF2');
 assert.equal(resolveSlotLabel({label:'',team:''},teams),'TBD');
 assert.equal(resolveSlotLabel(undefined,teams),'TBD');
 assert.equal(resolveSlotLabel({label:'Ghost',team:'missing'},teams),'Ghost','an unbound team id falls back to the label');
});

test('propagateBracket is idempotent',()=>{
 const config=normalizeConfig(base());
 const once=propagateBracket(config.bracket);
 assert.deepEqual(propagateBracket(once),once);
});
