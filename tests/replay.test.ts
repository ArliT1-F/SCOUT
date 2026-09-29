import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {replay,defaultOptions,parseReplay} from '../server/replay';

// The CLI talks to a real host over HTTP; these tests keep a real socket in the loop so the body
// shape (payload + injected auth) and the abort paths are exercised, at a speed that keeps the run fast.
const entries=parseReplay([
 JSON.stringify({receivedAt:1000,payload:{provider:{timestamp:1},map:{name:'de_mirage'},allplayers:{a:{name:'nova'}}}}),
 JSON.stringify({receivedAt:1050,payload:{provider:{timestamp:2},map:{name:'de_mirage'},allplayers:{a:{name:'nova'},b:{name:'kairo'}}}}),
 JSON.stringify({receivedAt:1150,payload:{provider:{timestamp:3},map:{name:'de_mirage'},allplayers:{a:{name:'nova'},b:{name:'kairo'}}}}),
].join('\n'));

function collect(status=200){
 const bodies:string[]=[];
 const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{bodies.push(body);res.writeHead(status).end()})});
 return {server,bodies,listen:()=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as any).port}/gsi`)))};
}

test('replay posts every recorded payload to the host with the token injected',async()=>{
 const host=collect(); const url=await host.listen();
 try {
  const started=Date.now();
  const result=await replay(entries,{...defaultOptions,url,token:'s3cret',speed:25,quiet:true});
  const elapsed=Date.now()-started;
  assert.deepEqual(result,{sent:3,failed:0,statuses:{200:3}});
  assert.equal(host.bodies.length,3);
  const sent=host.bodies.map(body=>JSON.parse(body));
  assert.deepEqual(sent.map(payload=>payload.auth.token),['s3cret','s3cret','s3cret']);
  assert.equal(sent[2].allplayers.b.name,'kairo','packets arrive in recorded order');
  assert.ok(elapsed<500,`speed 25 should not take ${elapsed}ms`);
 } finally {host.server.close()}
});

test('replay aborts with a token-mismatch message instead of hammering a 401 host',async()=>{
 const host=collect(401); const url=await host.listen();
 try {await assert.rejects(()=>replay(entries,{...defaultOptions,url,speed:50,quiet:true}),/token mismatch/);assert.equal(host.bodies.length,1)}
 finally {host.server.close()}
});

test('replay gives up on an unreachable host with a start-the-host hint',async()=>{
 await assert.rejects(()=>replay(entries,{...defaultOptions,url:'http://127.0.0.1:1/gsi',speed:50,quiet:true}),/start the host with "npm run dev"/);
});

test('a dry run plans every packet without opening a connection',async()=>{
 const result=await replay(entries,{...defaultOptions,url:'http://127.0.0.1:1/gsi',speed:50,quiet:true,dry:true});
 assert.deepEqual(result,{sent:0,failed:0,statuses:{}});
});
