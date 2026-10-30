// Plans and entitlements (docs/LAUNCH-FEATURES.md §5). One place decides what an account may do,
// and the answer is a set of limits and features — never a switch that can take a live broadcast
// off air. `server/licensing.ts` still owns "may this installation run at all"; a payment problem
// changes an *entitlement*, not a licence state mid-series.
import type {ApplicationStatus} from './beta.js';

export type PlanId='trial'|'organiser'|'venue'|'founder';
export type Feature='hub'|'automation'|'recap-delivery'|'multi-host'|'priority-support';
export interface Plan {
 id:PlanId;name:string;tagline:string;priceCents:number;currency:'EUR';interval:'month';
 tournaments:number;devices:number;features:Feature[];public:boolean;trialDays?:number;
}
// Prices are configuration, not code: the owner desk edits them (and the plan names) through
// platform settings. These are the defaults a fresh deployment starts with.
export const PLANS:Record<PlanId,Plan>={
 trial:{id:'trial',name:'Trial',tagline:'Try a full broadcast for two weeks',priceCents:0,currency:'EUR',interval:'month',tournaments:1,devices:1,features:['hub','automation','recap-delivery'],public:false,trialDays:14},
 organiser:{id:'organiser',name:'Organiser',tagline:'For weekly cups and community leagues',priceCents:1900,currency:'EUR',interval:'month',tournaments:3,devices:2,features:['hub','automation','recap-delivery'],public:true},
 venue:{id:'venue',name:'Venue',tagline:'For LANs, studios and production crews',priceCents:4900,currency:'EUR',interval:'month',tournaments:10,devices:5,features:['hub','automation','recap-delivery','multi-host','priority-support'],public:true},
 // Founder is not sold: it is what every existing closed-beta account keeps at launch.
 founder:{id:'founder',name:'Founder',tagline:'Beta cohort — everything, at the price it launched with',priceCents:0,currency:'EUR',interval:'month',tournaments:10,devices:5,features:['hub','automation','recap-delivery','multi-host','priority-support'],public:false},
};
export const PUBLIC_PLANS:PlanId[]=['organiser','venue'];
export const TRIAL_DAYS=PLANS.trial.trialDays??14;
export function planIds():PlanId[]{return Object.keys(PLANS) as PlanId[]}
export function isPlanId(value:unknown):value is PlanId{return typeof value==='string'&&value in PLANS}
export const FEATURE_LABELS:Record<Feature,string>={
 hub:'Public tournament pages',
 automation:'Auto-pilot scene rules',
 'recap-delivery':'Recap delivery (Discord & email)',
 'multi-host':'More than two linked hosts',
 'priority-support':'Priority support',
};
export interface BillingState {
 status:'active'|'past_due'|'canceled'|'none';
 customerId:string|null;
 subscriptionId:string|null;
 currentPeriodEnd:number|null;
 updatedAt:number|null;
}
export const emptyBilling=(status:BillingState['status']='none'):BillingState=>({status,customerId:null,subscriptionId:null,currentPeriodEnd:null,updatedAt:null});
// What the account store adds to an account. All optional, so every existing store file and every
// existing account-service row keeps loading without a migration step in the application code.
export interface AccountPlanFields {plan?:PlanId|null;trialEndsAt?:number|null;billing?:BillingState|null}
export type EntitlementStatus='none'|'trial'|'active'|'expired'|'delinquent'|'revoked';
export interface Entitlements {
 plan:PlanId|null;status:EntitlementStatus;planName:string;
 trialEndsAt:number|null;trialDaysLeft:number|null;graceEndsAt:number|null;
 tournaments:number;devices:number;features:Feature[];
 // Whether a *new* tournament may be created. Existing ones and the current broadcast are untouched
 // by every rule in this module — that is the whole point of returning a limit, not a kill switch.
 allowNewTournament:boolean;
 message:string;
}
// A failed card does not stop the show. Delinquent accounts keep full entitlements for a week
// (DUNNING_GRACE_MS) and may not start a *new* tournament; nothing they are already running changes.
export const DUNNING_GRACE_MS=7*24*60*60*1000;
const NONE:Entitlements={plan:null,status:'none',planName:'No plan',trialEndsAt:null,trialDaysLeft:null,graceEndsAt:null,tournaments:0,devices:0,features:[],allowNewTournament:false,message:'An approved account with a trial or a plan is required to host on SCOUT.'};
function fromPlan(plan:Plan,status:EntitlementStatus,extra:Partial<Entitlements>={}):Entitlements {
 return {plan:plan.id,status,planName:plan.name,trialEndsAt:null,trialDaysLeft:null,graceEndsAt:null,tournaments:plan.tournaments,devices:plan.devices,features:[...plan.features],allowNewTournament:true,message:'',...extra};
}
export interface AccountPlanInput extends AccountPlanFields {status?:ApplicationStatus}
const paidPlan=(account:AccountPlanInput):Plan=>{
 const id=account.plan;
 return isPlanId(id)&&id!=='trial'?PLANS[id]:PLANS.organiser;
};
// Pure and clock-injected: the tests can walk a trial from day 0 to day 40 without waiting.
export function entitlementsFor(account:AccountPlanInput|null|undefined,now=Date.now()):Entitlements {
 if(!account) return {...NONE,message:'Sign in with an approved SCOUT account to see your plan.'};
 if(account.status&&account.status!=='approved'){
  return {...NONE,status:account.status==='revoked'?'revoked':'none',
   message:account.status==='revoked'?'This account was revoked. Contact the SCOUT owner if you believe that is a mistake.':'This account is waiting for approval. You can start a 14-day trial in the meantime.'};
 }
 const billing=account.billing??null;
 if(billing&&billing.status==='active') return fromPlan(paidPlan(account),'active');
 if(billing&&billing.status==='canceled'){
  if(billing.currentPeriodEnd&&billing.currentPeriodEnd>now)
   return fromPlan(paidPlan(account),'active',{message:'This plan is canceled but paid until its period ends. You can start another tournament until then.'});
  return {...fromPlan(paidPlan(account),'expired'),allowNewTournament:false,tournaments:0,features:[],message:'This plan has ended. Your past work is safe; restart it from your profile to broadcast again.'};
 }
 if(billing&&billing.status==='past_due'){
  const graceEndsAt=(billing.updatedAt??now)+DUNNING_GRACE_MS;
  const inGrace=graceEndsAt>now;
  return {...fromPlan(paidPlan(account),'delinquent'),graceEndsAt,allowNewTournament:inGrace,
   message:inGrace?'Your last payment failed — update the card in your profile. Everything you are running stays on air; you can still start a tournament during the grace week.':'Your last payment failed and the grace week has passed. Your current tournament and broadcast keep running; update the card to start another tournament.'};
 }
 if(account.plan==='founder') return fromPlan(PLANS.founder,'active',{message:'Closed-beta account: full access at the beta price.'});
 const trialEndsAt=account.trialEndsAt??null;
 if(trialEndsAt!==null){
  if(trialEndsAt>now) return fromPlan(PLANS.trial,'trial',{trialEndsAt,trialDaysLeft:Math.max(0,Math.ceil((trialEndsAt-now)/86_400_000))});
  return {...fromPlan(PLANS.trial,'expired'),allowNewTournament:false,tournaments:0,features:[],trialEndsAt,trialDaysLeft:0,message:'The trial has ended. Your past work is safe; choose a plan to start another tournament.'};
 }
 // An approved account that predates plans: Founder, so nobody is downgraded by a schema addition.
 return fromPlan(PLANS.founder,'active',{message:'Closed-beta account: full access at the beta price.'});
}
export function hasFeature(entitlements:Entitlements,feature:Feature):boolean{return entitlements.features.includes(feature)}
export function canCreateTournament(entitlements:Entitlements,currentCount:number):boolean{
 return entitlements.allowNewTournament&&currentCount<entitlements.tournaments;
}
export function planRefusal(entitlements:Entitlements,used?:number):string|null {
 if(!entitlements.allowNewTournament) return entitlements.message||'This account cannot start a new tournament right now.';
 // `used` is optional so a caller that has not counted yet still gets the "why not" answer; a caller
 // that has counted gets the message about the limit itself, which is the one an operator can act on.
 if(typeof used==='number'&&used>=entitlements.tournaments)
  return `The ${entitlements.planName} plan runs ${entitlements.tournaments} tournament${entitlements.tournaments===1?'':'s'} at a time. Archive one, or move up a plan.`;
 return null;
}
// What the website shows: prices, limits and features, from the same objects the server enforces.
export interface PublicPlanView {id:PlanId;name:string;tagline:string;priceCents:number;currency:string;interval:string;tournaments:number;devices:number;features:Feature[];current:boolean}
export function publicPlanViews(current:PlanId|null):PublicPlanView[] {
 return PUBLIC_PLANS.map(id=>{
  const plan=PLANS[id];
  return {id:plan.id,name:plan.name,tagline:plan.tagline,priceCents:plan.priceCents,currency:plan.currency,interval:plan.interval,tournaments:plan.tournaments,devices:plan.devices,features:[...plan.features],current:current===id};
 });
}
export function formatPrice(cents:number,currency='EUR'):string {
 if(cents===0) return 'Free';
 // Node 20 has full ICU in the shipped builds; a deployment without it would print "EUR 19.00",
 // which is still readable, so this never throws.
 try{return new Intl.NumberFormat('en-IE',{style:'currency',currency,maximumFractionDigits:cents%100?2:0}).format(cents/100)}catch{return `${currency} ${(cents/100).toFixed(2)}`}
}
// The two questions the profile page and the panel ask, so neither of them re-derives the answer.
export function trialDaysLeft(account:AccountPlanInput|null|undefined,now=Date.now()):number|null {
 const ends=account?.trialEndsAt??null;
 if(ends===null||account?.plan!=='trial') return null;
 return Math.max(0,Math.ceil((ends-now)/86_400_000));
}
export function needsPayment(entitlements:Entitlements):boolean{return entitlements.status==='delinquent'}
