// Billing (docs/LAUNCH-FEATURES.md §5). Stripe is the provider because it is the one a small
// tournament organiser can already pay with; there is no SDK dependency — the three requests this
// product needs are plain form POSTs, and the webhook is an HMAC this file verifies itself.
//
// Everything here is injectable: tests drive checkout with a stub fetch and sign webhooks with a
// throwaway secret, so the money path is covered without a Stripe account or a network.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {PLANS,isPlanId,type BillingState,type PlanId} from './plans.js';

export type BillingProvider='none'|'stripe';
export interface BillingConfig {
 provider:BillingProvider;
 secretKey:string;
 webhookSecret:string;
 baseUrl:string;
 // Price ids are per-deployment: a test-mode deployment and production point at different objects,
 // and a plan without a price id simply cannot be bought yet.
 priceIds:Partial<Record<PlanId,string>>;
}
export function billingConfiguration(env:NodeJS.ProcessEnv=process.env):BillingConfig {
 const provider=(env.SCOUT_BILLING_PROVIDER||'none').toLowerCase()==='stripe'?'stripe':'none';
 const priceIds:Partial<Record<PlanId,string>>={};
 for(const id of ['organiser','venue'] as PlanId[]){
  const value=env[`SCOUT_STRIPE_PRICE_${id.toUpperCase()}`];
  if(value&&/^price_[A-Za-z0-9_]{4,64}$/.test(value)) priceIds[id]=value;
 }
 return {
  provider,
  secretKey:env.SCOUT_STRIPE_SECRET_KEY||'',
  webhookSecret:env.SCOUT_STRIPE_WEBHOOK_SECRET||'',
  baseUrl:(env.SCOUT_ACCOUNT_BASE_URL||env.SCOUT_PLATFORM_URL||'').replace(/\/+$/,''),
  priceIds,
 };
}
export function billingReady(config:BillingConfig):boolean {
 return config.provider==='stripe'&&/^sk_(test|live)_/.test(config.secretKey)&&Boolean(config.webhookSecret)&&Object.keys(config.priceIds).length>0;
}
export interface CheckoutInput {plan:PlanId;accountId:string;email:string;successUrl:string;cancelUrl:string}
export type CheckoutResult={ok:true;url:string;id:string}|{ok:false;status:number;message:string};
export function checkoutForm(input:CheckoutInput,priceId:string):URLSearchParams {
 const form=new URLSearchParams();
 form.set('mode','subscription');
 form.set('customer_email',input.email);
 form.set('client_reference_id',input.accountId);
 form.set('success_url',input.successUrl);
 form.set('cancel_url',input.cancelUrl);
 form.set('allow_promotion_codes','true');
 form.set('line_items[0][price]',priceId);
 form.set('line_items[0][quantity]','1');
 form.set('metadata[accountId]',input.accountId);
 form.set('metadata[plan]',input.plan);
 form.set('subscription_data[metadata][accountId]',input.accountId);
 form.set('subscription_data[metadata][plan]',input.plan);
 return form;
}
export async function createCheckoutSession(config:BillingConfig,input:CheckoutInput,fetchImpl:typeof fetch=fetch):Promise<CheckoutResult> {
 if(!billingReady(config)) return {ok:false,status:503,message:'Billing is not configured on this deployment yet. Ask the SCOUT owner to set the Stripe keys, or contact them for a manual invoice.'};
 const priceId=config.priceIds[input.plan];
 if(!priceId) return {ok:false,status:400,message:`The ${PLANS[input.plan].name} plan has no price configured yet.`};
 try{
  const response=await fetchImpl('https://api.stripe.com/v1/checkout/sessions',{
   method:'POST',
   headers:{Authorization:`Bearer ${config.secretKey}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`scout-${input.accountId}-${input.plan}-${Math.floor(Date.now()/60_000)}`},
   body:checkoutForm(input,priceId).toString(),
   signal:AbortSignal.timeout(10_000),
  });
  const body:any=await response.json().catch(()=>({}));
  if(!response.ok||!body?.url) return {ok:false,status:response.status||502,message:body?.error?.message?String(body.error.message).slice(0,200):'Stripe did not return a checkout URL.'};
  return {ok:true,url:String(body.url),id:String(body.id||'')};
 }catch(error:any){
  return {ok:false,status:502,message:`Could not reach Stripe: ${error?.message||error}`};
 }
}
// Stripe's documented scheme: `t=<unix>,v1=<hex hmac of "t.payload">`, possibly several v1 entries
// during a secret rotation. The timestamp tolerance stops a captured request being replayed later.
export function verifyStripeSignature(payload:string|Buffer,header:string|undefined,secret:string,options:{toleranceSec?:number;now?:number}={}):{ok:boolean;reason?:string} {
 if(!secret) return {ok:false,reason:'no webhook secret configured'};
 if(!header) return {ok:false,reason:'missing signature header'};
 const parts=header.split(',').map(part=>part.trim()).filter(Boolean);
 const timestamp=parts.find(part=>part.startsWith('t='))?.slice(2);
 const signatures=parts.filter(part=>part.startsWith('v1=')).map(part=>part.slice(3));
 if(!timestamp||!signatures.length) return {ok:false,reason:'malformed signature header'};
 const sentAt=Number(timestamp);
 const tolerance=options.toleranceSec??300;
 if(!Number.isFinite(sentAt)) return {ok:false,reason:'malformed timestamp'};
 if(Math.abs((options.now??Date.now())/1000-sentAt)>tolerance) return {ok:false,reason:'timestamp outside the tolerance window'};
 const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(payload).digest();
 for(const candidate of signatures){
  if(!/^[0-9a-f]{64}$/i.test(candidate)) continue;
  const actual=Buffer.from(candidate,'hex');
  if(actual.length===expected.length&&timingSafeEqual(actual,expected)) return {ok:true};
 }
 return {ok:false,reason:'no matching signature'};
}
export interface BillingEvent {id:string;type:string;accountId:string|null;email:string|null;plan:PlanId|null;status:BillingState['status'];currentPeriodEnd:number|null}
const statusMap:Record<string,BillingState['status']>={active:'active',trialing:'active',past_due:'past_due',unpaid:'past_due',canceled:'canceled',incomplete_expired:'canceled',incomplete:'past_due',paused:'canceled'};
// The subset of Stripe events that changes an entitlement. Anything else is acknowledged and ignored:
// a webhook endpoint that reacts to every event is a webhook endpoint nobody can reason about.
export function parseStripeEvent(event:any):BillingEvent|null {
 const type=String(event?.type||'');
 const object=event?.data?.object||{};
 const supported=/^(checkout\.session\.completed|customer\.subscription\.(created|updated|deleted)|invoice\.(paid|payment_failed))$/;
 if(!supported.test(type)) return null;
 const rawStatus=type==='invoice.payment_failed'?'past_due':type==='customer.subscription.deleted'?'canceled':String(object.status||'active');
 const status=statusMap[rawStatus]??'active';
 const metadata=object.metadata||object.subscription_details?.metadata||{};
 const plan=isPlanId(metadata.plan)?metadata.plan:null;
 const periodEnd=Number(object.current_period_end??object.lines?.data?.[0]?.period?.end??0);
 return {
  id:String(event?.id||''),
  type,
  accountId:String(object.client_reference_id||metadata.accountId||'')||null,
  email:String(object.customer_email||object.customer_details?.email||object.customer||'')||null,
  plan,
  status,
  currentPeriodEnd:Number.isFinite(periodEnd)&&periodEnd>0?periodEnd*1000:null,
 };
}
// Replay protection: an event id is applied once, and the ledger is small and bounded. A duplicate
// delivery is a fact of life with webhooks and must never double-provision an account.
export class BillingLedger {
 private ids:string[]=[];
 constructor(private readonly file='config/billing/events.json',private readonly cap=2000){}
 async load(){try{const parsed=JSON.parse(await readFile(this.file,'utf8'));if(Array.isArray(parsed?.ids))this.ids=parsed.ids.filter((id:unknown):id is string=>typeof id==='string').slice(-this.cap)}catch{}return this}
 has(id:string){return this.ids.includes(id)}
 async add(id:string){
  if(!id||this.has(id)) return;
  this.ids.push(id);this.ids=this.ids.slice(-this.cap);
  await mkdir(path.dirname(this.file),{recursive:true});
  await writeFile(this.file+'.tmp',JSON.stringify({version:1,ids:this.ids}),{mode:0o600});
  await rename(this.file+'.tmp',this.file);
 }
}
