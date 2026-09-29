import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sceneTeams,teamBySlot,mapLabel,mapCards,nextMap,seriesScore,winnerOf,slotView,liveLineup,lineupFor,sideOfTeam,fitName,fitSize,NAME_PLATE_W,breakWords,BREAK_TITLE,formatCountdown,breakClock,bracketLayout} from '../src/scenes';
import {normalizeConfig} from '../server/config';
import {controlsSchema,defaultControls,SCENE_IDS} from '../server/controls';

// The broadcast scenes are config-first: matchup, lineups and break are on air before CS2 runs. These tests
// pin the derivations behind them — team order, map results, who won, the break clock and the bracket lines.

const config=(over:any={})=>normalizeConfig({
 event:{name:'Campus Cup',stage:'Grand final'},format:'bo3',
 teams:[
  {id:'a',name:'Vertex',tag:'VTX',color:'#d970c2',logo:'uploads/logos/a.png',players:[
   {name:'nova',alias:'Nova',nickname:'Elias Nord',role:'IGL',photo:'uploads/players/1-nova.png',steamid:'76561198000000001'},
   {name:'kairo',role:'AWP'},{name:'s1lent'},{name:'frost'},{name:'mika'},{name:'Coach Q',role:'Coach'}]},
  {id:'b',name:'Parallax',tag:'PRX',color:'#e8c97e',players:[]},
 ],
 maps:[{name:'de_mirage',pick:'A',score:[13,9],status:'done'},{name:'de_inferno',pick:'B',score:[8,6],status:'live'},{name:'de_nuke',pick:'decider',status:'upcoming'}],
 ...over,
});

test('teams keep configured order, mirror when swapped, and never come back empty',()=>{
 const [left,right]=sceneTeams(config());
 assert.deepEqual([left.name,right.name,left.slot,right.slot],['Vertex','Parallax','A','B']);
 assert.equal(left.logo,'uploads/logos/a.png');
 const [swappedLeft,swappedRight]=sceneTeams(config(),true);
 assert.deepEqual([swappedLeft.name,swappedRight.name],['Parallax','Vertex']);
 assert.deepEqual([swappedLeft.slot,swappedRight.slot],['B','A'],'a swap moves the team, it does not rename it');
 // Before the first snapshot arrives there is no config at all.
 assert.deepEqual(sceneTeams(undefined).map(team=>team.name),['TEAM A','TEAM B']);
 assert.equal(teamBySlot({teams:[{id:'x',name:'X'}]},'B').name,'TEAM B');
 assert.equal(teamBySlot(config(),'B').color,'#e8c97e');
 assert.equal(teamBySlot({teams:[{id:'x',name:'X'},{id:'y',name:'Y'}]},'B').color,'#e8c97e','a missing colour gets the slot default');
});

test('map names lose their mode prefix',()=>{
 assert.equal(mapLabel('de_mirage'),'MIRAGE');
 assert.equal(mapLabel('cs_office'),'OFFICE');
 assert.equal(mapLabel('ar_pool_day'),'POOL DAY');
 assert.equal(mapLabel(undefined),'');
});

test('map cards carry picks, results, winners and a picture fallback',()=>{
 const cards=mapCards(config());
 assert.deepEqual(cards.map(card=>[card.label,card.pick,card.status,card.winner]),[['MIRAGE','A','done','A'],['INFERNO','B','live',undefined],['NUKE','decider','upcoming',undefined]]);
 assert.deepEqual(cards[1].score,[8,6],'a live map shows its running score');
 assert.equal(cards[1].winner,undefined,'but a live score is not a result');
 assert.equal(cards[0].image,'thumbs/de_mirage.png','no upload: the shipped map thumbnail');
 assert.equal(mapCards(config({maps:[{name:'de_mirage',image:'uploads/maps/m.png'}]}))[0].image,'uploads/maps/m.png','an uploaded picture wins');
 assert.equal(mapCards(config({maps:[{name:'de_x'}]}))[0].image,'thumbs/de_x.png','the thumbnail path is derived for any map — radar overviews are never the scene picture');
 assert.equal(mapCards(config({maps:[{name:'de_x',score:[5,5],status:'done'}]}))[0].winner,undefined,'a tie has no winner');
 assert.deepEqual(mapCards(undefined),[]);
 assert.equal(mapCards({maps:[{name:'de_x',score:['a','b'],status:'done'}]})[0].score,undefined,'garbage scores are dropped, not printed');
});

test('the next map is the live one, else the first upcoming one',()=>{
 assert.equal(nextMap(mapCards(config()))?.label,'INFERNO');
 assert.equal(nextMap(mapCards(config({maps:[{name:'de_mirage',score:[13,1],status:'done'},{name:'de_nuke',status:'upcoming'}]})))?.label,'NUKE');
 assert.equal(nextMap(mapCards(config({maps:[{name:'de_mirage',score:[13,1],status:'done'}]}))),undefined);
});

test('the series score counts recorded map results and knows when the series is decided',()=>{
 assert.deepEqual(seriesScore(config()),{a:1,b:0,needed:2,source:'config',winner:undefined});
 const decided=config({maps:[{name:'de_mirage',score:[13,9],status:'done'},{name:'de_nuke',score:[7,13],status:'done'},{name:'de_inferno',score:[13,11],status:'done'}]});
 assert.deepEqual(seriesScore(decided),{a:2,b:1,needed:2,source:'config',winner:'A'});
 assert.equal(seriesScore(config({format:'bo1',maps:[{name:'de_mirage',score:[3,13],status:'done'}]})).winner,'B','a bo1 is decided by one map');
 assert.equal(seriesScore(config({format:'bo5',maps:[{name:'de_a',score:[13,1],status:'done'},{name:'de_b',score:[13,1],status:'done'}]})).winner,undefined,'a bo5 needs three');
 assert.deepEqual(seriesScore(config({maps:[{name:'de_mirage'}]})),{a:0,b:0,needed:2,source:'none'});
});

test('before any result is recorded the live series score is used, credited through the resolved sides',()=>{
 const blank=config({maps:[{name:'de_mirage',status:'live'}]});
 const series={maps:{CT:0,T:1},mapsToWin:2,seriesWinner:undefined} as any;
 assert.deepEqual(seriesScore(blank,series,{CT:{id:'a'},T:{id:'b'}}),{a:0,b:1,needed:2,source:'gsi',winner:undefined});
 assert.deepEqual(seriesScore(blank,series,{CT:{id:'b'},T:{id:'a'}}),{a:1,b:0,needed:2,source:'gsi',winner:undefined},'sides swapped: the credit follows the team, not the side');
 assert.equal(seriesScore(blank,series,{CT:{id:'CT:unknown'},T:{id:'T:unknown'}}).source,'none','stand-in sides have no team to credit');
 assert.equal(seriesScore(blank,{maps:{CT:2,T:0},mapsToWin:2} as any,{CT:{id:'a'},T:{id:'b'}}).winner,'A');
});

test('the winner scene trusts the live series first, then recorded results, the tree, and a finished map',()=>{
 const sides={CT:{id:'a'},T:{id:'b'}};
 assert.deepEqual(winnerOf(config(),{seriesWinner:'T',maps:{CT:0,T:2},mapsToWin:2} as any,sides).team?.name,'Parallax','live series winner: T is Parallax');
 assert.equal(winnerOf(config(),{seriesWinner:'T',maps:{CT:0,T:2},mapsToWin:2} as any,sides).scope,'series');
 const recorded=config({maps:[{name:'de_a',score:[13,1],status:'done'},{name:'de_b',score:[13,1],status:'done'}]});
 assert.deepEqual([winnerOf(recorded).team?.name,winnerOf(recorded).scope],['Vertex','series']);
 // The tree's final decides it when nothing else does; a slot bound to a team resolves to that team.
 const tree=(final:any)=>config({bracket:{title:'Playoffs',rounds:[{name:'Semis',matches:[{id:'s1'}]},{name:'Final',matches:[{id:'gf',...final}]}]}});
 const bound=winnerOf(tree({a:{label:'',team:'a'},b:{label:'',team:'b'},winner:'b'}));
 assert.deepEqual([bound.team?.name,bound.team?.color,bound.scope],['Parallax','#e8c97e','bracket']);
 const labelled=winnerOf(tree({a:{label:'Alpha',team:''},b:{label:'Zeta',team:''},winner:'b'}));
 assert.deepEqual([labelled.team?.name,labelled.scope],['Zeta','bracket'],'a free-label seed is still a champion');
 assert.equal(winnerOf(tree({winner:null})).scope,'none');
 const noMaps=config({maps:[{name:'de_a'}]});
 assert.deepEqual([winnerOf(noMaps,{mapWinner:'CT',maps:{CT:0,T:0},mapsToWin:2} as any,sides).team?.name,winnerOf(noMaps,{mapWinner:'CT',maps:{CT:0,T:0},mapsToWin:2} as any,sides).scope],['Vertex','map']);
 assert.deepEqual(winnerOf(noMaps),{scope:'none'},'no evidence, no champion');
 assert.equal(winnerOf(noMaps,{seriesWinner:'CT',maps:{CT:2,T:0},mapsToWin:2} as any,{CT:{id:'CT:unknown'},T:{id:'T:unknown'}}).scope,'none','a stand-in side cannot be crowned');
});

test('the champion carries a winner-first score for whichever evidence decided it',()=>{
 const sides={CT:{id:'a'},T:{id:'b'}};
 assert.deepEqual(winnerOf(config(),{seriesWinner:'T',maps:{CT:1,T:2},mapsToWin:2} as any,sides).score,[2,1],'live: T won 2–1 in maps');
 const recorded=config({maps:[{name:'de_a',score:[1,13],status:'done'},{name:'de_b',score:[3,13],status:'done'}]});
 assert.deepEqual([winnerOf(recorded).team?.name,winnerOf(recorded).score],['Parallax',[2,0]],'recorded results, winner first even when B is the winner');
 const tree=config({bracket:{title:'',rounds:[{name:'Final',matches:[{id:'gf',a:{label:'',team:'a'},b:{label:'',team:'b'},aScore:1,bScore:3,winner:'b'}]}]}});
 assert.deepEqual(winnerOf(tree).score,[3,1],'the final’s score, oriented to its winner');
 const noMaps=config({maps:[{name:'de_a'}]});
 assert.deepEqual(winnerOf(noMaps,{mapWinner:'CT',score:{CT:13,T:9},maps:{CT:0,T:0},mapsToWin:2} as any,sides).score,[13,9]);
 assert.deepEqual(winnerOf(noMaps,{mapWinner:'T',score:{CT:9,T:13},maps:{CT:0,T:0},mapsToWin:2} as any,sides).score,[13,9],'a T win is still reported winner first');
 assert.equal(winnerOf(noMaps).score,undefined);
});

test('a tree slot shows its bound team, or its own label, or TBD',()=>{
 const cfg=config();
 assert.deepEqual(slotView({label:'ignored',team:'a'},cfg),{name:'Vertex',logo:'uploads/logos/a.png',color:'#d970c2',bound:true});
 assert.deepEqual(slotView({label:'Winner of SF1',team:''},cfg),{name:'Winner of SF1',logo:'',color:'',bound:false});
 assert.deepEqual(slotView({label:'  ',team:''},cfg),{name:'TBD',logo:'',color:'',bound:false});
 assert.equal(slotView({label:'Ghost',team:'no-such-team'},cfg).name,'Ghost','an unknown team id falls back to the label');
 assert.equal(slotView(undefined,cfg).name,'TBD');
 assert.equal(slotView({team:'a'},undefined).name,'TBD');
});

test('the lineup uses the operator roster and only stands in with live players when the roster is empty',()=>{
 const cfg=config(), [a,b]=sceneTeams(cfg);
 const roster=lineupFor(cfg,a);
 assert.equal(roster.source,'roster');
 assert.deepEqual(roster.starters.map(card=>card.name),['Nova','kairo','s1lent','frost','mika']);
 assert.deepEqual(roster.bench.map(card=>card.name),['Coach Q']);
 assert.equal(roster.starters[0].photo,'uploads/players/1-nova.png');
 const live=liveLineup([{steamid:'1',name:'x1',team:'T',observer_slot:7},{steamid:'2',name:'x2',team:'T',observer_slot:6},{steamid:'3',name:'y',team:'CT'}],'T',player=>player.name!.toUpperCase());
 assert.deepEqual(live.map(card=>card.name),['X2','X1'],'ordered by observer slot, names through the alias resolver');
 assert.equal(lineupFor(cfg,b,live).source,'live','Parallax has no roster, so the live players stand in');
 assert.equal(lineupFor(cfg,b).source,'none');
 assert.equal(lineupFor(cfg,a,live).source,'roster','a roster is never replaced by live data');
 assert.equal(sideOfTeam({CT:{id:'a'},T:{id:'b'}},'b'),'T');
 assert.equal(sideOfTeam(undefined,'b'),undefined);
});

test('name plates step their type size down with the length',()=>{
 const sizes=['nova','ropz','sh1ro','Kairo','xXn0vaXx','longername1','averyverylongplayername'].map(name=>fitName(name));
 assert.deepEqual(sizes,[40,40,40,40,34,25,21]);
 for(let i=1;i<sizes.length;i++) assert.ok(sizes[i]<=sizes[i-1],'never grows with the length');
 assert.equal(fitName(''),40);
 assert.equal(fitName('日本語日本語日本語日本語日本語'),21,'counts characters, not UTF-16 units');
 // The plate holds the text at the chosen size (condensed caps ≈ 0.5em per glyph) unless it is already at the smallest
 // size, where the CSS ellipsis cuts it. A nine-letter handle such as "w0nderful" must not be cut.
 for(const length of [1,7,8,9,10,11,12,13,14,20,40]){const size=fitName('x'.repeat(length));assert.ok(size===21||length*0.5*size<=NAME_PLATE_W,`length ${length}`)}
 assert.ok(fitName('w0nderful')<=30&&9*0.46*fitName('w0nderful')<=NAME_PLATE_W,'a real nine-letter handle fits its plate');
});

test('operator text is fitted to its box: as large as fits, inside the limits',()=>{
 const fit=(text:string,lines=1)=>fitSize(text,746,{max:96,min:40,lines});
 assert.equal(fit('NAVI'),96,'short text keeps the full size');
 assert.equal(fit(''),96,'empty text counts as one glyph, not a division by zero');
 const sizes=[1,5,9,13,17,23,31,40,52,64,120].map(length=>fit('x'.repeat(length)));
 for(const size of sizes) assert.ok(size>=40&&size<=96,'never outside [min,max]');
 for(let i=1;i<sizes.length;i++) assert.ok(sizes[i]<=sizes[i-1],'only ever steps down as the text grows');
 assert.equal(sizes[sizes.length-1],40,'very long text bottoms out at the minimum, where the CSS ellipsis takes over');
 assert.ok(fit('x'.repeat(30),2)>fit('x'.repeat(30),1),'a second line buys a larger size');
 assert.ok(fitSize('x'.repeat(200),1300,{max:40,min:24,lines:3})>fitSize('x'.repeat(200),1300,{max:40,min:24,lines:2}),'and a third a larger one still');
 // The chosen size honours the estimate: unless clamped at the minimum, the text is estimated to fit (85% of the room on two lines).
 for(const length of [10,20,30,40,50]){const size=fit('x'.repeat(length),2);assert.ok(size===40||length*0.56*size<=746*2*0.85,`length ${length}`)}
 assert.equal(fit('日本語日本語日本語'),fit('x'.repeat(9)),'counts characters, not UTF-16 units');
 assert.equal(fit('😀'.repeat(9)),fit('x'.repeat(9)),'an emoji is one glyph');
 // Realistic content is never shrunk: the scenes look the same as before for ordinary names.
 assert.equal(fitSize('Natus Vincere',746,{max:96,min:40,lines:2}),96);
 assert.equal(fitSize('WE’LL BE RIGHT BACK',1640,{max:150,min:56,lines:2}),150);
});

test('the break scene has default wording and a countdown that only counts down',()=>{
 assert.deepEqual(breakWords(config()),{title:BREAK_TITLE,message:''});
 assert.deepEqual(breakWords(config({break:{title:'  Technical pause ',message:'Map 2 starts soon'}})),{title:'Technical pause',message:'Map 2 starts soon'});
 assert.equal(formatCountdown(272_000),'04:32');
 assert.equal(formatCountdown(271_001),'04:32','rounded up: the last second still reads 00:01');
 assert.equal(formatCountdown(1),'00:01');
 assert.equal(formatCountdown(0),'00:00');
 assert.equal(formatCountdown(-5000),'00:00');
 assert.equal(formatCountdown(3_725_000),'1:02:05');
 assert.equal(formatCountdown(NaN),'00:00');
 assert.deepEqual(breakClock(null,1000),{running:false,done:false,remainingMs:0,label:''});
 assert.deepEqual(breakClock(undefined,1000),{running:false,done:false,remainingMs:0,label:''});
 assert.deepEqual(breakClock(61_000,1_000),{running:true,done:false,remainingMs:60_000,label:'01:00'});
 assert.deepEqual(breakClock(1_000,1_000),{running:false,done:true,remainingMs:0,label:'00:00'});
 assert.deepEqual(breakClock(1_000,9_000),{running:false,done:true,remainingMs:0,label:'00:00'});
 assert.equal(breakClock(NaN,0).running,false);
});

test('the controls schema knows every scene, defaults the timer, and still loads old operator files',()=>{
 assert.deepEqual([...SCENE_IDS],['live','matchup','lineups','veto','bracket','winner','break']);
 const {breakEndsAt:_omitted,...legacy}=defaultControls;
 assert.equal(controlsSchema.parse(legacy).breakEndsAt,null,'an operator.json written before the timer existed');
 assert.equal(controlsSchema.parse({...legacy,breakEndsAt:1_800_000_000_000}).breakEndsAt,1_800_000_000_000);
 for(const bad of [-1,1.5,'soon',Infinity]) assert.equal(controlsSchema.safeParse({...legacy,breakEndsAt:bad}).success,false,String(bad));
 assert.equal(controlsSchema.safeParse({...legacy,scene:'nope'}).success,false);
 for(const scene of SCENE_IDS) assert.equal(controlsSchema.safeParse({...legacy,scene}).success,true,scene);
});

// ---- tournament tree geometry ----
const rounds=(...counts:number[])=>counts.map(count=>({matches:Array.from({length:count},()=>({}))}));
const area={width:1792,height:840};

test('a 4-2-1 tree centres every match on the pair it is fed by',()=>{
 const board=bracketLayout(rounds(4,2,1),area);
 assert.equal(board.cards.length,7);
 assert.equal(board.links.length,6,'every match but the final feeds one');
 const card=(round:number,index:number)=>board.cards.find(candidate=>candidate.round===round&&candidate.index===index)!;
 // Positions are rounded to 0.1px, so "centred" means within that rounding.
 const near=(actual:number,expected:number,message:string)=>assert.ok(Math.abs(actual-expected)<=0.1,`${message}: ${actual} vs ${expected}`);
 for(const [round,index,a,b] of [[1,0,0,1],[1,1,2,3]] as const) near(card(round,index).cy,(card(0,a).cy+card(0,b).cy)/2,`round ${round} match ${index}`);
 near(card(2,0).cy,(card(1,0).cy+card(1,1).cy)/2,'the final sits between the semifinals');
 // Nothing leaves the drawing area and no two cards in a column touch.
 for(const c of board.cards){assert.ok(c.x>=0&&c.x+c.w<=area.width&&c.y>=board.titleH&&c.y+c.h<=area.height,JSON.stringify(c))}
 const column=board.cards.filter(candidate=>candidate.round===0);
 for(let i=1;i<column.length;i++) assert.ok(column[i].y>=column[i-1].y+column[i-1].h,'cards in a column do not overlap');
});

test('connector paths run from the right edge of a match to the left edge of the one it feeds',()=>{
 const board=bracketLayout(rounds(2,1),area);
 const [first,second]=board.links, source=board.cards[0], target=board.cards[2];
 assert.match(first.d,/^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+$/);
 const [x1,y1,xm,yt,x2]=first.d.match(/[\d.]+/g)!.map(Number);
 assert.equal(x1,source.x+source.w);
 assert.equal(y1,source.cy);
 assert.equal(x2,target.x);
 assert.equal(yt,target.cy);
 assert.ok(xm>x1&&xm<x2,'the vertical joins in the gap between the columns');
 assert.equal(second.d.match(/[\d.]+/g)![3],String(target.cy),'both feeders converge on the same line');
});

test('trees that are not powers of two, single rounds and empty trees still lay out',()=>{
 const odd=bracketLayout(rounds(3,2,1),area);
 assert.equal(odd.cards.length,6);
 assert.equal(odd.links.length,5);
 // Match 2 of a 3-match round would feed match 1 of a 2-match round; the last match clamps into range.
 const clamped=bracketLayout(rounds(3,1),area);
 assert.equal(clamped.links.length,3);
 const targets=clamped.links.map(link=>link.d.match(/[\d.]+/g)![3]);
 assert.equal(new Set(targets).size,1,'everything feeds the single final');
 const single=bracketLayout(rounds(2),area);
 assert.deepEqual([single.cards.length,single.links.length],[2,0]);
 assert.deepEqual(bracketLayout([],area).cards,[]);
 const wide=bracketLayout(rounds(8,4,2,1,1,1,1,1),area);
 assert.ok(wide.colW>=120&&wide.colW*8+wide.gap*7<=area.width+0.5,'eight rounds still fit the width');
 assert.ok(wide.cardH>=44,'and the cards stay legible');
 const tall=bracketLayout(rounds(16,8,4,2,1),area);
 assert.ok(tall.cards.every(c=>c.y>=tall.titleH&&c.y+c.h<=area.height+0.5),'sixteen matches in a column still fit');
 // A narrow tree is centred rather than glued to the left edge.
 const narrow=bracketLayout(rounds(2,1),area);
 assert.ok(narrow.heads[0].x>0&&Math.abs(narrow.heads[0].x-(area.width-(narrow.heads[1].x+narrow.heads[1].w))) <1,'margins are equal on both sides');
});
