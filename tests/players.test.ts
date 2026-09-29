import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toSteamId64,buildRoster,identify,shownName,splitRoster,cardOf,isBench} from '../server/players';
import {normalizeConfig,configSchema,playerSchema,type ScoutConfig} from '../server/config';
import {referencedUploads,isPrunable,UPLOAD_GRACE_MS,UPLOAD_DIRS} from '../server/uploads';

// Player photos and alias overrides. The contract: a SteamID is exact, a name is only a fallback that
// refuses to guess, and only an explicit alias ever replaces the name CS2 reports.

const NOVA='76561198000000001', KAIRO='76561198000000002';
const config=(over:Partial<any>={}):ScoutConfig=>normalizeConfig({
 teams:[
  {id:'a',name:'Vertex',players:[
   {steamid:NOVA,name:'nova',alias:'Nova',nickname:'Elias Nord',role:'IGL',photo:'uploads/players/1-nova.png'},
   {steamid:'',name:'kairo',nickname:'Kai Rönning',role:'AWP'},
   {name:'Coach Q',role:'Head Coach'},
  ]},
  {id:'b',name:'Parallax',players:[
   {steamid:KAIRO,name:'EXO',alias:'exo'},
   {steamid:'',name:'kairo'},
  ]},
 ],
 maps:[{name:'de_mirage',image:'uploads/maps/1-mirage.png'}],
 ...over,
});

test('SteamID64 passes through and the common alternative formats convert to it',()=>{
 assert.equal(toSteamId64('76561198000000001'),'76561198000000001');
 // [U:1:N] is base + N, and STEAM_X:Y:Z is base + 2Z + Y — these pairs are the same account.
 assert.equal(toSteamId64('[U:1:1]'),'76561197960265729');
 assert.equal(toSteamId64('U:1:2'),'76561197960265730');
 assert.equal(toSteamId64('STEAM_0:1:0'),'76561197960265729');
 assert.equal(toSteamId64('STEAM_1:0:1'),'76561197960265730');
 assert.equal(toSteamId64('STEAM_0:0:500000'),toSteamId64('[U:1:1000000]'));
 assert.equal(toSteamId64('  https://steamcommunity.com/profiles/76561198000000001/  '),'76561198000000001');
});

test('anything that is not a recognisable SteamID is rejected instead of guessed',()=>{
 for(const bad of ['','  ','nova','12345','STEAM_0:2:5','STEAM_9:0:1','[U:2:5]','https://steamcommunity.com/id/vanity','7656119800000000','765611980000000011',undefined as any,null as any,42 as any])
  assert.equal(toSteamId64(bad),undefined,String(bad));
});

test('a player is recognised by SteamID whatever format the roster was typed in',()=>{
 const roster=buildRoster(config({teams:[
  {id:'a',name:'Vertex',players:[{name:'nova',alias:'Nova',steamid:'STEAM_0:0:20000000'}]},
  {id:'b',name:'Parallax',players:[]},
 ]}));
 const id=toSteamId64('STEAM_0:0:20000000')!;
 assert.equal(identify(roster,{steamid:id,name:'whatever CS2 says'})?.player.name,'nova');
 assert.equal(shownName(roster,{steamid:id,name:'whatever CS2 says'}),'Nova');
});

test('the config normalizer stores SteamIDs in the form GSI reports',()=>{
 const stored=normalizeConfig({teams:[
  {id:'a',name:'A',players:[{name:'x',steamid:'[U:1:1]'},{name:'y',steamid:'not an id'},{name:'z',steamid:'76561198000000001'}]},
  {id:'b',name:'B',players:[]},
 ],maps:[{name:'de_nuke'}]});
 assert.deepEqual(stored.teams[0].players.map(player=>player.steamid),['76561197960265729','not an id','76561198000000001']);
});

test('SteamID is exact and beats a name that happens to match somebody else',()=>{
 const roster=buildRoster(config());
 // EXO's SteamID identifies EXO even when CS2 reports the name "nova" (a different rostered player).
 assert.equal(identify(roster,{steamid:KAIRO,name:'nova'})?.player.name,'EXO');
});

test('without a SteamID a player is matched by folded name, alias included',()=>{
 const roster=buildRoster(config());
 assert.equal(identify(roster,{steamid:'0',name:'  NOVA '})?.player.name,'nova');
 assert.equal(identify(roster,{name:'exo'})?.team.id,'b');
 // Full-width look-alikes fold to the same name.
 assert.equal(identify(roster,{name:'ｎｏｖａ'})?.player.name,'nova');
 assert.equal(identify(roster,{name:'somebody else'}),undefined);
 assert.equal(identify(roster,{name:''}),undefined);
 assert.equal(identify(roster,{}),undefined);
});

test('an ambiguous name resolves to nobody unless the side gives a tiebreak',()=>{
 const roster=buildRoster(config());
 assert.equal(identify(roster,{name:'kairo'}),undefined,'both teams have a kairo — guessing would mislabel one of them');
 assert.equal(identify(roster,{name:'kairo'},'a')?.team.id,'a');
 assert.equal(identify(roster,{name:'kairo'},'b')?.team.id,'b');
 assert.equal(identify(roster,{name:'kairo'},'nope'),undefined);
});

test('only an explicit alias replaces the in-game name',()=>{
 const roster=buildRoster(config());
 assert.equal(shownName(roster,{steamid:NOVA,name:'xX_n0va_Xx'}),'Nova','alias wins over what CS2 reports');
 assert.equal(shownName(roster,{steamid:'0',name:'kairo'},'a'),'kairo','matched but no alias: the in-game name is kept as reported');
 assert.equal(shownName(roster,{steamid:'9',name:'random'}),'random','unmatched players are untouched');
 assert.equal(shownName(roster,{steamid:'9'}),'','no name and no match is an empty string, not a placeholder');
 assert.equal(shownName(buildRoster(undefined),{name:'nova'}),'nova','no config at all still works');
 assert.equal(shownName(buildRoster(null),{name:'nova'}),'nova');
});

test('duplicate SteamIDs keep the first entry instead of flapping',()=>{
 const roster=buildRoster(config({teams:[
  {id:'a',name:'A',players:[{name:'first',steamid:NOVA}]},
  {id:'b',name:'B',players:[{name:'second',steamid:NOVA}]},
 ]}));
 assert.equal(identify(roster,{steamid:NOVA})?.player.name,'first');
});

test('cards carry the on-air name, real name, role and portrait for the scenes',()=>{
 const roster=buildRoster(config());
 const card=cardOf(identify(roster,{steamid:NOVA})!);
 assert.deepEqual(card,{name:'Nova',realName:'Elias Nord',role:'IGL',photo:'uploads/players/1-nova.png',steamid:NOVA,teamId:'a'});
 // No alias: the handle. No handle either: the real name rather than an empty card.
 assert.equal(cardOf({team:config().teams[0],player:{name:'',nickname:'Real Person',steamid:'',role:'',alias:'',photo:''}}).name,'Real Person');
});

test('coaches and substitutes are bench, the first five players are the starters',()=>{
 assert.equal(isBench({role:'Head Coach'}),true);
 assert.equal(isBench({role:'IGL / Sub'}),true);
 assert.equal(isBench({role:'Stand-in'}),true);
 assert.equal(isBench({role:'Entry'}),false);
 assert.equal(isBench({role:'Substitution expert'}),false,'a word boundary, not a substring, decides');
 const team:any={id:'t',name:'T',players:[
  ...['a','b','c','d','e','f'].map(name=>({name,role:'',steamid:'',nickname:'',alias:'',photo:''})),
  {name:'boss',role:'Coach',steamid:'',nickname:'',alias:'',photo:''},
 ]};
 const {starters,bench}=splitRoster(team);
 assert.deepEqual(starters.map(card=>card.name),['a','b','c','d','e']);
 assert.deepEqual(bench.map(card=>card.name),['f','boss']);
 assert.deepEqual(splitRoster({id:'x',name:'x',players:[]} as any),{starters:[],bench:[]});
});

test('alias and photo default to empty and old configs keep loading',()=>{
 const parsed=playerSchema.parse({name:'nova'});
 assert.equal(parsed.alias,'');assert.equal(parsed.photo,'');
 const loaded=normalizeConfig({teams:[{id:'a',name:'A',players:[{name:'old',nickname:'Old Timer',role:'IGL',steamid:''}]},{id:'b',name:'B'}],maps:[{name:'de_nuke'}]});
 assert.deepEqual(loaded.teams[0].players[0],{name:'old',nickname:'Old Timer',role:'IGL',steamid:'',alias:'',photo:''});
});

test('a portrait must be a file this host uploaded for players',()=>{
 for(const good of ['','uploads/players/1712345678901-nova.png','uploads/players/a b.webp'])
  assert.equal(playerSchema.safeParse({name:'x',photo:good}).success,true,good);
 for(const bad of ['uploads/logos/a.png','uploads/players/../../../etc/passwd','../uploads/players/a.png','http://evil.example/a.png','/uploads/players/a.png','uploads/players/','javascript:alert(1)','uploads/players/a/b.png'])
  assert.equal(playerSchema.safeParse({name:'x',photo:bad}).success,false,bad);
 assert.equal(configSchema.safeParse({teams:[{id:'a',name:'A',players:[{name:'x',photo:'nope'}]},{id:'b',name:'B'}],maps:[{name:'de_nuke'}]}).success,false);
});

test('a roster row with only an alias or portrait is still a blank row and is dropped',()=>{
 const saved=normalizeConfig({teams:[{id:'a',name:'A',players:[{alias:'ghost',photo:'uploads/players/1-x.png'},{name:'real'}]},{id:'b',name:'B'}],maps:[{name:'de_nuke'}]});
 assert.deepEqual(saved.teams[0].players.map(player=>player.name),['real']);
});

test('every upload a saved config references is protected from pruning, portraits included',()=>{
 const refs=referencedUploads(config({teams:[
  {id:'a',name:'A',logo:'uploads/logos/1-a.png',players:[{name:'n',photo:'uploads/players/1-n.png'}]},
  {id:'b',name:'B',logo:'https://cdn.example/b.png',players:[]},
 ]}),{maps:{de_mirage:{image:'uploads/radars/1-m.png'},de_nuke:{image:'radars/de_nuke.png'},de_x:undefined}});
 assert.deepEqual([...refs].sort(),['uploads/logos/1-a.png','uploads/maps/1-mirage.png','uploads/players/1-n.png','uploads/radars/1-m.png']);
 assert.deepEqual([...UPLOAD_DIRS],['logos','maps','radars','players']);
});

test('pruning deletes stale unreferenced files but spares references, drafts and .gitkeep',()=>{
 const now=1_800_000_000_000, refs=new Set(['uploads/players/1799999000000-kept.png']);
 const old=`${now-UPLOAD_GRACE_MS-1}-old.png`, fresh=`${now-1000}-fresh.png`;
 assert.equal(isPrunable(old,refs,'players',now),true,'an unreferenced upload past the grace window goes');
 assert.equal(isPrunable(fresh,refs,'players',now),false,'a just-uploaded photo is waiting for its Save click');
 assert.equal(isPrunable('1799999000000-kept.png',refs,'players',now),false,'referenced files stay');
 assert.equal(isPrunable('.gitkeep',refs,'players',now),false);
 assert.equal(isPrunable('hand-dropped.png',refs,'players',now),true,'no timestamp, no protection');
 assert.equal(isPrunable(`${now+60_000}-future.png`,refs,'players',now),false,'a clock that moved backwards must not delete work');
 assert.equal(isPrunable(old,new Set([`uploads/logos/${old}`]),'players',now),true,'references are per directory');
});
