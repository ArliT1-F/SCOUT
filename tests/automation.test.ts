import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomationEngine,MANUAL_SUSPEND_MS,defaultAutomation,normalizeAutomation,scheduleForRules} from '../server/automation.js';
import type {AutomationConfig} from '../server/automation.js';
import type {Controls} from '../server/controls.js';

// Auto-pilot (docs/LAUNCH-FEATURES.md §3). The rules are pure data and the engine is a clock, a
// queue and three refusals: switched off, suspended by a human, or another operator holds the lease.
// These tests pin the refusals down, because they are the difference between a helpful assistant and
// a second operator nobody asked for.
const at=(clock:{now:number})=>clock.now;
function engine(over:Partial<AutomationConfig>={}){
 const clock={now:1_000_000};
 const applied:Array<{patch:Partial<Controls>;rule:string}>=[];
 const writer={scene:'live' as Controls['scene'],breakEndsAt:null as number|null,lease:false,
  read(){return {scene:this.scene,breakEndsAt:this.breakEndsAt}},
  apply(patch:Partial<Controls>,rule:{id:string}){applied.push({patch,rule:rule.id});Object.assign(this,patch)},
  leaseHeld(){return this.lease},
 };
 const instance=new AutomationEngine(writer as any,{now:()=>clock.now});
 const config=normalizeAutomation({enabled:true,...over});
 instance.setConfig(config);
 return {instance,clock,writer,applied};
}

test('the defaults ship switched off, with every rule off too',()=>{
 const config=defaultAutomation();
 assert.equal(config.enabled,false);
 assert.ok(config.rules.length>=4);
 for(const rule of config.rules) assert.equal(rule.enabled,false,'an upgrade must not change what goes to air');
 const ids=config.rules.map(rule=>rule.id);
 assert.deepEqual([...new Set(ids)],ids,'rule ids are unique; the audit trail names a rule');
});

test('a round end queues a recap and a return to the game, in that order',async()=>{
 const {instance,clock,applied}=engine({rules:[{id:'recap',name:'Recap',enabled:true,when:{type:'round-end'},do:[{scene:'recap'},{scene:'live',after:8}],cooldownMs:0}]} as any);
 instance.trigger({type:'round-end'});
 assert.equal(applied.length,0,'nothing changes at the instant of the trigger');
 clock.now+=8000;
 const fired=await instance.tick();
 assert.equal(fired.length,2);
 assert.deepEqual(applied.map(entry=>entry.patch.scene),['recap','live']);
 assert.equal(instance.status().lastAction?.ruleId,'recap');
});

test('nothing fires while auto-pilot is off, or while a rule is disabled',async()=>{
 const off=engine({enabled:false});
 off.instance.trigger({type:'series-end'});
 off.clock.now+=60_000;
 assert.equal((await off.instance.tick()).length,0);
 assert.equal(off.applied.length,0);
 const disabled=engine({rules:[{id:'winner',name:'Winner',enabled:false,when:{type:'series-end'},do:[{scene:'winner'}],cooldownMs:0}]} as any);
 disabled.instance.trigger({type:'series-end'});
 disabled.clock.now+=60_000;
 assert.equal((await disabled.instance.tick()).length,0);
});

test('a manual scene change pauses auto-pilot for a minute',async()=>{
 const {instance,clock,applied}=engine({rules:[{id:'recap',name:'Recap',enabled:true,when:{type:'round-end'},do:[{scene:'recap'}],cooldownMs:0}]} as any);
 instance.trigger({type:'round-end'});
 const status=instance.suspend();
 assert.ok((status.suspendedUntil??0)>clock.now);
 clock.now+=1000;
 assert.equal((await instance.tick()).length,0,'the queued action was cancelled, not delayed');
 assert.equal(applied.length,0);
 clock.now+=MANUAL_SUSPEND_MS;
 const result=instance.trigger({type:'round-end'});
 assert.equal(result.scheduled,1,'after the minute the rules work again');
});

test('auto-pilot never takes the scene from another operator holding the lease',async()=>{
 const {instance,clock,writer,applied}=engine({rules:[{id:'recap',name:'Recap',enabled:true,when:{type:'round-end'},do:[{scene:'recap'}],cooldownMs:0}]} as any);
 writer.lease=true;
 const result=instance.trigger({type:'round-end'});
 assert.equal(result.scheduled,0);
 assert.equal(result.skipped,'lease');
 assert.equal(instance.status().lastSkip?.reason,'lease');
 clock.now+=60_000;
 assert.equal((await instance.tick()).length,0);
 assert.equal(applied.length,0);
});

test('a cooldown stops a repeated packet from firing the winner scene twice',async()=>{
 const {instance,clock,applied}=engine({rules:[{id:'winner',name:'Winner',enabled:true,when:{type:'series-end'},do:[{scene:'winner'}],cooldownMs:60_000}]} as any);
 instance.trigger({type:'series-end'});
 await instance.tick();
 assert.equal(applied.length,1);
 clock.now+=10_000;
 const second=instance.trigger({type:'series-end'});
 assert.equal(second.scheduled,0);
 assert.equal(instance.status().lastSkip?.reason,'cooldown');
 clock.now+=60_001;
 instance.trigger({type:'series-end'});
 await instance.tick();
 assert.equal(applied.length,2);
});

test('the same rule cannot queue the same scene twice',()=>{
 const {instance}=engine({rules:[{id:'recap',name:'Recap',enabled:true,when:{type:'round-end'},do:[{scene:'recap'},{scene:'live',after:8}],cooldownMs:0}]} as any);
 instance.trigger({type:'round-end'});
 const second=instance.trigger({type:'round-end'});
 assert.equal(second.scheduled,0);
 assert.equal(instance.status().lastSkip?.reason,'duplicate');
});

test('disabling auto-pilot cancels everything already queued',async()=>{
 const {instance,clock,applied}=engine({rules:[{id:'recap',name:'Recap',enabled:true,when:{type:'round-end'},do:[{scene:'recap'},{scene:'live',after:8}],cooldownMs:0}]} as any);
 instance.trigger({type:'round-end'});
 assert.equal(instance.status().pending.length,2);
 instance.setConfig({...instance.configView(),enabled:false});
 assert.equal(instance.status().pending.length,0);
 clock.now+=9000;
 assert.equal((await instance.tick()).length,0);
 assert.equal(applied.length,0);
});

test('a scheduled patch only ever holds a scene and a break end — never a score, team or config',()=>{
 const actions=scheduleForRules(normalizeAutomation(defaultAutomation()).rules.map(rule=>({...rule,enabled:true,when:{type:'round-end'}})),{type:'round-end'},{now:5,scene:'live',breakEndsAt:null});
 assert.ok(actions.length>0);
 for(const action of actions) for(const key of Object.keys(action.patch)) assert.ok(['scene','breakEndsAt'].includes(key),`auto-pilot must not write ${key}`);
});

test('a break rule sets the countdown from the moment it acts, not from the trigger',async()=>{
 const {instance,clock}=engine({rules:[{id:'break',name:'Break',enabled:true,when:{type:'slot-soon',minutes:10},do:[{scene:'break',breakMinutes:5,after:30}],cooldownMs:0}]} as any);
 instance.trigger({type:'slot-soon',minutes:10});
 clock.now+=30_000;
 const fired=await instance.tick();
 assert.equal(fired.length,1);
 assert.equal(fired[0].patch.scene,'break');
 assert.equal(fired[0].patch.breakEndsAt,clock.now+5*60_000);
});

test('status is a snapshot a panel can render without reaching into the engine',()=>{
 const {instance}=engine({rules:[{id:'recap',name:'Recap',enabled:true,when:{type:'round-end'},do:[{scene:'recap'}],cooldownMs:0}]} as any);
 instance.trigger({type:'round-end'});
 const status=instance.status();
 assert.equal(status.enabled,true);
 assert.deepEqual(status.activeRules,['recap']);
 assert.equal(status.pending.length,1);
 assert.equal(status.pending[0].scene,'recap');
 assert.equal(typeof status.pending[0].at,'number');
});
