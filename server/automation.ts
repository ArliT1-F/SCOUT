// Auto-pilot (docs/LAUNCH-FEATURES.md §3): scene changes driven by what the match is already doing.
//
// The product derives every round end, bomb outcome and kill from the GSI stream; this module is the
// small, boring part that turns those facts into a scene and a countdown. Three rules keep it safe on
// air, and each one is enforced here rather than in the UI:
//
//   1. It is off until an owner/producer turns it on, and it ships with the sample rules disabled.
//   2. A human action suspends it for a minute (the operator always wins the wheel).
//   3. It never acts while another operator holds the control lease, and it only ever writes the
//      scene and the break countdown. Scores, teams and configuration are out of its reach.
//
// The engine is clock-injected and has one timer-shaped method (`tick`), so a test can replay a
// recorded match and assert the exact scene timeline without sleeping.
import {z} from 'zod';
import {SCENE_IDS,type Controls} from './controls.js';
import type {ScheduleSlot} from './config.js';

export const automationTriggerSchema=z.object({
 // feed-lost / feed-restored come from server/watchdog.ts: the host raises them, the rules react
 // exactly as they do to a round ending. A watchdog that only drew a banner would still leave the
 // frozen scoreboard on air.
 type:z.enum(['round-end','series-end','break-over','slot-soon','feed-lost','feed-restored']),
 // slot-soon only: how many minutes ahead of the fixture the rule fires.
 minutes:z.number().int().min(0).max(180).optional(),
}).strip();
export const automationActionSchema=z.object({
 scene:z.enum(SCENE_IDS).optional(),
 breakMinutes:z.number().int().min(1).max(600).optional(),
 // Delay in seconds before this step, relative to the trigger (or to the previous step of the rule).
 after:z.number().int().min(0).max(600).optional().default(0),
}).strip().refine(action=>action.scene!==undefined||action.breakMinutes!==undefined,'an action must set a scene or a break countdown');
export const automationRuleSchema=z.object({
 id:z.string().trim().min(1).max(32),
 name:z.string().trim().max(60).optional().default('Rule'),
 enabled:z.boolean().optional().default(false),
 when:automationTriggerSchema,
 do:z.array(automationActionSchema).min(1).max(4),
 // Seconds during which the same rule cannot fire again; 0 means "every time it happens", which is
 // what a round-end rule wants and what a slot-soon rule does not.
 cooldownMs:z.number().int().min(0).max(3_600_000).optional().default(0),
}).strip();
// Alerts are optional and separate from the rules: an operator may want the scene change without the
// Discord ping, or the ping without the change.
export const automationAlertsSchema=z.object({
 webhook:z.string().trim().max(300).optional().default(''),
 onFeedLoss:z.boolean().optional().default(true),
}).strip();
export type AutomationAlerts=z.infer<typeof automationAlertsSchema>;
export const automationConfigSchema=z.object({
 alerts:automationAlertsSchema.optional().default({webhook:'',onFeedLoss:true}),
 version:z.number().int().optional().default(1),
 enabled:z.boolean().optional().default(false),
 rules:z.array(automationRuleSchema).max(12).optional(),
}).strip();
export type AutomationTrigger=z.infer<typeof automationTriggerSchema>;
export type AutomationAction=z.infer<typeof automationActionSchema>;
export type AutomationRule=z.infer<typeof automationRuleSchema>;
// Normalized shape: `rules` is always present, which keeps every consumer free of `?? []` noise.
export interface AutomationConfig {version:number;enabled:boolean;rules:AutomationRule[];alerts:AutomationAlerts}
export const MANUAL_SUSPEND_MS=60_000;
// The five transitions every operator does by hand today, shipped switched off. `enabled:false` on
// purpose: an upgrade must never change what goes to air.
export const DEFAULT_RULES:AutomationRule[]=[
 {id:'round-recap',name:'Round recap, then back to the game',enabled:false,when:{type:'round-end'},do:[{scene:'recap',after:0},{scene:'live',after:8}],cooldownMs:0},
 {id:'series-winner',name:'Winner scene when the series ends',enabled:false,when:{type:'series-end'},do:[{scene:'winner',after:0}],cooldownMs:60_000},
 {id:'break-over',name:'Back to the game when the break ends',enabled:false,when:{type:'break-over'},do:[{scene:'live',after:0}],cooldownMs:0},
 {id:'slot-soon',name:'Break screen before the next match',enabled:false,when:{type:'slot-soon',minutes:10},do:[{scene:'break',breakMinutes:10,after:0}],cooldownMs:600_000},
 {id:'feed-lost',name:'Safe scene when the CS2 feed drops',enabled:false,when:{type:'feed-lost'},do:[{scene:'break',after:0}],cooldownMs:60_000},
 {id:'feed-restored',name:'Back to the game when the feed returns',enabled:false,when:{type:'feed-restored'},do:[{scene:'live',after:3}],cooldownMs:0},
];
export const defaultAutomation=():AutomationConfig=>({version:1,enabled:false,alerts:{webhook:'',onFeedLoss:true},rules:DEFAULT_RULES.map(rule=>({...rule,when:{...rule.when},do:rule.do.map(action=>({...action}))}))});
export function normalizeAutomation(raw:unknown):AutomationConfig {
 const parsed=automationConfigSchema.parse(raw??{});
 const rules=(parsed.rules??DEFAULT_RULES).map(rule=>({...rule,do:rule.do.map(action=>({...action}))}));
 // Duplicate ids would make "which rule fired" unanswerable in the audit trail.
 const seen=new Set<string>();
 for(const rule of rules){while(seen.has(rule.id)) rule.id=`${rule.id}-2`;seen.add(rule.id)}
 return {version:1,enabled:parsed.enabled===true,rules,alerts:{webhook:parsed.alerts?.webhook??'',onFeedLoss:parsed.alerts?.onFeedLoss!==false}};
}
// A trigger arrives from the host; only the facts the rules need are in the context. Everything is
// plain data, which is what makes the engine testable by replay.
export interface AutomationContext {now:number;scene:Controls['scene'];breakEndsAt:number|null}
// The triggers the host raises on its own clock rather than from a GSI packet.
export const HOST_TRIGGERS=['break-over','slot-soon','feed-lost','feed-restored'] as const;
export interface PendingAction {ruleId:string;ruleName:string;at:number;patch:Partial<Controls>}
export function buildPatch(action:AutomationAction):Partial<Controls> {
 const patch:Partial<Controls>={};
 if(action.scene) patch.scene=action.scene;
 return patch;
}
// Which actions a trigger schedules, with their absolute due times. Pure; the engine below only adds
// suspension, cooldowns, the lease and persistence around it.
export function scheduleForRules(rules:AutomationRule[],trigger:AutomationTrigger,ctx:AutomationContext):PendingAction[] {
 const out:PendingAction[]=[];
 for(const rule of rules){
  if(!rule.enabled||rule.when.type!==trigger.type) continue;
  if(trigger.type==='slot-soon'&&rule.when.minutes!==undefined&&trigger.minutes!==undefined&&rule.when.minutes>trigger.minutes) continue;
  let offsetMs=0;
  for(const action of rule.do){
   offsetMs+=Math.max(0,action.after??0)*1000;
   const patch:Partial<Controls>=buildPatch(action);
   if(action.breakMinutes!==undefined) patch.breakEndsAt=ctx.now+offsetMs+action.breakMinutes*60_000;
   out.push({ruleId:rule.id,ruleName:rule.name||rule.id,at:ctx.now+offsetMs,patch});
  }
 }
 return out;
}
export interface AutomationWriter {
 read():Pick<Controls,'scene'|'breakEndsAt'>;
 apply(patch:Partial<Controls>,rule:{id:string;name:string}):Promise<void>|void;
 leaseHeld():boolean;
}
export interface AutomationStatus {
 enabled:boolean;ruleCount:number;activeRules:string[];
 suspendedUntil:number|null;pending:Array<{ruleId:string;ruleName:string;at:number;scene?:string}>;
 lastAction:{at:number;ruleId:string;ruleName:string;scene?:string;breakEndsAt?:number|null}|null;
 lastSkip:{at:number;reason:'manual'|'lease'|'cooldown'|'duplicate';detail:string}|null;
}
export interface AutomationEngineOptions {now?:()=>number;log?:(message:string)=>void}
export class AutomationEngine {
 private config:AutomationConfig=defaultAutomation();
 private pending:PendingAction[]=[];
 private suspendedUntil=0;
 private lastFiredAt:Record<string,number>={};
 private lastAction:AutomationStatus['lastAction']=null;
 private lastSkip:AutomationStatus['lastSkip']=null;
 private readonly now:()=>number;
 private readonly log:(message:string)=>void;
 constructor(private readonly writer:AutomationWriter,options:AutomationEngineOptions={}){
  this.now=options.now??Date.now;
  this.log=options.log??(()=>{});
 }
 setConfig(next:AutomationConfig){
  this.config=normalizeAutomation(next);
  // Disabling (or removing a rule) must cancel anything it had already queued.
  this.pending=this.pending.filter(action=>this.config.enabled&&this.config.rules.some(rule=>rule.id===action.ruleId&&rule.enabled));
 }
 configView():AutomationConfig{return {version:1,enabled:this.config.enabled,alerts:{...this.config.alerts},rules:this.config.rules.map(rule=>({...rule,when:{...rule.when},do:rule.do.map(action=>({...action}))}))}}
 // A human touched the switcher: take the wheel for a minute and drop anything queued.
 suspend(reason='manual'){
  const at=this.now();
  this.suspendedUntil=at+MANUAL_SUSPEND_MS;
  if(this.pending.length){this.pending=[];this.lastSkip={at,reason:'manual',detail:'A manual scene change cancelled the queued auto-pilot actions.'}}
  return this.status();
 }
 trigger(trigger:AutomationTrigger):{scheduled:number;skipped?:string}{
  const at=this.now();
  if(!this.config.enabled||!this.config.rules.some(rule=>rule.enabled)) return {scheduled:0};
  if(at<this.suspendedUntil){this.lastSkip={at,reason:'manual',detail:`Auto-pilot is paused until ${new Date(this.suspendedUntil).toLocaleTimeString()} after a manual change.`};return {scheduled:0,skipped:'manual'}}
  if(this.writer.leaseHeld()){this.lastSkip={at,reason:'lease',detail:'Another operator holds the control lease; auto-pilot did not act.'};return {scheduled:0,skipped:'lease'}}
  const rules=this.config.rules.filter(rule=>rule.enabled&&rule.when.type===trigger.type);
  const due=scheduleForRules(rules,trigger,{now:at,...this.writer.read()});
  const accepted:PendingAction[]=[];
  for(const action of due){
   const rule=this.config.rules.find(candidate=>candidate.id===action.ruleId);
   if(!rule) continue;
   const last=this.lastFiredAt[rule.id]??0;
   if(rule.cooldownMs&&at-last<rule.cooldownMs){this.lastSkip={at,reason:'cooldown',detail:`${rule.name||rule.id} is cooling down.`};continue}
   // A second trigger while the first is still waiting must not stack two scene changes.
   if(this.pending.some(existing=>existing.ruleId===action.ruleId&&existing.patch.scene===action.patch.scene&&existing.patch.breakEndsAt===action.patch.breakEndsAt)){
    this.lastSkip={at,reason:'duplicate',detail:`${rule.name||rule.id} is already queued.`};continue;
   }
   accepted.push(action);
  }
  this.pending=[...this.pending,...accepted].sort((first,second)=>first.at-second.at);
  return {scheduled:accepted.length};
 }
 async tick(now=this.now()):Promise<PendingAction[]> {
  if(!this.pending.length) return [];
  const due=this.pending.filter(action=>action.at<=now);
  if(!due.length) return [];
  this.pending=this.pending.filter(action=>action.at>now);
  const applied:PendingAction[]=[];
  for(const action of due){
   if(!this.config.enabled) break;
   if(now<this.suspendedUntil){this.lastSkip={at:now,reason:'manual',detail:'A manual change arrived before auto-pilot acted.'};break}
   if(this.writer.leaseHeld()){this.lastSkip={at:now,reason:'lease',detail:'Another operator holds the control lease; auto-pilot did not act.'};break}
   try{
    await this.writer.apply(action.patch,{id:action.ruleId,name:action.ruleName});
    this.lastFiredAt[action.ruleId]=now;
    this.lastAction={at:now,ruleId:action.ruleId,ruleName:action.ruleName,scene:action.patch.scene,breakEndsAt:action.patch.breakEndsAt ?? null};
    applied.push(action);
    this.log(`[automation] ${action.ruleName}: ${action.patch.scene??'countdown'} applied`);
   }catch(error:any){
    this.log(`[automation] ${action.ruleName} could not be applied: ${error?.message||error}`);
   }
  }
  return applied;
 }
 status():AutomationStatus {
  const at=this.now();
  return {
   enabled:this.config.enabled,
   ruleCount:this.config.rules.length,
   activeRules:this.config.rules.filter(rule=>rule.enabled).map(rule=>rule.id),
   suspendedUntil:at<this.suspendedUntil?this.suspendedUntil:null,
   pending:this.pending.map(action=>({ruleId:action.ruleId,ruleName:action.ruleName,at:action.at,scene:action.patch.scene})),
   lastAction:this.lastAction,
   lastSkip:this.lastSkip,
  };
 }
}
