import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configSchema} from '../server/config';
import {DEFAULT_WIDGETS,defaultOverlay,overlaySchema} from '../server/overlay';
import {emptyLayout,layoutSchema} from '../server/layout';
import {radarsSchema} from '../server/radars';
import {obsConfigSchema} from '../server/obs-config';

// Since zod 4 a default is returned as the very value it was given, not a parsed copy. A list or
// object default shared that way leaks: one configuration's edit becomes every later default. Each
// schema below must hand out fresh defaults.

const minimal={teams:[{id:'a',name:'A'},{id:'b',name:'B'}],maps:[{name:'de_mirage'}]};

test('two parsed configurations never share a default list or object',()=>{
 const first=configSchema.parse(minimal),second=configSchema.parse(minimal);
 first.teams[0].players.push({steamid:'',name:'leak',nickname:'',role:'',alias:'',photo:''});
 first.sponsors.items.push({id:'s',name:'leak',logo:''});
 first.bracket.rounds[0].matches[0].a.label='leak';
 first.event.name='leak';first.break.title='leak';
 assert.equal(second.teams[0].players.length,0);
 assert.equal(second.sponsors.items.length,0);
 assert.equal(second.bracket.rounds[0].matches[0].a.label,'');
 assert.equal(second.bracket.rounds[0].matches[1].a.label,'','slots inside one default are separate too');
 assert.equal(second.event.name,'');assert.equal(second.break.title,'');
 assert.equal(configSchema.parse(minimal).teams[1].players.length,0);
});

test('overlay, layout, radars and OBS defaults are fresh on every parse',()=>{
 const overlay=defaultOverlay();
 overlay.widgets[0].enabled=false;overlay.widgets.push({...overlay.widgets[0],id:'extra'});overlay.theme.accent='#000000';overlay.widgets[1].showOn.push('break');
 const next=defaultOverlay();
 assert.equal(next.widgets[0].enabled,true);
 assert.equal(next.widgets.length,DEFAULT_WIDGETS.length);
 assert.notEqual(next.theme.accent,'#000000');
 assert.deepEqual(next.widgets[1].showOn,['live']);
 assert.equal(DEFAULT_WIDGETS[0].enabled,true,'the built-in list itself is untouched');
 assert.equal(overlaySchema.parse({}).widgets.length,DEFAULT_WIDGETS.length);
 const layout=layoutSchema.parse({});(layout.elements as any).event={x:1,y:2};
 assert.deepEqual(layoutSchema.parse({}).elements,{});assert.deepEqual(emptyLayout().elements,{});
 const radars=radarsSchema.parse({});(radars.maps as any).de_test={posX:0,posY:0,scale:1};
 assert.deepEqual(radarsSchema.parse({}).maps,{});
 const obs=obsConfigSchema.parse({});(obs.sceneMap as any).live='Changed';
 assert.equal(obsConfigSchema.parse({}).sceneMap.live,'');
});
