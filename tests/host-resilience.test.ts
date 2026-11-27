import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
import {platformHost} from './helpers/platform-host';
import {DEFAULT_TOKEN_REMOTE,feedNextAction} from '../server/state';

// Behaviour of the real host process (server/index.ts) that only shows up end to end.
const PNG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,0x49,0x48,0x44,0x52]);
const dataUrl=(mime:string,bytes:Buffer)=>`data:${mime};base64,${bytes.toString('base64')}`;

test('a failed disk write answers 500 and the host stays on air',async t=>{
 const host=await platformHost(t);
 // The upload directory turns into a file under the host's feet, the way a locked or vanished
 // folder looks to fs.mkdir/writeFile: the route's await rejects.
 const logos=path.join(host.directory,'public','uploads','logos');
 await rm(logos,{recursive:true,force:true});await writeFile(logos,'not a directory');
 const upload=await host.request('/api/upload',{kind:'logo',name:'team.png',data:dataUrl('image/png',PNG)});
 assert.equal(upload.status,500);
 assert.equal(upload.body?.error,'Request failed');
 assert.ok(upload.body?.requestId,'the failure carries a request id for the log');
 const health=await host.request('/api/healthz');
 assert.equal(health.status,200,'the host process survived the failed write');
 assert.equal(health.body?.ok,true);
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(health.body?.version,manifest.version,'healthz reports the version of the program it runs');
});

test('uploads are checked by content and served without the power to run script',async t=>{
 const host=await platformHost(t);
 const scripted=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><!--'+'x'.repeat(5000)+'--><script>fetch("/api/operators",{method:"POST"})</script></svg>');
 const refused=await host.request('/api/upload',{kind:'overlay',name:'sponsor.svg',data:dataUrl('image/svg+xml',scripted)});
 assert.equal(refused.status,400,'a scripted SVG is refused');
 assert.match(refused.body?.error,/scripts, event handlers or external links/);
 const mislabelled=await host.request('/api/upload',{kind:'logo',name:'team.png',data:dataUrl('image/png',Buffer.from('<html><script>alert(1)</script></html>'))});
 assert.equal(mislabelled.status,400,'bytes that are not the declared image are refused');
 const clean=await host.request('/api/upload',{kind:'logo',name:'team.svg',data:dataUrl('image/svg+xml',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'))});
 assert.equal(clean.status,200);
 const served=await fetch(`${host.url}/${clean.body.path}`,{signal:AbortSignal.timeout(10_000)});
 assert.equal(served.status,200);
 assert.equal(served.headers.get('content-type'),'image/svg+xml');
 assert.match(served.headers.get('content-security-policy')||'',/\bsandbox\b/);
 assert.match(served.headers.get('content-security-policy')||'',/default-src 'none'/);
 assert.equal(served.headers.get('x-content-type-options'),'nosniff');
 const radar=await fetch(`${host.url}/radars/missing.png`,{signal:AbortSignal.timeout(10_000)});
 assert.match(radar.headers.get('content-security-policy')||'',/\bsandbox\b/,'drop-in radar and thumbnail folders get the same headers');
});

// A non-loopback address of this machine stands in for another PC on the venue network: a request
// sent to it arrives on a socket the host cannot classify as local.
const LAN=Object.values(networkInterfaces()).flat().find(entry=>entry&&!entry.internal&&entry.family==='IPv4')?.address;

test('the built-in CHANGE_ME token is accepted only from this machine',{skip:LAN?false:'no non-loopback IPv4 address to send from'},async t=>{
 const host=await platformHost(t,{GSI_TOKEN:''});
 const port=new URL(host.url).port;
 const packet={auth:{token:'CHANGE_ME'},provider:{steamid:'76561190000000001',timestamp:1750000000},map:{name:'de_mirage',phase:'live',round:0,team_ct:{name:'Fake',score:13},team_t:{name:'News',score:0}}};
 const send=(base:string)=>fetch(`${base}/gsi`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet),signal:AbortSignal.timeout(10_000)});
 const remote=await send(`http://${LAN}:${port}`);
 assert.equal(remote.status,403,'another machine cannot feed the overlay with the published default');
 const refused=(await host.request('/api/status')).body;
 assert.equal(refused.state.map,undefined,'nothing from the refused packet reached the match state');
 assert.equal(refused.gsi.lastRejectedReason,DEFAULT_TOKEN_REMOTE);
 assert.match(feedNextAction(refused.gsi),/built-in CHANGE_ME token.*Connect CS2/);
 const local=await send(host.url);
 assert.equal(local.status,200,'CS2 on the host machine still works out of the box');
 assert.equal((await host.request('/api/status')).body.state.map?.name,'de_mirage');
});

test('a private GSI_TOKEN is accepted from another machine as before',{skip:LAN?false:'no non-loopback IPv4 address to send from'},async t=>{
 const host=await platformHost(t);
 const port=new URL(host.url).port;
 const accepted=await fetch(`http://${LAN}:${port}/gsi`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auth:{token:'platform-route-test-gsi-token'},provider:{steamid:'1',timestamp:1}}),signal:AbortSignal.timeout(10_000)});
 assert.equal(accepted.status,200);
});
