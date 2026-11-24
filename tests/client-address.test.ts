import {test} from 'node:test';
import assert from 'node:assert/strict';
import {platformHost} from './helpers/platform-host';

// The public website reaches its account service through the host's proxy, so every request the
// service sees comes from the host's own loopback socket. The per-address limits (failed sign-ins,
// applications, password recovery) must still be per *visitor*: one person guessing passwords must
// not lock every other visitor out of signing in, and the fourth applicant of the hour must not be
// refused because three strangers applied before them.
const login=(email='nobody@example.com')=>({email,password:'not-the-password'});
const apply=(index:number)=>({name:'Applicant',email:`applicant${index}@example.com`});
const from=(address:string,extra:Record<string,string>={})=>({headers:{'X-Forwarded-For':address,...extra}});

test('behind a trusted proxy, sign-in and application limits apply to each visitor',async t=>{
 const site=await platformHost(t,{SCOUT_SURFACE:'site',SCOUT_EMBED_ACCOUNT_SERVICE:'1',SCOUT_BETA_API_KEY:'client-address-key',SCOUT_TRUST_PROXY:'1'});
 for(let attempt=0;attempt<8;attempt++){
  const refused=await site.request('/api/beta/login',login(),from('198.51.100.1'));
  assert.equal(refused.status,401,`failed sign-in ${attempt+1}`);
 }
 const locked=await site.request('/api/beta/login',login(),from('198.51.100.1'));
 assert.equal(locked.status,429,'the visitor who kept guessing is throttled');
 assert.match(locked.body.error,/198\.51\.100\.1/,'and the refusal names that visitor, not the host');
 const other=await site.request('/api/beta/login',login(),from('198.51.100.2'));
 assert.equal(other.status,401,'a different visitor can still try to sign in');

 for(let index=0;index<4;index++){
  const applied=await site.request('/api/beta/apply',apply(index),from(`198.51.100.${20+index}`));
  assert.equal(applied.status,200,`application from visitor ${index+1}`);
 }
 // A body field must not choose the bucket: the host's proxy is the only authority on the address.
 for(let index=10;index<13;index++){
  const applied=await site.request('/api/beta/apply',{...apply(index),address:`203.0.113.${index}`},from('198.51.100.40'));
  assert.equal(applied.status,200);
 }
 const fourth=await site.request('/api/beta/apply',{...apply(13),address:'203.0.113.99'},from('198.51.100.40'));
 assert.equal(fourth.status,429,'a made-up address in the body does not escape the limit');
});

test('without SCOUT_TRUST_PROXY a forged X-Forwarded-For header changes nothing',async t=>{
 const site=await platformHost(t,{SCOUT_SURFACE:'site',SCOUT_EMBED_ACCOUNT_SERVICE:'1',SCOUT_BETA_API_KEY:'client-address-key'});
 for(let attempt=0;attempt<8;attempt++){
  const refused=await site.request('/api/beta/login',login(),from(`198.51.100.${attempt}`));
  assert.equal(refused.status,401);
 }
 const locked=await site.request('/api/beta/login',login(),from('198.51.100.200'));
 assert.equal(locked.status,429,'every request comes from the same socket, whatever the header claims');
 // A browser cannot name its own address through the account service's header either.
 const forged=await site.request('/api/beta/login',login(),from('198.51.100.201',{'X-Scout-Client-Address':'192.0.2.1'}));
 assert.equal(forged.status,429);
});
