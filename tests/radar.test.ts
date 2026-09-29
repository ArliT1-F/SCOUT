import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calibrationFor,parsePoint,projectPoint,yawOf,radarPoints} from '../src/radar';
import type {MatchState} from '../server/state';

// Published CS2 overview values (resource/overviews/de_mirage.txt): the top-left corner of the radar
// image is (-3230, 1713) and one pixel is 5 world units.
const radars={overviewSize:1024,maps:{de_mirage:{posX:-3230,posY:1713,scale:5}}};
const mirage=calibrationFor(radars,'de_mirage')!;

test('calibration comes from the map name, and a map without one is refused',()=>{
 assert.deepEqual({posX:mirage.posX,posY:mirage.posY,scale:mirage.scale,size:mirage.size},({posX:-3230,posY:1713,scale:5,size:1024}));
 assert.equal(mirage.image,'radars/de_mirage.png');
 assert.equal(calibrationFor(radars,'de_ancient'),undefined,'an uncalibrated map must not be drawn');
 assert.equal(calibrationFor({},'de_mirage'),undefined);
 assert.equal(calibrationFor({maps:{de_mirage:{posX:1,posY:2}}},'de_mirage'),undefined,'a missing scale is not a calibration');
 assert.equal(calibrationFor({overviewSize:2048,maps:{de_mirage:{posX:0,posY:0,scale:5}}},'de_mirage')!.size,2048);
});

test('world coordinates project onto the overview with pos_x/pos_y/scale',()=>{
 assert.deepEqual(projectPoint({x:-3230,y:1713},mirage),{u:0,v:0},'the origin of the radar is its calibration corner');
 assert.deepEqual(projectPoint({x:-3230+5120,y:1713},mirage),{u:1,v:0});
 assert.deepEqual(projectPoint({x:-3230,y:1713-5120},mirage),{u:0,v:1},'south edge');
 assert.deepEqual(projectPoint({x:-3230+5120,y:1713-5120},mirage),{u:1,v:1},'south-east corner');
 const middle=projectPoint({x:0,y:0},mirage)!;
 assert.ok(Math.abs(middle.u-0.6308)<0.001&&Math.abs(middle.v-0.3346)<0.001,'world origin sits inside mirage');
 assert.equal(projectPoint({x:-3230-5120,y:1713},mirage),undefined,'outside the overview is not drawn');
 assert.equal(projectPoint({x:NaN,y:0},mirage),undefined);
});

test('the 2% border slack clamps instead of dropping the dot',()=>{
 const outside=projectPoint({x:-3230-20,y:1713+20},mirage);
 assert.deepEqual(outside,{u:0,v:0},'a player half a step off the edge still belongs on the edge');
});

test('positions and yaw are parsed defensively',()=>{
 assert.deepEqual(parsePoint('-1085, 1047, -165'),{x:-1085,y:1047});
 assert.deepEqual(parsePoint('3,4'),{x:3,y:4});
 assert.equal(parsePoint('84'),undefined,'a lone number is not a position');
 assert.equal(parsePoint(''),undefined);
 assert.equal(parsePoint('left, right'),undefined);
 assert.equal(parsePoint(undefined),undefined);
 assert.equal(yawOf('84'),84);
 assert.equal(yawOf('-10'),350);
 assert.equal(yawOf('0, 1, 0'),90,'a forward vector becomes its heading');
 assert.equal(yawOf(''),undefined);
 assert.equal(yawOf('nope'),undefined);
});

test('dots are built from live positions only, and the observed player is marked',()=>{
 const state={player:{steamid:'1'},allplayers:{
  '1':{name:'nova',team:'CT',position:'-3230, 1713, 0',forward:'90',state:{health:100}},
  '2':{name:'kairo',team:'CT',position:'-3230, 1713, 0',state:{health:0}},
  '3':{name:'blitz',team:'T',position:'-2720, 1200, 0',forward:'180',state:{health:100}},
  '4':{name:'ghost',team:'T',position:'999999, 999999, 0',state:{health:100}},
  '5':{name:'coach',team:'SPECTATOR',position:'-3230, 1713, 0',state:{health:100}}
 }} as unknown as MatchState;
 const {dots,bomb}=radarPoints(state,mirage,{colors:{CT:'#b7a0ed',T:'#d8eab0'}});
 assert.deepEqual(dots.map(dot=>dot.name),['kairo','nova','blitz'],'CT first, spectators and off-map players excluded');
 assert.equal(bomb,undefined,'no bomb position, no bomb dot');
 const nova=dots.find(dot=>dot.name==='nova')!;
 assert.deepEqual([nova.u,nova.v],[0,0]);
 assert.equal(nova.observed,true,'the observed player is marked on the radar');
 assert.equal(nova.alive,true);
 assert.equal(nova.yaw,90);
 assert.equal(nova.color,'#b7a0ed');
 const kairo=dots.find(dot=>dot.name==='kairo')!;
 assert.equal(kairo.alive,false,'a dead player keeps the last known position, dimmed');
 assert.equal(kairo.observed,false);
 assert.equal(kairo.yaw,undefined,'no forward means no heading arrow');
});

test('the bomb dot appears only while the bomb is planted',()=>{
 const base={allplayers:{}} as unknown as MatchState;
 const planted={...base,bomb:{state:'planted',countdown:'35.4',position:'-2720, 1200, 0'}} as unknown as MatchState;
 const bomb=radarPoints(planted,mirage).bomb!;
 assert.equal(bomb.planted,true);
 assert.ok(Math.abs(bomb.u-0.0996)<0.001&&Math.abs(bomb.v-0.1002)<0.001,`bomb at ${bomb.u},${bomb.v}`);
 assert.equal(radarPoints({...base,bomb:{state:'defused',position:'-2720, 1200, 0'}} as unknown as MatchState,mirage).bomb!.planted,false);
 assert.equal(radarPoints(base,mirage).bomb,undefined,'a carried bomb has no position and no dot');
});
