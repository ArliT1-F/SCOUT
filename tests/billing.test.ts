import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BillingLedger,billingConfiguration,billingReady,checkoutForm,createCheckoutSession,parseStripeEvent,verifyStripeSignature} from '../server/billing.js';

// Launch gate (docs/LAUNCH-FEATURES.md §5), the parts that face the payment provider. The webhook is
// the only unauthenticated route in the product that can change an account, so its signature check,
// its replay guard and its "ignore what I do not understand" behaviour are all load-bearing.
const sign=(payload:string,secret:string,at=Math.floor(Date.now()/1000))=>`t=${at},v1=${createHmac('sha256',secret).update(`${at}.${payload}`).digest('hex')}`;

test('billing is off until it is configured, and says so',()=>{
 const none=billingConfiguration({});
 assert.equal(none.provider,'none');
 assert.equal(billingReady(none),false);
 const half=billingConfiguration({SCOUT_BILLING_PROVIDER:'stripe',SCOUT_STRIPE_SECRET_KEY:'sk_test_123'});
 assert.equal(billingReady(half),false,'a secret without a webhook secret cannot verify anything');
 const full=billingConfiguration({SCOUT_BILLING_PROVIDER:'stripe',SCOUT_STRIPE_SECRET_KEY:'sk_test_123',SCOUT_STRIPE_WEBHOOK_SECRET:'whsec_1',SCOUT_STRIPE_PRICE_ORGANISER:'price_organiser1',SCOUT_STRIPE_PRICE_VENUE:'price_venue1'});
 assert.equal(billingReady(full),true);
 assert.equal(full.priceIds.organiser,'price_organiser1');
 assert.equal(full.priceIds.venue,'price_venue1');
});

test('a checkout session names the account, the plan and where to come back to',()=>{
 const form=checkoutForm({plan:'venue',accountId:'acct_1',email:'a@example.com',successUrl:'https://scout.example/profile?checkout=success',cancelUrl:'https://scout.example/pricing'},'price_venue1');
 assert.equal(form.get('mode'),'subscription');
 assert.equal(form.get('client_reference_id'),'acct_1');
 assert.equal(form.get('customer_email'),'a@example.com');
 assert.match(String(form.get('success_url')),/checkout=success/);
 assert.equal(form.get('metadata[plan]'),'venue','the plan travels with the session so the webhook needs no lookup');
 assert.equal(form.get('line_items[0][price]'),'price_venue1');
});

test('checkout refuses to invent a session when Stripe is not configured',async()=>{
 const result=await createCheckoutSession(billingConfiguration({}),{plan:'organiser',accountId:'a',email:'a@example.com',successUrl:'https://x/y',cancelUrl:'https://x/z'});
 assert.equal(result.ok,false);
 if(!result.ok) assert.equal(result.status,503);
});

test('the signature check accepts a real signature and rejects every forgery',()=>{
 const payload=JSON.stringify({id:'evt_1',type:'invoice.paid'});
 const secret='whsec_test';
 assert.equal(verifyStripeSignature(payload,sign(payload,secret),secret).ok,true);
 assert.equal(verifyStripeSignature(payload,sign(payload,'wrong'),secret).ok,false);
 assert.equal(verifyStripeSignature(payload,undefined,secret).ok,false);
 assert.equal(verifyStripeSignature(payload,'garbage',secret).ok,false);
 assert.equal(verifyStripeSignature(payload,sign(payload,secret),'').ok,false);
 const old=sign(payload,secret,Math.floor(Date.now()/1000)-3600);
 const stale=verifyStripeSignature(payload,old,secret);
 assert.equal(stale.ok,false);
 assert.match(stale.reason||'',/tolerance/);
 // A body swapped after signing must not verify.
 assert.equal(verifyStripeSignature(payload.replace('evt_1','evt_2'),sign(payload,secret),secret).ok,false);
 // Secret rotation: two v1 entries, one of which is right.
 const [timestamp]=sign(payload,secret).split(',');
 assert.equal(verifyStripeSignature(payload,`${timestamp},v1=${'0'.repeat(64)},v1=${sign(payload,secret).split('v1=')[1]}`,secret).ok,true);
});

test('an event is translated to the one field that changes: the entitlement',()=>{
 const completed=parseStripeEvent({id:'evt_1',type:'checkout.session.completed',data:{object:{client_reference_id:'acct_1',customer_email:'a@example.com',status:'complete',metadata:{plan:'organiser'},current_period_end:1_800_000_000}}});
 assert.ok(completed);
 assert.equal(completed.accountId,'acct_1');
 assert.equal(completed.plan,'organiser');
 assert.equal(completed.status,'active');
 assert.equal(completed.currentPeriodEnd,1_800_000_000_000);
 assert.equal(parseStripeEvent({id:'evt_2',type:'invoice.payment_failed',data:{object:{customer:'cus_1',status:'past_due'}}})?.status,'past_due');
 assert.equal(parseStripeEvent({id:'evt_3',type:'customer.subscription.deleted',data:{object:{status:'canceled'}}})?.status,'canceled');
 assert.equal(parseStripeEvent({id:'evt_4',type:'customer.created',data:{object:{}}}),null,'an unrelated event is ignored, not guessed at');
});

test('a replayed webhook is applied once',async()=>{
 const file=path.join(await mkdtemp(path.join(tmpdir(),'scout-billing-')),'events.json');
 const ledger=await new BillingLedger(file).load();
 assert.equal(ledger.has('evt_1'),false);
 await ledger.add('evt_1');
 assert.equal(ledger.has('evt_1'),true);
 await ledger.add('evt_1');
 const reloaded=await new BillingLedger(file).load();
 assert.equal(reloaded.has('evt_1'),true,'the guard survives a restart');
});
