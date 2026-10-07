import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {ObsBridge,obsAuth,OBS_SUBSCRIPTIONS,OBS_RPC_VERSION,type ObsBridgeOptions} from '../server/obs';
import {obsConfigSchema,defaultObsConfig,isObsUrl,planScoutToObs,planObsToScout,obsSceneFor,isOverlayUrl,idleObsStatus,OBS_DEFAULT_URL,type ObsConfig} from '../server/obs-config';
import {MockObs,waitFor,sleep,DOC_PASSWORD,DOC_SALT,DOC_CHALLENGE,DOC_AUTH} from './helpers/mock-obs';

// The optional OBS bridge. Pure decisions first, then the real thing against a protocol-faithful mock OBS.

type ConfigInput=Omit<Partial<ObsConfig>,'sceneMap'>&{sceneMap?:Partial<ObsConfig['sceneMap']>};
const config=(over:ConfigInput={}):ObsConfig=>obsConfigSchema.parse({enabled:true,...over});

// ---------------------------------------------------------------- pure: auth, config, planning
test('the authentication string follows the documented worked example',()=>{
 assert.equal(obsAuth(DOC_PASSWORD,DOC_SALT,DOC_CHALLENGE),DOC_AUTH);
 assert.notEqual(obsAuth('wrong',DOC_SALT,DOC_CHALLENGE),DOC_AUTH);
 assert.notEqual(obsAuth(DOC_PASSWORD,'other salt',DOC_CHALLENGE),DOC_AUTH);
 assert.notEqual(obsAuth(DOC_PASSWORD,DOC_SALT,'other challenge'),DOC_AUTH);
});

test('we subscribe to general, scene and output events only — never the high-volume ones',()=>{
 assert.equal(OBS_SUBSCRIPTIONS,1|4|64);
 assert.equal(OBS_SUBSCRIPTIONS&(0xffff<<16),0,'no bit at or above 1<<16 (volume meters, transforms) is set');
 assert.equal(OBS_RPC_VERSION,1);
});

test('the saved OBS configuration is defaulted, trimmed and cannot hold a password or a non-websocket address',()=>{
 const defaults=obsConfigSchema.parse({});
 assert.deepEqual(defaults,{enabled:false,url:OBS_DEFAULT_URL,sync:'scout',sceneMap:{live:'',matchup:'',lineups:'',veto:'',bracket:'',winner:'',break:'',recap:'',stats:''},browserSource:''});
 const parsed=obsConfigSchema.parse({enabled:true,url:' ws://10.0.0.5:4455 ',sync:'both',sceneMap:{live:' GAME ',break:'BRB',nonsense:'x'},browserSource:' Overlay ',password:'hunter2'});
 assert.equal(parsed.url,'ws://10.0.0.5:4455');
 assert.deepEqual([parsed.sceneMap.live,parsed.sceneMap.break,parsed.browserSource],['GAME','BRB','Overlay']);
 assert.equal('password' in parsed,false,'a password in a saved file is dropped, not stored');
 assert.equal('nonsense' in parsed.sceneMap,false);
 for(const bad of ['http://127.0.0.1:4455','127.0.0.1:4455','ws://','ws://user:pass@127.0.0.1:4455','ws://:pw@host','file:///etc/passwd','javascript:alert(1)','','ws://host name'])
  assert.equal(obsConfigSchema.safeParse({url:bad}).success,false,JSON.stringify(bad));
 for(const good of ['ws://127.0.0.1:4455','wss://obs.example.com','ws://[::1]:4455','ws://studio-pc.local:4456/'])
  assert.equal(isObsUrl(good),true,good);
 assert.equal(obsConfigSchema.safeParse({sync:'sometimes'}).success,false);
 assert.equal(obsConfigSchema.safeParse({sceneMap:{live:'x'.repeat(201)}}).success,false);
});

test('setting OBS_WS_URL is what switches the integration on by default',()=>{
 assert.equal(defaultObsConfig({}).enabled,false);
 assert.deepEqual([defaultObsConfig({OBS_WS_URL:'ws://10.1.1.1:4455'}).enabled,defaultObsConfig({OBS_WS_URL:'ws://10.1.1.1:4455'}).url],[true,'ws://10.1.1.1:4455']);
 assert.equal(defaultObsConfig({OBS_WS_URL:'not a url'}).url,OBS_DEFAULT_URL,'a bad environment value falls back instead of crashing the host');
});

test('a SCOUT scene change switches OBS only when that is safe and useful',()=>{
 const cfg=config({sceneMap:{live:'GAME',break:'BRB',winner:'Missing'}});
 const obs={scenes:['BRB','GAME','LOBBY'],currentScene:'GAME'};
 assert.deepEqual(planScoutToObs(cfg,'break',obs),{switchTo:'BRB'});
 assert.deepEqual(planScoutToObs(cfg,'live',obs),{skip:'already-there'});
 assert.deepEqual(planScoutToObs(cfg,'lineups',obs),{skip:'unmapped'},'an unmapped scene leaves OBS alone');
 assert.deepEqual(planScoutToObs(cfg,'winner',obs),{skip:'unknown-scene'},'never asks OBS for a scene it does not have');
 assert.deepEqual(planScoutToObs({...cfg,sync:'off'},'break',obs),{skip:'sync-off'});
 assert.deepEqual(planScoutToObs(cfg,'break',{scenes:[],currentScene:undefined}),{switchTo:'BRB'},'with the scene list not yet known the request is attempted');
 assert.equal(obsSceneFor(cfg,'break'),'BRB');
 assert.equal(obsSceneFor(cfg,'veto'),undefined);
});

test('following OBS back into SCOUT needs two-way sync, a mapped scene, and never echoes SCOUT’s own switch',()=>{
 const both=config({sync:'both',sceneMap:{live:'GAME',break:'BRB',matchup:'BRB'}});
 assert.equal(planObsToScout(both,'GAME','break'),'live');
 assert.equal(planObsToScout(both,'BRB','live'),'matchup','two SCOUT scenes share BRB: the first in scene order wins');
 assert.equal(planObsToScout(both,'BRB','matchup'),undefined,'SCOUT is already on a scene that maps to BRB');
 assert.equal(planObsToScout(both,'BRB','break'),undefined,'…and so is this one: no loop');
 assert.equal(planObsToScout(both,'Other','live'),undefined,'an OBS scene nobody mapped is none of our business');
 assert.equal(planObsToScout({...both,sync:'scout'},'GAME','break'),undefined);
 assert.equal(planObsToScout({...both,sync:'off'},'GAME','break'),undefined);
});

test('the overlay browser source is recognised by its URL',()=>{
 for(const url of ['http://127.0.0.1:8080/obs','http://192.168.1.20:8080/game','https://overlay.example/obs?checker=1','http://host/game/','http://host/obs#x',' http://host/obs '])
  assert.equal(isOverlayUrl(url),true,url);
 for(const url of ['http://host:8080/admin','http://host/observer','http://host/','https://chat.example/widget','file:///obs','',undefined,'http://host/gamer'])
  assert.equal(isOverlayUrl(url),false,String(url));
});

// ---------------------------------------------------------------- the bridge against a mock OBS
const fast:ObsBridgeOptions={backoffMs:[15,30,60],requestTimeoutMs:200,handshakeTimeoutMs:400};
async function withObs(mockOptions:ConstructorParameters<typeof MockObs>[0],options:ObsBridgeOptions,run:(ctx:{mock:MockObs;bridge:ObsBridge;changes:()=>number;programScenes:string[]})=>Promise<void>){
 const mock=await MockObs.start(mockOptions);
 let changes=0;const programScenes:string[]=[];
 const bridge=new ObsBridge({...fast,onChange:()=>{changes++},onProgramScene:name=>programScenes.push(name),...options});
 try{await run({mock,bridge,changes:()=>changes,programScenes})}
 finally{bridge.close();await mock.stop()}
}
const connect=async(bridge:ObsBridge,mock:MockObs,over:Parameters<typeof config>[0]={})=>{bridge.configure(config({url:mock.url,...over}));await waitFor(()=>bridge.status().state==='connected',2000,'the bridge to connect');await waitFor(()=>bridge.status().scenes.length>0,2000,'the scene list')};

test('connects with the JSON subprotocol, identifies with the events we want, and reads OBS’s state',async()=>{
 await withObs({scenes:['GAME','BRB','LOBBY','Scene 10','Scene 2'],current:'BRB'},{},async({mock,bridge})=>{
  mock.streaming=true;
  await connect(bridge,mock);
  assert.deepEqual(mock.protocols,['obswebsocket.json']);
  assert.deepEqual(mock.identifies[0],{rpcVersion:1,eventSubscriptions:OBS_SUBSCRIPTIONS},'no authentication field when OBS asks for none');
  await waitFor(()=>bridge.status().streaming===true,2000,'the stream status');
  const status=bridge.status();
  assert.deepEqual([status.state,status.obsVersion,status.wsVersion,status.currentScene],['connected','31.0.0','5.6.0','BRB']);
  assert.deepEqual(status.scenes,['BRB','GAME','LOBBY','Scene 2','Scene 10'],'sorted naturally (Scene 2 before Scene 10)');
  assert.equal(status.recording,false);
  assert.equal(status.passwordSet,false);
 });
});

test('a password-protected OBS is answered with the documented authentication string',async()=>{
 await withObs({password:true},{password:()=>DOC_PASSWORD},async({mock,bridge})=>{
  await connect(bridge,mock);
  assert.equal(mock.identifies[0].authentication,DOC_AUTH);
  assert.equal(bridge.status().passwordSet,true);
  assert.ok(!JSON.stringify(bridge.status()).includes(DOC_PASSWORD),'the password never appears in the status that is broadcast');
 });
});

test('a wrong password is a terminal error: reported clearly and never retried',async()=>{
 await withObs({password:true},{password:()=>'not the password'},async({mock,bridge})=>{
  bridge.configure(config({url:mock.url}));
  await waitFor(()=>bridge.status().state==='error',2000,'the auth failure');
  assert.match(bridge.status().message,/rejected the password/i);
  assert.match(bridge.status().message,/OBS_WS_PASSWORD/);
  await sleep(250);
  assert.equal(mock.connections,1,'hammering OBS with a wrong password would fill its log and lock nobody in — one attempt only');
  assert.equal(bridge.status().state,'error');
 });
});

test('an OBS that wants a password the host does not have is reported before any Identify is sent',async()=>{
 await withObs({password:true},{},async({mock,bridge})=>{
  bridge.configure(config({url:mock.url}));
  await waitFor(()=>bridge.status().state==='error',2000,'the missing-password error');
  assert.match(bridge.status().message,/asks for a password.*OBS_WS_PASSWORD/i);
  assert.equal(mock.identifies.length,0);
  await sleep(120);
  assert.equal(mock.connections,1);
 });
});

test('re-saving the configuration retries after a terminal failure',async()=>{
 let password='wrong';
 await withObs({password:true},{password:()=>password},async({mock,bridge})=>{
  const cfg=config({url:mock.url});
  bridge.configure(cfg);
  await waitFor(()=>bridge.status().state==='error');
  password=DOC_PASSWORD;
  bridge.configure(cfg);
  await waitFor(()=>bridge.status().state==='connected',2000,'the retry to connect');
  assert.equal(mock.connections,2);
 });
});

test('a session kicked from OBS is not reconnected automatically',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  mock.closeAll(4011,'Kicked');
  await waitFor(()=>bridge.status().state==='error');
  assert.match(bridge.status().message,/kicked/i);
  await sleep(200);
  assert.equal(mock.connections,1);
  bridge.reconnect();
  await waitFor(()=>bridge.status().state==='connected',2000,'the operator-requested reconnect');
 });
});

test('a dropped connection is retried with backoff and recovers on its own',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  mock.closeAll(1001,'going away');
  await waitFor(()=>bridge.status().state==='connecting',2000,'the reconnecting state');
  assert.match(bridge.status().message,/retrying in/);
  assert.deepEqual(bridge.status().scenes,[],'stale OBS facts are cleared while disconnected');
  await waitFor(()=>bridge.status().state==='connected'&&bridge.status().scenes.length>0,2000,'the recovery');
  assert.equal(mock.connections,2);
 });
});

test('OBS not running yet is not an error: the bridge keeps trying and connects once it appears',async()=>{
 const probe=net.createServer();
 await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
 const port=(probe.address() as net.AddressInfo).port;
 await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const bridge=new ObsBridge({...fast,backoffMs:[20]});
 let mock:MockObs|undefined;
 try{
  bridge.configure(config({url:`ws://127.0.0.1:${port}`}));
  await waitFor(()=>bridge.status().state==='connecting'&&/not running/i.test(bridge.status().message),2000,'the "OBS is not running" message');
  mock=await MockObs.start({port});
  await waitFor(()=>bridge.status().state==='connected',3000,'the connection once OBS is up');
 }finally{bridge.close();await mock?.stop()}
});

test('a silent server that never says Hello does not hang the bridge forever',async()=>{
 await withObs({sayHello:false},{handshakeTimeoutMs:100},async({mock,bridge})=>{
  bridge.configure(config({url:mock.url}));
  await waitFor(()=>mock.connections>=2,2000,'a second attempt after the handshake timeout');
  assert.notEqual(bridge.status().state,'connected');
 });
});

test('switching a scene asks OBS by name and follows its event',async()=>{
 await withObs({},{},async({mock,bridge,programScenes})=>{
  await connect(bridge,mock);
  await bridge.switchScene('BRB');
  assert.deepEqual(mock.requests.filter(request=>request.type==='SetCurrentProgramScene').map(request=>request.data),[{sceneName:'BRB'}]);
  await waitFor(()=>bridge.status().currentScene==='BRB');
  assert.deepEqual(programScenes,['BRB'],'the program-scene callback fires for the echo too (the planner ignores it)');
  assert.equal(bridge.status().lastSwitch?.ok,true);
  await assert.rejects(bridge.switchScene('Nope'),/SetCurrentProgramScene failed: No scene was found/);
  assert.equal(bridge.status().lastSwitch?.ok,false);
  assert.match(bridge.status().lastSwitch?.error||'',/No scene was found/);
  assert.equal(bridge.status().currentScene,'BRB','a failed switch changes nothing');
 });
});

test('a SCOUT scene change is mapped, planned and sent — or skipped with a reason the panel can show',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock,{sceneMap:{break:'BRB',live:'GAME',winner:'Ghost scene'}});
  const sent=()=>mock.requests.filter(request=>request.type==='SetCurrentProgramScene').length;
  await bridge.onScoutScene('break');
  await waitFor(()=>bridge.status().currentScene==='BRB');
  assert.equal(sent(),1);
  await bridge.onScoutScene('break');
  assert.equal(sent(),1,'already there: no redundant request');
  await bridge.onScoutScene('lineups');
  assert.equal(sent(),1,'unmapped scene: OBS untouched');
  await bridge.onScoutScene('winner');
  assert.equal(sent(),1,'a scene OBS lacks is never requested');
  assert.match(bridge.status().lastSwitch?.error||'',/no scene named "Ghost scene"/);
  await bridge.onScoutScene('live');
  await waitFor(()=>bridge.status().currentScene==='GAME');
  assert.equal(sent(),2);
 });
});

test('with sync off SCOUT scenes never touch OBS, and a switch while disconnected is reported, not queued',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock,{sync:'off',sceneMap:{break:'BRB'}});
  await bridge.onScoutScene('break');
  assert.equal(mock.requests.some(request=>request.type==='SetCurrentProgramScene'),false);
  bridge.configure(config({url:mock.url,sync:'scout',sceneMap:{break:'BRB'}}));
  mock.closeAll(1001);
  await waitFor(()=>bridge.status().state==='connecting');
  await bridge.onScoutScene('break');
  assert.equal(bridge.status().lastSwitch?.ok,false);
  assert.match(bridge.status().lastSwitch?.error||'',/not connected/i);
 });
});

test('a scene changed inside OBS is reported so two-way sync can follow it',async()=>{
 await withObs({},{},async({mock,bridge,programScenes})=>{
  await connect(bridge,mock);
  mock.current='LOBBY';
  mock.emit('CurrentProgramSceneChanged',{sceneName:'LOBBY'});
  await waitFor(()=>programScenes.includes('LOBBY'));
  assert.equal(bridge.status().currentScene,'LOBBY');
 });
});

test('the scene list, stream and record state follow OBS’s events',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  mock.scenes.push('Interview');
  mock.emit('SceneListChanged',{scenes:[]});
  await waitFor(()=>bridge.status().scenes.includes('Interview'),2000,'the refreshed scene list');
  mock.emit('StreamStateChanged',{outputActive:true,outputState:'OBS_WEBSOCKET_OUTPUT_STARTED'});
  mock.emit('RecordStateChanged',{outputActive:true,outputState:'OBS_WEBSOCKET_OUTPUT_STARTED',outputPath:null});
  await waitFor(()=>bridge.status().streaming===true&&bridge.status().recording===true);
  mock.emit('RecordStateChanged',{outputActive:false,outputState:'OBS_WEBSOCKET_OUTPUT_STOPPED',outputPath:'/v/a.mkv'});
  await waitFor(()=>bridge.status().recording===false);
  assert.equal(bridge.status().streaming,true);
 });
});

test('OBS shutting down is reported and then recovered from',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  mock.emit('ExitStarted',undefined,1);
  await waitFor(()=>bridge.status().state==='connecting'&&/shutting down/.test(bridge.status().message));
  mock.closeAll(1001);
  await waitFor(()=>bridge.status().state==='connected',3000,'the reconnect after OBS came back');
 });
});

test('requests that OBS never answers time out, and a dead socket is dropped and re-established',async()=>{
 await withObs({silent:['Sleep']},{requestTimeoutMs:60},async({mock,bridge})=>{
  await connect(bridge,mock);
  await assert.rejects(bridge.request('Sleep',{sleepMillis:1}),/did not answer Sleep within 60 ms/);
  await assert.rejects(bridge.request('Sleep'),/did not answer/);
  await assert.rejects(bridge.request('Sleep'),/did not answer/);
  await waitFor(()=>mock.connections>=2,2000,'the reconnect after three unanswered requests');
 });
});

test('requests fail fast when OBS is not connected, and unknown requests surface OBS’s answer',async()=>{
 const idle=new ObsBridge(fast);
 await assert.rejects(idle.request('GetVersion'),/not connected/);
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  await assert.rejects(bridge.request('NoSuchRequest'),(error:any)=>/NoSuchRequest failed: unknown request/.test(error.message)&&error.code===204);
 });
});

test('garbage from the socket is ignored: bad JSON, wrong shapes, unknown ops, binary frames',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  for(const junk of ['not json','{','null','[]','"text"','{"op":99,"d":{}}','{"op":5}','{"op":5,"d":null}','{"op":7,"d":{"requestId":"nobody-asked"}}','{"op":5,"d":{"eventType":"CurrentProgramSceneChanged","eventData":{"sceneName":42}}}']) mock.sendRaw(junk);
  mock.sendRaw(Buffer.from([1,2,3,4]));
  await sleep(80);
  assert.equal(bridge.status().state,'connected');
  assert.equal(bridge.status().currentScene,'GAME');
  await bridge.switchScene('BRB');
 });
});

test('turning the integration off closes the connection and stays quiet',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  bridge.configure(config({url:mock.url,enabled:false}));
  assert.equal(bridge.status().state,'disabled');
  await waitFor(()=>mock.sockets.size===0,2000,'the socket to close');
  await sleep(120);
  assert.equal(mock.connections,1,'no reconnect while disabled');
  assert.deepEqual(bridge.status().scenes,[]);
 });
});

test('a disabled configuration never opens a socket at all',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  bridge.configure(obsConfigSchema.parse({url:mock.url}));
  await sleep(100);
  assert.equal(mock.connections,0);
  assert.deepEqual(bridge.status(),{...idleObsStatus(mock.url),lastSwitch:undefined});
 });
});

test('editing only the scene map keeps the connection; changing the address reconnects',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  const cfg=config({url:mock.url});
  await connect(bridge,mock);
  bridge.configure({...cfg,sceneMap:{...cfg.sceneMap,break:'BRB'}});
  await sleep(80);
  assert.equal(mock.connections,1,'a scene-map edit is not a reason to drop OBS');
  const second=await MockObs.start();
  try{
   bridge.configure({...cfg,url:second.url});
   await waitFor(()=>second.connections===1&&bridge.status().state==='connected',2000,'the connection to the new address');
   assert.equal(mock.sockets.size,0,'the old connection is closed');
  }finally{await second.stop()}
 });
});

test('refreshing the overlay finds the browser source by its URL and presses its reload button',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock);
  assert.deepEqual(await bridge.refreshOverlay(),['SCOUT overlay']);
  const presses=mock.requests.filter(request=>request.type==='PressInputPropertiesButton');
  assert.deepEqual(presses.map(request=>request.data),[{inputName:'SCOUT overlay',propertyName:'refreshnocache'}],'only the overlay, not the chat widget or the webcam');
  assert.deepEqual(mock.requests.find(request=>request.type==='GetInputList')?.data,{inputKind:'browser_source'});
 });
});

test('a browser source named in the configuration is refreshed without searching',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  await connect(bridge,mock,{browserSource:'My HUD'});
  assert.deepEqual(await bridge.refreshOverlay(),['My HUD']);
  assert.equal(mock.requests.some(request=>request.type==='GetInputList'),false);
  assert.deepEqual(mock.requests.filter(request=>request.type==='PressInputPropertiesButton').map(request=>request.data.inputName),['My HUD']);
 });
});

test('refreshing says so when no browser source loads the overlay',async()=>{
 await withObs({},{},async({mock,bridge})=>{
  mock.inputs=mock.inputs.filter(input=>input.inputName!=='SCOUT overlay');
  await connect(bridge,mock);
  await assert.rejects(bridge.refreshOverlay(),/No browser source in OBS loads this overlay/);
  assert.equal(mock.requests.some(request=>request.type==='PressInputPropertiesButton'),false);
 });
});
