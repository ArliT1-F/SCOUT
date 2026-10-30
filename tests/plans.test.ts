import test from 'node:test';
import assert from 'node:assert/strict';
import {PLANS,entitlementsFor,canCreateTournament,hasFeature,planRefusal,trialDaysLeft,needsPayment,emptyBilling,isPlanId,planIds,publicPlanViews} from '../server/plans.js';
import type {PlanId} from '../server/plans.js';

// Launch gate (docs/LAUNCH-FEATURES.md §5). Two rules a test can hold the product to:
//   1. a plan is a limit on what can be *started*, never a switch that takes a running broadcast off air;
//   2. a payment problem changes an entitlement, and never the licence state of an installation.
const now=Date.UTC(2026,9,29,12,0,0);
const account=(over:Record<string,unknown>={})=>({id:'a1',email:'a@example.com',status:'approved',plan:null,trialEndsAt:null,billing:null,...over} as any);
const active=(plan:PlanId,over:Record<string,unknown>={})=>account({plan,billing:{status:'active',customerId:'cus',subscriptionId:'sub',currentPeriodEnd:now+30*86_400_000,updatedAt:now-86_400_000},...over});

test('every plan gives the product, and only the limits and features differ',()=>{
 for(const id of planIds()){
  const plan=PLANS[id];
  assert.ok(plan.tournaments>=1,`${id} must allow at least one tournament`);
  assert.ok(plan.devices>=1);
  assert.ok(plan.features.includes('hub'),'the public tournament page ships with every plan');
  assert.equal(plan.currency,'EUR');
  assert.ok(isPlanId(id));
 }
 assert.equal(isPlanId('enterprise'),false);
 // The two plans on the pricing page are published; trial and founder are not for sale.
 assert.deepEqual(publicPlanViews(null).map(plan=>plan.id),['organiser','venue']);
});

test('an approved account with no plan is a Founder, not a locked account',()=>{
 // Every closed-beta account predates billing. Shipping a paywall would take the product away from
 // the people who tested it, so "approved, no plan" is the Founder tier.
 const entitlements=entitlementsFor(account(),now);
 assert.equal(entitlements.plan,'founder');
 assert.equal(entitlements.status,'active');
 assert.equal(entitlements.tournaments,PLANS.founder.tournaments);
 assert.equal(entitlements.features.length,PLANS.founder.features.length);
});

test('a pending or revoked application has no entitlements at all',()=>{
 for(const status of ['pending','rejected','revoked']){
  const entitlements=entitlementsFor(account({status}),now);
  assert.equal(entitlements.plan,null,status);
  assert.equal(entitlements.tournaments,0,status);
  assert.deepEqual(entitlements.features,[],status);
 }
});

test('a trial runs for its window and then simply stops allowing a new tournament',()=>{
 const trial=account({plan:'trial',trialEndsAt:now+5*86_400_000});
 const running=entitlementsFor(trial,now);
 assert.equal(running.plan,'trial');
 assert.equal(running.status,'trial');
 assert.equal(trialDaysLeft(trial,now),5);
 assert.equal(running.features.includes('hub'),true);
 const expired=entitlementsFor({...trial,trialEndsAt:now-1000} as any,now);
 assert.equal(expired.status,'expired');
 assert.equal(expired.plan,'trial','the plan they had is still named, so the profile can offer it again');
 assert.equal(expired.tournaments,0);
 assert.deepEqual(expired.features,[],'an ended plan no longer unlocks new features');
 assert.equal(canCreateTournament(expired,0),false);
 assert.match(planRefusal(expired)||'',/trial/i);
});

test('a past-due account keeps its limits for the grace week, then may not start anything new',()=>{
 const pastDue=account({plan:'organiser',billing:{...emptyBilling('past_due'),updatedAt:now-2*86_400_000}});
 const during=entitlementsFor(pastDue,now);
 assert.equal(during.plan,'organiser','the plan is still theirs while the grace window runs');
 assert.equal(during.status,'delinquent');
 assert.equal(during.tournaments,PLANS.organiser.tournaments,'nothing they are already running changes');
 assert.equal(canCreateTournament(during,0),true,'seven days is time to fix a card, not a lockout');
 const later=entitlementsFor(givenBilling(pastDue,now-30*86_400_000),now);
 assert.equal(later.plan,'organiser');
 assert.equal(canCreateTournament(later,0),false,'after the grace week a new tournament needs a payment');
 assert.match(planRefusal(later)||'',/payment/i);
});

test('a cancelled subscription keeps the period it paid for',()=>{
 const cancelled=account({plan:'venue',billing:{status:'canceled',customerId:'cus',subscriptionId:null,currentPeriodEnd:now+3*86_400_000,updatedAt:now}});
 const entitlements=entitlementsFor(cancelled,now);
 assert.equal(entitlements.plan,'venue','the month is paid; the month stays');
 assert.equal(entitlements.features.includes('multi-host'),true);
 const afterEnd=entitlementsFor({...cancelled,billing:{...cancelled.billing,currentPeriodEnd:now-1000}},now);
 assert.equal(afterEnd.status,'expired');
 assert.equal(afterEnd.features.includes('multi-host'),false);
});

test('the tournament limit is checked where a tournament starts',()=>{
 const organiser=entitlementsFor(active('organiser'),now);
 assert.equal(canCreateTournament(organiser,0),true);
 assert.equal(canCreateTournament(organiser,2),true);
 assert.equal(canCreateTournament(organiser,3),false,'Organiser allows three');
 assert.match(planRefusal(organiser,3)||'',/Organiser/);
 const venue=entitlementsFor(active('venue'),now);
 assert.equal(canCreateTournament(venue,9),true);
 assert.equal(canCreateTournament(venue,10),false);
});

test('features are a set, and an upgrade adds to it',()=>{
 const organiser=entitlementsFor(active('organiser'),now);
 assert.equal(hasFeature(organiser,'hub'),true);
 assert.equal(hasFeature(organiser,'automation'),true);
 assert.equal(hasFeature(organiser,'recap-delivery'),true);
 assert.equal(hasFeature(organiser,'multi-host'),false,'multi-host is the Venue differentiator');
 const venue=entitlementsFor(active('venue'),now);
 assert.equal(hasFeature(venue,'multi-host'),true);
 assert.equal(venue.devices>organiser.devices,true);
});

test('needsPayment is what the profile page shows, and it is never a licence problem',()=>{
 assert.equal(needsPayment(entitlementsFor(active('organiser'),now)),false);
 assert.equal(needsPayment(entitlementsFor(account({plan:'trial',trialEndsAt:now+86_400_000}),now)),false,'a trial is not a payment problem');
 assert.equal(needsPayment(entitlementsFor(account({plan:'organiser',billing:{...emptyBilling('past_due'),updatedAt:now}}),now)),true);
 assert.equal(needsPayment(entitlementsFor(account({status:'pending'}),now)),false,'pending is an application, not a debt');
});

test('the public plan views carry the price a stranger sees',()=>{
 const views=publicPlanViews('organiser');
 const organiser=views.find(view=>view.id==='organiser');
 assert.ok(organiser);
 assert.equal(organiser.current,true);
 assert.equal(organiser.priceCents,1900);
 assert.equal(organiser.currency,'EUR');
 assert.equal(views.find(view=>view.id==='venue')?.current,false);
});
function givenBilling(base:any,updatedAt:number){
 return {...base,billing:{...base.billing,updatedAt}};
}
