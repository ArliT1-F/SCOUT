import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {Hud} from '../src/hud';
import {defaultControls} from '../server/controls';
import {normalizeConfig} from '../server/config';
import {defaultOverlay} from '../server/overlay';
import type {MatchState} from '../server/state';
import type {KillEvent} from '../server/events';

// Every timestamp in a snapshot (lastSeen, kill.at) is the host's clock. The OBS browser source often
// runs on another machine, whose clock can be seconds off, and the panel's replay preview runs on the
// recording's clock. The HUD has to measure ages on the clock those timestamps come from.
const config=normalizeConfig({teams:[{id:'a',name:'Vertex'},{id:'b',name:'Parallax'}],maps:[{name:'de_mirage'}]}) as any;
const HOST_NOW=1_750_000_000_000;
const state:MatchState={map:{name:'de_mirage',phase:'live',round:3,team_ct:{name:'Vertex',score:1},team_t:{name:'Parallax',score:1}},round:{phase:'live'},phase_countdowns:{phase:'live',phase_ends_in:60}} as MatchState;
const kill=(at:number):KillEvent=>({id:1,at,round:3,map:'de_mirage',killer:'1',killerName:'nova',killerSide:'CT',victim:'2',victimName:'blitz',victimSide:'T',weapon:'weapon_ak47',headshot:false});
const render=(props:Record<string,unknown>)=>renderToString(createElement(Hud,{state,controls:defaultControls,config,overlay:defaultOverlay(),signal:true,...props} as any));

test('an output whose clock runs ahead of the host still shows a fresh kill and a live clock',()=>{
 const ahead=20_000; // this browser reads 20 s later than the host
 const html=render({now:HOST_NOW+ahead,clockSkew:-ahead,lastSeen:HOST_NOW-1000,events:{kills:[kill(HOST_NOW-2000)],rounds:[]}});
 assert.match(html,/blitz/,'a kill 2 s old on the host clock is still in the killfeed');
 assert.match(html,/0:59/,'one second after the last packet the 60 s clock reads 0:59, not a frozen or empty clock');
});

test('an output whose clock runs behind the host retires a kill on time',()=>{
 const behind=20_000;
 const html=render({now:HOST_NOW-behind,clockSkew:behind,lastSeen:HOST_NOW,events:{kills:[kill(HOST_NOW-10_000)],rounds:[]}});
 assert.doesNotMatch(html,/blitz/,'a kill 10 s old on the host clock has left the killfeed');
});

test('the replay preview shows the kills of the moment it is scrubbed to',()=>{
 const recordedAt=1_600_000_000_000; // a recording from long ago
 const html=render({now:recordedAt,clockSkew:0,lastSeen:recordedAt,events:{kills:[kill(recordedAt-1500)],rounds:[]}});
 assert.match(html,/blitz/,'the killfeed follows the replay frame time, not the wall clock');
});
