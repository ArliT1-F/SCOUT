import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LicenceMonitor,mayRun,RUNNABLE_STATES,CHECK_INTERVAL_MS,GRACE_MS,type LicenceSource} from '../server/licensing';
import {ReleaseRegistry,RequestLog,healthSnapshot,VERSION_PATTERN,type HealthInput} from '../server/operations';
import {LocalBetaService,Installation,type BetaContext} from '../server/beta';

// The launcher's half of the link: is this installation entitled to run, and what installer is the
// dashboard handing out. Both are decisions an operator has to be able to trust, so they are pinned
// here rather than in the pages that display them.
const application={name:'Ada Operator',email:'ada@example.com',organisation:'Durres LAN',country:'AL',useCase:'cups',events:'Weekly'};
const context=(address='127.0.0.1'):BetaContext=>({address,userAgent:'node-test',origin:'http://127.0.0.1:8080',secure:false});
let clock=1_700_000_000_000;
async function linkedInstallation(){
 const dir=await mkdtemp(path.join(tmpdir(),'scout-licence-'));
 const beta=await new LocalBetaService({dir,now:()=>clock}).load();
 const created=await beta.apply(application,context('203.0.113.9'));
 const id=created.ok?created.value.account.id:'';
 const approved=await beta.decide(id,'approve','owner');
 await beta.activate({invite:approved.ok?approved.value.invite!:'',password:'a-long-enough-password'},context());
 const signedIn=await beta.signIn({email:'ada@example.com',password:'a-long-enough-password'},context());
 const start=await beta.deviceStart({label:'observer-pc',platform:'win32'},context());
 if(!start.ok) throw Error('no device grant');
 await beta.deviceDecide(signedIn.ok?signedIn.value.cookieId:undefined,start.value.userCode,true);
 const poll=await beta.devicePoll({deviceCode:start.value.deviceCode});
 if(!poll.ok||!poll.value.installationToken) throw Error('no installation token');
 const file=path.join(dir,'installation.json');
 const installation=await new Installation(file,()=>clock).load();
 installation.beginLink(start.value);
 assert.equal(installation.completeLink(poll.value),true);
 await installation.save();
 const deviceId=poll.value.deviceId!;
 return {dir,beta,installation,deviceId,token:poll.value.installationToken};
}

test('a local host is its own authority: nothing is enforced and the installation may run',async()=>{
 const {dir,installation}=await linkedInstallation();
 const monitor=new LicenceMonitor({mode:'local',now:()=>clock});
 const view=await monitor.view(installation);
 assert.equal(view.state,'active');
 assert.equal(view.enforced,false,'a local beta does not pretend to have checked anything');
 assert.equal(view.email,'ada@example.com');
 assert.equal(mayRun(view),true);
 assert.match(view.message,/may run/);
 await rm(dir,{recursive:true,force:true});
});

test('an unlinked installation says so, and a pending link is a different state',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-licence-'));
 const file=path.join(dir,'installation.json');
 const installation=await new Installation(file,()=>clock).load();
 const monitor=new LicenceMonitor({mode:'local',now:()=>clock});
 assert.equal((await monitor.view(installation)).state,'unlinked');
 installation.beginLink({userCode:'ABCD-EFGH',deviceCode:'device-code',expiresAt:clock+600000});
 assert.equal((await monitor.view(installation)).state,'pending');
 assert.equal(mayRun(await monitor.view(installation)),false,'a waiting link is not a licence');
 assert.match((await monitor.view(installation)).message,/waiting to be approved/);
 await rm(dir,{recursive:true,force:true});
});

test('a hosted installation is verified against the service, once per interval',async()=>{
 const {dir,installation,deviceId,token}=await linkedInstallation();
 let calls=0;
 const source: LicenceSource={async installationStatus(input){
  calls++;
  assert.equal(input.deviceId,deviceId);
  assert.equal(input.token,token,'the shell presents the token the dashboard approved');
  return {ok:true,value:{status:'active',email:'ada@example.com',displayName:'Ada'}};
 }};
 const monitor=new LicenceMonitor({mode:'hosted',source,now:()=>clock,enforced:true});
 const first=await monitor.view(installation);
 assert.equal(first.state,'active');
 assert.equal(first.enforced,true);
 assert.equal(calls,1);
 await monitor.view(installation);
 assert.equal(calls,1,'a second read inside the interval uses the cached answer');
 clock+=CHECK_INTERVAL_MS+1;
 await monitor.view(installation);
 assert.equal(calls,2,'and the next interval asks again, so a revocation lands within it');
 await rm(dir,{recursive:true,force:true});
});

test('a revocation is reported at once, and never hides what the account was',async()=>{
 const {dir,installation}=await linkedInstallation();
 const monitor=new LicenceMonitor({mode:'hosted',now:()=>clock,enforced:true,source:{async installationStatus(){return {ok:true,value:{status:'revoked',email:'ada@example.com'}}}}});
 const view=await monitor.view(installation);
 assert.equal(view.state,'revoked');
 assert.equal(view.email,'ada@example.com');
 assert.equal(mayRun(view),false);
 assert.match(view.message,/not entitled|unlinked/);
 await rm(dir,{recursive:true,force:true});
});

test('an unreachable service degrades to offline and keeps the last good answer in a grace window',async()=>{
 const {dir,installation}=await linkedInstallation();
 let reachable=true;
 const monitor=new LicenceMonitor({mode:'hosted',now:()=>clock,enforced:true,source:{async installationStatus(){
  return reachable?{ok:true,value:{status:'active',email:'ada@example.com'}}:{ok:false,status:503,code:'upstream-unreachable',message:'down'};
 }}});
 assert.equal((await monitor.view(installation)).state,'active');
 clock+=CHECK_INTERVAL_MS+1;
 reachable=false;
 const offline=await monitor.view(installation);
 assert.equal(offline.state,'offline');
 assert.equal(mayRun(offline),true,'a licence server outage must never take a broadcast down');
 assert.equal(offline.lastGoodAt!+GRACE_MS,offline.graceExpiresAt!,'the grace window starts at the last verified check');
 assert.match(offline.message,/could not be reached/);
 await rm(dir,{recursive:true,force:true});
});

test('every state a launcher can meet is either runnable or an explicit refusal',()=>{
 assert.deepEqual([...RUNNABLE_STATES].sort(),['active','offline','unknown']);
 for(const state of ['pending','unlinked','revoked'] as const) assert.equal(RUNNABLE_STATES.includes(state),false,state);
});

// ---------------------------------------------------------------- releases
const downloadFile='SCOUT-Setup-0.4.1.exe';
async function registry(dir:string){
 await writeFile(path.join(dir,downloadFile),Buffer.alloc(2048,1));
 return new ReleaseRegistry(path.join(dir,'releases.json'),dir,()=>clock);
}

test('publishing a release points the dashboard at the file this host holds',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-release-'));
 const releases=await (await registry(dir)).load();
 assert.equal(releases.latest(),null);
 const published=await releases.publish({version:'0.4.1',file:downloadFile,notes:'beta build',by:'Ada'});
 assert.equal(published.ok,true,JSON.stringify(published));
 if(!published.ok) return;
 assert.equal(published.release.url,`/download/${downloadFile}`);
 assert.ok(published.release.sizeBytes&&published.release.sizeBytes>0,'the size is read from the file itself');
 assert.equal(releases.latest()?.version,'0.4.1');
 assert.equal(await releases.noteDownload(`/download/${downloadFile}`),true);
 assert.equal(releases.latest()?.downloads,1);
 await rm(dir,{recursive:true,force:true});
});

test('a release that names a file this host does not have is refused, with a sentence that says what to do',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-release-'));
 const releases=await (await registry(dir)).load();
 const missing=await releases.publish({version:'9.9.9',file:'SCOUT-Setup-9.9.9.exe',by:'Ada'});
 assert.equal(missing.ok,false);
 if(!missing.ok) assert.match(missing.message,/npm run package:windows/);
 const badVersion=await releases.publish({version:'latest',url:'https://example.test/x.exe',by:'Ada'});
 assert.equal(badVersion.ok,false);
 if(!badVersion.ok) assert.match(badVersion.message,/0\.4\.1/);
 const badUrl=await releases.publish({version:'0.4.2',url:'javascript:alert(1)',by:'Ada'});
 assert.equal(badUrl.ok,false);
 const external=await releases.publish({version:'0.4.3',url:'https://cdn.example.test/SCOUT-Setup-0.4.3.exe',notes:'mirror',by:'Ada'});
 assert.equal(external.ok,true);
 assert.equal(releases.latest()?.version,'0.4.3','the newest publish wins');
 assert.equal(await releases.retire('0.4.3'),true);
 assert.equal(releases.latest(),null);
 assert.equal(await releases.retire('0.4.3'),false);
 assert.ok(VERSION_PATTERN.test('1.0.0-beta.2'));
 assert.equal(VERSION_PATTERN.test('1.0'),false);
 await rm(dir,{recursive:true,force:true});
});

test('the release list survives a restart',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-release-'));
 const first=await (await registry(dir)).load();
 await first.publish({version:'0.5.0',file:downloadFile,by:'Ada'});
 const reopened=await new ReleaseRegistry(path.join(dir,'releases.json'),dir,()=>clock).load();
 assert.equal(reopened.latest()?.version,'0.5.0');
 assert.equal(reopened.latest()?.publishedBy,'Ada');
 await rm(dir,{recursive:true,force:true});
});

// ---------------------------------------------------------------- health and requests
test('the request log counts what happened recently and forgets what did not',()=>{
 const log=new RequestLog(50,15*60*1000,()=>clock);
 log.record({at:clock,method:'GET',path:'/api/status',status:200,ms:3,address:'127.0.0.1'});
 log.record({at:clock,method:'GET',path:'/api/status',status:200,ms:4,address:'127.0.0.1'});
 log.record({at:clock,method:'POST',path:'/api/control',status:403,ms:1,address:'127.0.0.1'});
 log.record({at:clock,method:'GET',path:'/api/config/aaaaaaaaaa',status:500,ms:9,address:'127.0.0.1'});
 const summary=log.summary();
 assert.equal(summary.byClass.ok,2);
 assert.equal(summary.byClass.clientError,1);
 assert.equal(summary.byClass.serverError,1);
 assert.equal(summary.total,4);
 assert.ok(summary.top.some(route=>route.path==='GET /api/config/:id'),'ids are folded, so the list stays readable');
 clock+=16*60*1000;
 assert.equal(log.summary().byClass.ok,0,'the window is what "recently" means');
 assert.equal(log.summary().total,4,'the running total is still reported');
});

test('the health snapshot says what needs attention, ranked and specific',()=>{
 const base:HealthInput={
  startedAt:clock,version:'0.1.0',pid:1234,
  beta:{mode:'local',applications:{pending:2,approved:1,rejected:0},devices:1},
  licence:{state:'revoked',enforced:true,email:'ada@example.com'},
  releases:{published:0,latest:null,downloads:0},
  requests:new RequestLog(10,15*60*1000,()=>clock).summary(),
  output:{clients:0,gsiPackets:0,gsiAgeMs:null,gsiRejected:0,recording:false},
 };
 const snapshot=healthSnapshot(base,clock+60_000);
 assert.equal(snapshot.uptimeMs,60_000);
 const titles=snapshot.attention.map(item=>item.title).join(' | ');
 assert.match(titles,/2 beta application/);
 assert.match(titles,/Licence is not active/);
 assert.match(titles,/No launcher release published/);
 assert.match(titles,/No output connected/);
 assert.equal(snapshot.attention.find(item=>item.title.includes('Licence'))?.level,'bad');

 const healthy=healthSnapshot({
  ...base,
  beta:{mode:'hosted',applications:{pending:0,approved:12,rejected:3},devices:12},
  licence:{state:'active',enforced:true,email:'ada@example.com'},
  releases:{published:1,latest:'0.4.1',downloads:7},
  requests:{...base.requests,byClass:{ok:120,redirect:1,clientError:2,serverError:0}},
  output:{clients:2,gsiPackets:900,gsiAgeMs:400,gsiRejected:0,recording:true},
 },clock);
 assert.deepEqual(healthy.attention,[],'nothing to report is the point of a health check');
});

test('a stale or rejected CS2 feed is called out rather than left to the operator to notice',()=>{
 const requests=new RequestLog(10,15*60*1000,()=>clock).summary();
 const stale=healthSnapshot({
  startedAt:clock,version:'0.1.0',pid:1,
  beta:{mode:'local',applications:{pending:0,approved:1,rejected:0},devices:1},
  licence:null,
  releases:{published:1,latest:'0.4.1',downloads:0},
  requests,
  output:{clients:1,gsiPackets:40,gsiAgeMs:12_000,gsiRejected:9,recording:false},
 },clock);
 const titles=stale.attention.map(item=>item.title);
 assert.ok(titles.some(title=>/stale/.test(title)),titles.join(' | '));
 assert.ok(titles.some(title=>/rejected/.test(title)),titles.join(' | '));
});
