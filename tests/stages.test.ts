import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStages,collapseStages,isSwiss,standingsFor,stageHeadline,stageKind} from '../server/stages.js';
import type {PublicMatch} from '../server/hub.js';

// Multi-stage hubs: one series page runs group stage → playoffs. v1 is two shapes and a table, with
// no Swiss — a table that guesses at Swiss pairing would be wrong by round two.
const match=(a:string,b:string,aScore:number,bScore:number,status:PublicMatch['status']='done'):PublicMatch=>({a,b,aScore,bScore,winner:aScore>bScore?'a':bScore>aScore?'b':null,status,round:'Group A'});
const names=['Nova','Falcons','G2','Vitality'];

test('stage labels are read the way an organiser writes them',()=>{
 for(const label of ['Group A','Group B','Group stage','groups','Group Stage 1']) assert.equal(stageKind(label),'group',label);
 for(const label of ['Playoffs','Quarter-final','Semi final','Grand Final','Upper bracket']) assert.equal(stageKind(label),'playoff',label);
 assert.equal(isSwiss('Swiss stage'),true);
});

test('a table counts played matches, points and map difference',()=>{
 const table=standingsFor(names,[match('Nova','Falcons',2,0),match('Nova','G2',2,1),match('G2','Vitality',2,0),match('Falcons','Vitality',1,2),match('Nova','Vitality',0,2)]);
 // Nova and Vitality both finish 2–1 with +1; the tie-break is alphabetical so a refresh never shuffles.
 assert.deepEqual(table.slice(0,2).map(row=>row.team),['Nova','Vitality']);
 assert.equal(table[0].points,6);assert.equal(table[0].diff,1);
 assert.deepEqual(table.map(row=>row.team).sort(),[...names].sort());
 const nova=table.find(row=>row.team==='Nova')!;
 assert.equal(nova.played,3);assert.equal(nova.won,2);assert.equal(nova.lost,1);
 assert.equal(nova.points,6);assert.equal(nova.mapsFor,4);assert.equal(nova.mapsAgainst,3);assert.equal(nova.diff,1);
});

test('upcoming matches and slot placeholders never enter the table',()=>{
 const table=standingsFor(names,[match('Nova','Falcons',0,0,'upcoming'),match('Winner of SF1','Nova',2,0)]);
 assert.equal(table.every(row=>row.played===0),true);
 assert.equal(table.length,names.length,'only real teams are ranked');
});

test('a draw gives both teams a point',()=>{
 const table=standingsFor(['Nova','Falcons'],[match('Nova','Falcons',1,1)]);
 assert.equal(table.find(row=>row.team==='Nova')?.points,1);
 assert.equal(table.find(row=>row.team==='Falcons')?.points,1);
});

test('group labels collapse into one table, and a swiss stage is never one',()=>{
 const collapsed=collapseStages([{name:'Group A',matches:[1,2] as any},{name:'Group B',matches:[3] as any},{name:'Playoffs',matches:[]}]);
 assert.equal(collapsed.length,2,'one group stage plus the bracket');
 assert.equal(collapsed[0].name,'Group stage');
 assert.equal(collapsed[0].matches.length,3);
 const swiss=collapseStages([{name:'Swiss stage',matches:[1] as any}]);
 assert.equal(swiss[0].name,'Swiss stage');
 assert.equal(buildStages(names,swiss)[0].table.length,0,'no table for a format v1 does not model');
});

test('the headline tells a visitor where they are',()=>{
 const stages=buildStages(names,[{name:'Group A',matches:[match('Nova','Falcons',2,0)]},{name:'Playoffs',matches:[]}]);
 // A single group keeps the organiser's own label instead of being renamed to "Group stage".
 assert.equal(stageHeadline(stages),'Group A → Playoffs');
 assert.equal(stageHeadline([{id:'group-a',name:'Group A',kind:'group',table:[],matches:[]}]),'Group A');
 assert.equal(stageHeadline([]),'');
});
