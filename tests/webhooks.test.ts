import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecapDiscordMessage,deliverWebhook,validateWebhookUrl,WebhookError} from '../server/webhooks.js';
import {buildRecap} from '../server/recap.js';
import type {MatchArchive} from '../server/recordings.js';

// Recap delivery (docs/LAUNCH-FEATURES.md §4). A webhook URL is user input that this process will
// POST to, which makes it an SSRF primitive unless it is validated: https only, public host only,
// and no following redirects into the private network.
const recap=buildRecap({
 id:'m1',name:'Autumn Cup final',startedAt:1_000,endedAt:2_000,event:'Autumn Cup',stage:'Final',
 teams:['Vertex','Parallax'],maps:['de_mirage'],format:'bo3',events:[],
} as MatchArchive);

test('only an https URL on a public host is accepted',()=>{
 const target=validateWebhookUrl('https://discord.com/api/webhooks/123/abc');
 assert.equal(target.kind,'discord');
 assert.equal(validateWebhookUrl('https://example.com/hook').kind,'webhook');
 for(const hostile of [
  'http://example.com/hook',
  'ftp://example.com/x',
  'javascript:alert(1)',
  'https://127.0.0.1/hook',
  'https://localhost/hook',
  'https://10.0.0.5/hook',
  'https://192.168.1.10/hook',
  'https://172.16.5.4/hook',
  'https://169.254.169.254/latest/meta-data/',
  'https://[::1]/hook',
  'https://user:pass@example.com/hook',
  ' file:///etc/passwd',
  '',
 ]) assert.throws(()=>validateWebhookUrl(hostile),WebhookError,hostile);
});

test('the Discord message is a summary, not a data dump',()=>{
 const message=buildRecapDiscordMessage(recap,'https://scout.example/t/autumn-cup');
 const serialized=JSON.stringify(message);
 assert.match(serialized,/Autumn Cup/);
 assert.match(serialized,/Vertex/);
 assert.match(serialized,/https:\/\/scout\.example\/t\/autumn-cup/);
 for(const forbidden of ['steamid','76561198','@example.com','uploads/']) assert.equal(serialized.includes(forbidden),false,forbidden);
});

test('a delivery reports the status it got instead of claiming success',async()=>{
 const ok=await deliverWebhook({url:'https://example.com/hook',kind:'webhook'},{content:'x'},{fetchImpl:(async()=>new Response(null,{status:204})) as any});
 assert.equal(ok.ok,true);
 assert.equal(ok.status,204);
 // 200 with a body is also a delivery; the body is never echoed into the archive.
 const withBody=await deliverWebhook({url:'https://example.com/hook',kind:'webhook'},{content:'x'},{fetchImpl:(async()=>new Response('ok',{status:200})) as any});
 assert.equal(withBody.ok,true);
 const failed=await deliverWebhook({url:'https://example.com/hook',kind:'webhook'},{content:'x'},{fetchImpl:(async()=>new Response('nope',{status:500})) as any,retries:0});
 assert.equal(failed.ok,false);
 assert.equal(failed.status,500);
 const threw=await deliverWebhook({url:'https://example.com/hook',kind:'webhook'},{content:'x'},{fetchImpl:(async()=>{throw new Error('offline')}) as any,retries:0});
 assert.equal(threw.ok,false);
 assert.match(threw.detail,/offline/);
});

test('a redirect is not followed into the private network',async()=>{
 // fetch is told to fail on any redirect rather than follow one: a 302 that points at
 // 169.254.169.254 must never be fetched by this process.
 let called=false;
 const result=await deliverWebhook({url:'https://example.com/hook',kind:'webhook'},{content:'x'},{fetchImpl:(async(_url:string,init:any)=>{
  assert.equal(init.redirect,'error');
  called=true;
  throw new TypeError('unexpected redirect');
 }) as any,retries:0});
 assert.equal(called,true);
 assert.equal(result.ok,false,'a redirect is not a delivery');
 assert.match(result.detail,/redirect/i);
 const threeX=await deliverWebhook({url:'https://example.com/hook',kind:'webhook'},{content:'x'},{fetchImpl:(async()=>new Response('',{status:302,headers:{location:'http://169.254.169.254/'}})) as any,retries:0});
 assert.equal(threeX.ok,false,'a 3xx answer is a failure even when a mock resolves it');
});
