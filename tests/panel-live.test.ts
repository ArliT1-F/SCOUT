import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer,request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {fileURLToPath} from 'node:url';
import {networkInterfaces} from 'node:os';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import WebSocket from 'ws';

// The panel gate as it is actually wired: this starts the real host — the same entry point the
// operator runs — and drives it over HTTP from two addresses. That matters more here than anywhere
// else in the suite, because the whole feature is a question about requests: which socket, which Host
// header, which cookie. The pure policy is pinned in tests/auth.test.ts; this pins the wiring.
const repoRoot=fileURLToPath(new URL('..',import.meta.url));
const TOKEN='panel-token-for-the-live-test';
const GSI_TOKEN='gsi-token-for-the-live-test';
// Every non-loopback IPv4 of this machine stands in for "the operator's laptop on the venue network":
// the socket address is what the host classifies, and only a real second address produces a real one.
function remoteAddresses(){
 const found:string[]=[];
 for(const entries of Object.values(networkInterfaces())) for(const entry of entries||[]) if(!entry.internal&&entry.family==='IPv4') found.push(entry.address);
 return found;
}
const REMOTE=remoteAddresses()[0];
const OPERATOR_FILE=new URL('../config/operator.json',import.meta.url);
let previousOperator:Buffer|null=null;
let child:ChildProcess|undefined;
let port=0;

function freePort():Promise<number>{
 return new Promise(resolve=>{const probe=createServer();probe.listen(0,'0.0.0.0',()=>{const address=probe.address();const value=typeof address==='object'&&address?address.port:0;probe.close(()=>resolve(value))})});
}
interface Reply {status:number;headers:IncomingHttpHeaders;text:string;json:any}
// node:http rather than fetch: the test has to forge the Host header to stand in for a proxy or a
// rebound domain, and fetch refuses to set it (it is a forbidden header in the fetch spec).
function call(path:string,options:{host?:string;method?:string;headers?:Record<string,string>;body?:unknown;cookie?:string|string[]}={}):Promise<Reply>{
 const target=options.host||'127.0.0.1';
 const payload=options.body===undefined?undefined:JSON.stringify(options.body);
 return new Promise((resolve,reject)=>{
  const req=httpRequest({host:target,port,path,method:options.method||'GET',headers:{
   ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),
   ...(options.cookie?{Cookie:Array.isArray(options.cookie)?options.cookie.join('; '):options.cookie}:{}),
   ...options.headers,
  }},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{let json:any=null;try{json=JSON.parse(text)}catch{}resolve({status:res.statusCode||0,headers:res.headers,text,json})})});
  req.on('error',reject);
  if(payload) req.write(payload);
  req.end();
 });
}
async function waitForHost(){
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){
  try{const reply=await call('/api/session');if(reply.status===200) return}catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 throw Error('the host did not start in time');
}
function openSocket(headers:Record<string,string>):Promise<{opened:boolean;status:number;first:string}>{
 return new Promise(resolve=>{
  const socket=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers});
  const finish=(opened:boolean,status=0,first='')=>{try{socket.terminate()}catch{};resolve({opened,status,first})};
  socket.on('message',data=>finish(true,101,String(data)));
  socket.on('open',()=>{setTimeout(()=>finish(true,101),4000)});
  socket.on('unexpected-response',(_req,res)=>{res.resume();finish(false,res.statusCode||0)});
  socket.on('error',()=>finish(false,0));
 });
}
const cookieHeader=(reply:Reply)=>(reply.headers['set-cookie']||[]).map(value=>value.split(';')[0]).join('; ');

before(async()=>{
 port=await freePort();
 try{previousOperator=await readFile(OPERATOR_FILE)}catch{previousOperator=null}
 const env:NodeJS.ProcessEnv={...process.env,PORT:String(port),SCOUT_PANEL_TOKEN:TOKEN,GSI_TOKEN};
 // The live host must start from the shipped defaults, not from whatever the shell that runs the
 // tests happens to export.
 delete env.SCOUT_REMOTE;delete env.SCOUT_ALLOWED_HOSTS;delete env.SCOUT_REQUIRE_TOKEN;delete env.LOG_GSI;
 delete env.NODE_ENV;delete env.OBS_WS_URL;delete env.OBS_WS_PASSWORD;
 child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','server/index.ts'],{cwd:repoRoot,env,stdio:['ignore','pipe','pipe']});
 child.stdout?.on('data',()=>{});
 child.stderr?.on('data',()=>{});
 await waitForHost();
});
after(async()=>{
 child?.kill('SIGTERM');
 if(previousOperator) await writeFile(OPERATOR_FILE,previousOperator); else await unlink(OPERATOR_FILE).catch(()=>{});
});

test('the panel reports a local session for this machine and none for another',async()=>{
 const local=await call('/api/session');
 assert.equal(local.status,200);
 assert.deepEqual([local.json.local,local.json.authenticated,local.json.via,local.json.remoteEnabled],[true,true,'local',true]);
 assert.equal(local.json.tokenSource,'env');
 assert.equal(JSON.stringify(local.json).includes(TOKEN),false,'the view never contains the token');
 if(!REMOTE) return;
 const remote=await call('/api/session',{host:REMOTE});
 assert.deepEqual([remote.json.local,remote.json.authenticated,remote.json.via],[false,false,null]);
 assert.equal(remote.json.address,REMOTE,'the address the panel shows is the one the request arrived from');
});

test('GSI intake is untouched by the panel gate',async()=>{
 const accepted=await call('/gsi',{host:REMOTE||'127.0.0.1',method:'POST',body:{provider:{steamid:'76561190000000000'},map:{name:'de_mirage',phase:'live'},round:{phase:'live'}}});
 if(!REMOTE) assert.equal(accepted.status,200,'a local host still takes its own game feed');
 else assert.equal(accepted.status,401,'a wrong GSI token is refused on the GSI route, not by the panel gate');
 const withToken=await call('/gsi',{host:REMOTE||'127.0.0.1',method:'POST',headers:{'X-Scout-Token':TOKEN},body:{auth:{token:GSI_TOKEN},provider:{steamid:'76561190000000000',timestamp:1},map:{name:'de_mirage',phase:'live'},round:{phase:'live'}}});
 assert.equal(withToken.status,200,'CS2 pushes with its own token and no panel session');
});

test('another machine cannot change the broadcast without the token',async()=>{
 if(!REMOTE) return;
 const before=(await call('/api/status')).json.controls;
 const refused=await call('/api/controls',{host:REMOTE,method:'PUT',headers:{Origin:`http://${REMOTE}:${port}`},body:{...before,scene:'break'}});
 assert.equal(refused.status,401);
 assert.equal(refused.json.code,'no-session');
 assert.equal((await call('/api/status')).json.controls.scene,before.scene,'nothing was written');
 // A cross-site page is refused even when it does hold the token: Origin and Host disagree.
 const crossSite=await call('/api/controls',{host:REMOTE,method:'PUT',headers:{Origin:'https://evil.example.com','X-Scout-Token':TOKEN},body:{...before,scene:'break'}});
 assert.equal(crossSite.status,403);
 // The same request from this machine is the operator, and goes through — that is the shipped path.
 const local=await call('/api/controls',{method:'PUT',headers:{Origin:`http://127.0.0.1:${port}`},body:{...before,scene:'break'}});
 assert.equal(local.status,200);
 const restored=await call('/api/controls',{method:'PUT',headers:{Origin:`http://127.0.0.1:${port}`},body:before});
 assert.equal(restored.status,200);
});

test('a request that looks local but names a public host is refused',async()=>{
 // The shape of DNS rebinding, and of a proxy or tunnel in front of the host: loopback socket, public
 // name in Host. Neither may operate the panel without the token.
 const before=(await call('/api/status')).json.controls;
 const rebound=await call('/api/controls',{host:'127.0.0.1',method:'PUT',headers:{Host:'evil.example.com',Origin:'http://evil.example.com'},body:{...before,scene:before.scene==='break'?'live':'break'}});
 assert.equal(rebound.status,403);
 assert.equal(rebound.json.code,'untrusted-host');
 assert.match(rebound.json.error,/SCOUT_ALLOWED_HOSTS/);
 assert.deepEqual((await call('/api/status')).json.controls,before,'the refusal did not touch the broadcast');
});

test('the printed link unlocks a browser and leaves no token in the address bar',async()=>{
 const link=await call(`/?token=${encodeURIComponent(TOKEN)}`,{headers:{Host:'8080-preview.e2b.app',Origin:'https://8080-preview.e2b.app'}});
 assert.ok([301,302].includes(link.status),`expected a redirect, got ${link.status}`);
 assert.equal(link.headers.location,'/','the token is gone from the target');
 const cookies=link.headers['set-cookie']||[];
 assert.equal(cookies.length,1);
 assert.match(cookies[0],/^scout_panel=/);
 assert.match(cookies[0],/HttpOnly; SameSite=Strict/);
 assert.equal(cookies[0].includes(TOKEN),false,'the cookie holds a session id, never the token');
 const session=cookieHeader(link);
 assert.equal(session.includes('HttpOnly'),false);
 if(REMOTE){
  const view=await call('/api/session',{host:REMOTE,cookie:session});
  assert.deepEqual([view.json.authenticated,view.json.local,view.json.via],[true,false,'cookie']);
 }
 // A wrong link is a page an operator can read, not a redirect into the panel.
 const bad=await call('/?token=not-the-token',{headers:{Host:'8080-preview.e2b.app'}});
 assert.equal(bad.status,401);
 assert.match(bad.text,/not valid/i);
 assert.equal((bad.headers['set-cookie']||[]).length,0);
});

test('the token in a header is enough for a script, and the session can be closed',async()=>{
 if(!REMOTE) return;
 const before=(await call('/api/status')).json.controls;
 const lease=await call('/api/lease',{host:REMOTE,method:'POST',headers:{Origin:`http://${REMOTE}:${port}`,'X-Scout-Token':TOKEN},body:{force:true}});
 assert.equal(lease.status,200,'the owner can claim or take over the control lease');
 const withHeader=await call('/api/controls',{host:REMOTE,method:'PUT',headers:{Origin:`http://${REMOTE}:${port}`,'X-Scout-Token':TOKEN},body:{...before,scene:'matchup'}});
 assert.equal(withHeader.status,200);
 assert.equal((await call('/api/status')).json.controls.scene,'matchup');
 const wrong=await call('/api/controls',{host:REMOTE,method:'PUT',headers:{'X-Scout-Token':'nope'},body:before});
 assert.equal(wrong.status,401);
 assert.equal(wrong.json.code,'bad-session');
 const opened=await call('/api/session',{host:REMOTE,method:'POST',headers:{Origin:`http://${REMOTE}:${port}`},body:{token:TOKEN}});
 assert.equal(opened.status,200);
 assert.equal(opened.json.authenticated,true);
 const session=cookieHeader(opened);
 const closed=await call('/api/session',{host:REMOTE,method:'DELETE',headers:{Cookie:session}});
 assert.equal(closed.status,200);
 assert.equal((await call('/api/session',{host:REMOTE,cookie:session})).json.authenticated,false,'a signed-out cookie is dead');
 await call('/api/controls',{method:'PUT',headers:{Origin:`http://127.0.0.1:${port}`},body:before});
});

test('role-scoped tokens enforce producer control, designer permissions, authenticated Companion feedback, and revocation',async()=>{
 if(!REMOTE) return;
 const origin=`http://${REMOTE}:${port}`,ownerHeaders={Origin:origin,'X-Scout-Token':TOKEN};
 const before=(await call('/api/status')).json.controls;
 const producerIssue=await call('/api/operators',{host:REMOTE,method:'POST',headers:ownerHeaders,body:{label:'Deck producer',role:'producer'}});
 const designerIssue=await call('/api/operators',{host:REMOTE,method:'POST',headers:ownerHeaders,body:{label:'Overlay designer',role:'designer'}});
 assert.equal(producerIssue.status,200);assert.equal(designerIssue.status,200);
 const producerToken=producerIssue.json.token,designerToken=designerIssue.json.token;
 assert.equal((await readFile(new URL('../config/operators.json',import.meta.url),'utf8')).includes(producerToken),false,'operator secrets are never persisted in plaintext');
 // Clear a lease left by the earlier local-owner controls test, then let the actual producer claim it.
 await call('/api/lease',{host:REMOTE,method:'POST',headers:ownerHeaders,body:{force:true}});
 await call('/api/lease?force=1',{host:REMOTE,method:'DELETE',headers:ownerHeaders});
 const producerHeaders={Origin:origin,'X-Scout-Token':producerToken};
 const claim=await call('/api/lease',{host:REMOTE,method:'POST',headers:producerHeaders,body:{}});assert.equal(claim.status,200);
 const action=await call('/api/remote/action',{host:REMOTE,method:'POST',headers:producerHeaders,body:{action:'scene:stats'}});assert.equal(action.status,200);assert.equal(action.json.controls.scene,'stats');
 const feedback=await call('/api/remote/state',{host:REMOTE,headers:producerHeaders});assert.equal(feedback.status,200);assert.equal(feedback.json.controls.scene,'stats');assert.equal(feedback.json.lease.mine,true);assert.equal(feedback.json.canControl,true);
 const designerHeaders={Origin:origin,'X-Scout-Token':designerToken};
 const feedbackDenied=await call('/api/remote/state',{host:REMOTE,headers:designerHeaders});assert.equal(feedbackDenied.status,403);assert.equal(feedbackDenied.json.code,'insufficient-role');
 const leaseDenied=await call('/api/lease',{host:REMOTE,method:'POST',headers:designerHeaders,body:{}});assert.equal(leaseDenied.status,403);
 const overlay=(await call('/api/overlay')).json;
 const designSave=await call('/api/overlay',{host:REMOTE,method:'PUT',headers:designerHeaders,body:overlay});assert.equal(designSave.status,200,'the designer may publish overlay design');
 const actionDenied=await call('/api/remote/action',{host:REMOTE,method:'POST',headers:designerHeaders,body:{action:'scene:live'}});assert.equal(actionDenied.status,403);
 for(const id of [producerIssue.json.operator.id,designerIssue.json.operator.id]){
  const revoked=await call(`/api/operators/${encodeURIComponent(id)}`,{host:REMOTE,method:'DELETE',headers:ownerHeaders});assert.equal(revoked.status,200);
 }
 const revokedFeedback=await call('/api/remote/state',{host:REMOTE,headers:producerHeaders});assert.equal(revokedFeedback.status,401);assert.equal(revokedFeedback.json.code,'bad-session');
 await call('/api/lease',{host:REMOTE,method:'POST',headers:ownerHeaders,body:{force:true}});
 await call('/api/controls',{host:REMOTE,method:'PUT',headers:ownerHeaders,body:before});
 await call('/api/lease?force=1',{host:REMOTE,method:'DELETE',headers:ownerHeaders});
});

test('guessing is throttled per address',async()=>{
 if(!REMOTE) return;
 let last:Reply|null=null;
 for(let attempt=0;attempt<5;attempt++) last=await call('/api/session',{host:REMOTE,method:'POST',body:{token:'guess-'+attempt}});
 assert.equal(last!.status,429,'the fifth wrong token locks the address out');
 assert.equal(last!.json.code,'throttled');
 assert.ok(Number(last!.headers['retry-after'])>0,'the client is told when to come back');
 const correct=await call('/api/session',{host:REMOTE,method:'POST',body:{token:TOKEN}});
 assert.equal(correct.status,429,'even the right token waits out the lockout');
 assert.equal((await call('/api/session',{host:'127.0.0.1',method:'POST',body:{token:TOKEN}})).status,200,'this machine is a different address');
});

test('the WebSocket feed stays readable, but not from another site',async()=>{
 const same=await openSocket({Host:'127.0.0.1:'+port,Origin:`http://127.0.0.1:${port}`});
 assert.equal(same.opened,true);
 assert.equal(JSON.parse(same.first).session.local,true,'the first snapshot carries the session of that connection');
 const crossSite=await openSocket({Host:`${REMOTE||'127.0.0.1'}:${port}`,Origin:'https://evil.example.com'});
 assert.equal(crossSite.opened,false,'a handshake from another site is refused');
 const native=await openSocket({Host:`${REMOTE||'127.0.0.1'}:${port}`});
 assert.equal(native.opened,true,'a client without an Origin (a native tool, a wall display) is not a browser attack');
});
