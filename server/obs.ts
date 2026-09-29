import {createHash} from 'node:crypto';
import WebSocket from 'ws';
import type {SceneId} from './controls.js';
import {idleObsStatus,isOverlayUrl,planScoutToObs,type ObsConfig,type ObsState,type ObsStatus,type ObsSwitchResult} from './obs-config.js';
// The OBS Studio bridge: an optional, outbound-only obs-websocket 5.x client. SCOUT never depends on it — the
// host starts, ingests GSI and serves the overlay identically with it off, unreachable or wrongly configured.
// It only ever reports status and, when the operator maps scenes, switches OBS's program scene.
//
// Protocol (https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md), JSON encoding:
//   server → Hello(0) → client Identify(1, rpcVersion, authentication?, eventSubscriptions) → server Identified(2)
//   then Request(6) ⇄ RequestResponse(7) and Event(5). A wrong password closes the socket with 4009.
export const OBS_SUBPROTOCOL='obswebsocket.json';
export const OBS_RPC_VERSION=1;
// EventSubscription bits: General (ExitStarted) | Scenes | Outputs. The high-volume events (volume meters,
// transforms) are never requested — the bridge has no use for them and OBS would stream them at 20 Hz.
export const OBS_SUBSCRIPTIONS=(1<<0)|(1<<2)|(1<<6);
export const OBS_CLOSE={authenticationFailed:4009,unsupportedRpcVersion:4010,sessionInvalidated:4011} as const;
const Op={hello:0,identify:1,identified:2,event:5,request:6,response:7} as const;

// secret = base64(sha256(password + salt)); authentication = base64(sha256(secret + challenge))
export function obsAuth(password:string,salt:string,challenge:string):string {
 const secret=createHash('sha256').update(password+salt).digest('base64');
 return createHash('sha256').update(secret+challenge).digest('base64');
}

export class ObsError extends Error {
 constructor(message:string,readonly code?:number){super(message);this.name='ObsError'}
}
export interface ObsBridgeOptions {
 // Read lazily so the password is never copied into this object or its status.
 password?:()=>string|undefined;
 // The status changed — the host broadcasts a fresh snapshot.
 onChange?:()=>void;
 // OBS reports its program scene (a switch made in OBS, or the echo of one SCOUT made).
 onProgramScene?:(name:string)=>void;
 log?:(message:string)=>void;
 backoffMs?:number[];
 requestTimeoutMs?:number;
 handshakeTimeoutMs?:number;
 now?:()=>number;
}
interface Pending {resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;type:string}
const text=(value:unknown)=>typeof value==='string'&&value?value:undefined;
const describe=(error:any)=>error?.code==='ECONNREFUSED'?'OBS is not running, or its WebSocket server is off (Tools > WebSocket Server Settings)':String(error?.message||error||'connection failed');

export class ObsBridge {
 private config?:ObsConfig;
 private socket?:WebSocket;
 private generation=0;
 private halted=false;
 private attempt=0;
 private consecutiveTimeouts=0;
 private nextId=1;
 private pending=new Map<string,Pending>();
 private reconnectTimer?:ReturnType<typeof setTimeout>;
 private handshakeTimer?:ReturnType<typeof setTimeout>;
 private lastError='';
 private state:ObsState='disabled';
 private message='OBS integration is off';
 private info:{obsVersion?:string;wsVersion?:string;scenes:string[];currentScene?:string;streaming?:boolean;recording?:boolean}={scenes:[]};
 private lastSwitch?:ObsSwitchResult;
 private readonly backoff:number[];
 private readonly requestTimeout:number;
 private readonly handshakeTimeout:number;
 constructor(private readonly options:ObsBridgeOptions={}){
  this.backoff=options.backoffMs?.length?options.backoffMs:[1000,2000,4000,8000,15000];
  this.requestTimeout=options.requestTimeoutMs??5000;
  this.handshakeTimeout=options.handshakeTimeoutMs??8000;
 }

 // ---- lifecycle ----
 // Apply a (new) configuration. Editing only the scene map or sync mode keeps the connection; a new address,
 // enabling, or re-saving after a terminal failure (wrong password, kicked) starts a fresh attempt.
 configure(config:ObsConfig):void {
  const previous=this.config;
  this.config=config;
  if(!config.enabled){this.stop('disabled','OBS integration is off');return}
  const restart=!previous||!previous.enabled||previous.url!==config.url||this.state==='error'||this.state==='disabled';
  if(restart) this.start();else this.changed();
 }
 // The panel's "Reconnect" button: an operator-requested retry, also out of a terminal failure.
 reconnect():void {if(this.config?.enabled) this.start()}
 close():void {this.config=this.config?{...this.config,enabled:false}:undefined;this.stop('disabled','OBS integration is off')}

 status():ObsStatus {
  return {...idleObsStatus(this.config?.url),state:this.state,message:this.message,passwordSet:!!this.options.password?.(),
   ...this.info,scenes:[...this.info.scenes],lastSwitch:this.lastSwitch};
 }

 private start(){
  this.teardown();
  this.halted=false;this.attempt=0;this.lastError='';
  this.connect();
 }
 private stop(state:ObsState,message:string){
  this.teardown();
  this.halted=true;
  this.info={scenes:[]};
  this.set(state,message);
 }
 // Cancel every timer, invalidate callbacks of the old socket (they compare `generation`), reject requests.
 private teardown(){
  this.generation++;
  if(this.reconnectTimer) clearTimeout(this.reconnectTimer);
  if(this.handshakeTimer) clearTimeout(this.handshakeTimer);
  this.reconnectTimer=this.handshakeTimer=undefined;
  const socket=this.socket;this.socket=undefined;
  if(socket){socket.removeAllListeners();socket.on('error',()=>{});try{socket.readyState===WebSocket.OPEN?socket.close(1000):socket.terminate()}catch{}}
  this.rejectPending(new ObsError('OBS connection closed'));
  this.consecutiveTimeouts=0;
 }
 private connect(){
  const config=this.config;
  if(!config?.enabled) return;
  const generation=++this.generation;
  this.set('connecting',`Connecting to ${config.url}…`);
  let socket:WebSocket;
  try{socket=new WebSocket(config.url,OBS_SUBPROTOCOL,{handshakeTimeout:this.handshakeTimeout})}
  catch(error){this.halt(`Cannot connect: ${describe(error)}`);return}
  this.socket=socket;
  socket.on('open',()=>{
   if(generation!==this.generation) return;
   this.set('authenticating','Waiting for OBS to accept the connection…');
   // A server that accepts the socket but never says Hello (or never answers Identify) must not hang forever.
   this.handshakeTimer=setTimeout(()=>{if(generation===this.generation){this.lastError='OBS did not finish the handshake';socket.terminate()}},this.handshakeTimeout);
  });
  socket.on('message',(data,isBinary)=>{if(generation===this.generation&&!isBinary) this.onMessage(data.toString())});
  socket.on('error',error=>{if(generation===this.generation) this.lastError=describe(error)});
  socket.on('close',(code,reason)=>{if(generation===this.generation) this.onClose(code,reason.toString())});
 }
 // A failure retrying cannot fix. The operator has to change something (password, address) and save or reconnect.
 private halt(message:string){
  this.halted=true;
  this.teardown();
  this.info={scenes:[]};
  this.set('error',message);
  this.options.log?.(`[obs] ${message}`);
 }
 private onClose(code:number,reason:string){
  this.socket=undefined;
  if(this.handshakeTimer) clearTimeout(this.handshakeTimer);
  this.handshakeTimer=undefined;
  this.rejectPending(new ObsError('OBS connection closed'));
  this.info={scenes:[]};
  if(this.halted) return;
  if(code===OBS_CLOSE.authenticationFailed) return this.halt('OBS rejected the password — check OBS_WS_PASSWORD against Tools > WebSocket Server Settings');
  if(code===OBS_CLOSE.unsupportedRpcVersion) return this.halt('This OBS WebSocket server is too old — obs-websocket 5.x (OBS 28 or newer) is required');
  // "You must not automatically reconnect" — the operator kicked this session from OBS's session list.
  if(code===OBS_CLOSE.sessionInvalidated) return this.halt('OBS disconnected this session (kicked from its WebSocket session list)');
  this.schedule(this.lastError||`connection closed (${code}${reason?`: ${reason}`:''})`);
 }
 private schedule(reason:string){
  if(!this.config?.enabled||this.halted) return;
  const delay=this.backoff[Math.min(this.attempt,this.backoff.length-1)];
  this.attempt++;
  this.set('connecting',`${reason} — retrying in ${delay>=1000?Math.round(delay/1000)+' s':delay+' ms'}`);
  this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=undefined;this.connect()},delay);
  this.reconnectTimer.unref?.();
 }

 // ---- protocol ----
 private send(op:number,data:Record<string,unknown>){
  if(this.socket?.readyState===WebSocket.OPEN) this.socket.send(JSON.stringify({op,d:data}));
 }
 private onMessage(raw:string){
  let message:any;
  try{message=JSON.parse(raw)}catch{return}
  if(!message||typeof message!=='object'||!message.d||typeof message.d!=='object') return;
  const data=message.d;
  if(message.op===Op.hello) this.onHello(data);
  else if(message.op===Op.identified) this.onIdentified();
  else if(message.op===Op.event) this.onEvent(data);
  else if(message.op===Op.response) this.onResponse(data);
 }
 private onHello(data:any){
  this.info.obsVersion=text(data.obsStudioVersion);
  this.info.wsVersion=text(data.obsWebSocketVersion);
  const identify:Record<string,unknown>={rpcVersion:OBS_RPC_VERSION,eventSubscriptions:OBS_SUBSCRIPTIONS};
  if(data.authentication){
   const {challenge,salt}=data.authentication, password=this.options.password?.();
   if(!password) return this.halt('OBS asks for a password — set OBS_WS_PASSWORD on the host and restart it');
   if(typeof challenge!=='string'||typeof salt!=='string') return this.halt('OBS sent a malformed authentication challenge');
   identify.authentication=obsAuth(password,salt,challenge);
  }
  this.send(Op.identify,identify);
 }
 private onIdentified(){
  if(this.handshakeTimer) clearTimeout(this.handshakeTimer);
  this.handshakeTimer=undefined;
  this.attempt=0;this.lastError='';
  this.set('connected',`Connected to OBS${this.info.obsVersion?` ${this.info.obsVersion}`:''}`);
  this.options.log?.(`[obs] connected to ${this.config?.url}${this.info.wsVersion?` (obs-websocket ${this.info.wsVersion})`:''}`);
  const generation=this.generation;
  // Initial picture of OBS. Each part is best-effort: a failure leaves that field unknown, nothing more.
  void Promise.allSettled([this.refreshScenes(),this.refreshOutputs()]).then(()=>{if(generation===this.generation) this.changed()});
 }
 private onEvent(data:any){
  const payload=data.eventData&&typeof data.eventData==='object'?data.eventData:{};
  switch(data.eventType){
   case 'CurrentProgramSceneChanged':{
    const name=text(payload.sceneName);
    if(name){this.info.currentScene=name;this.changed();this.options.onProgramScene?.(name)}
    break}
   // Re-query instead of trusting the payload shape: any change to the scene list means the list is stale.
   case 'SceneListChanged':case 'SceneCreated':case 'SceneRemoved':case 'SceneNameChanged':
    void this.refreshScenes().then(()=>this.changed(),()=>{});break;
   case 'StreamStateChanged':this.info.streaming=payload.outputActive===true;this.changed();break;
   case 'RecordStateChanged':this.info.recording=payload.outputActive===true;this.changed();break;
   case 'ExitStarted':this.set('connecting','OBS is shutting down');break;
  }
 }
 private onResponse(data:any){
  const id=text(data.requestId), pending=id?this.pending.get(id):undefined;
  if(!id||!pending) return;
  this.pending.delete(id);
  clearTimeout(pending.timer);
  this.consecutiveTimeouts=0;
  const status=data.requestStatus||{};
  if(status.result===true) pending.resolve(data.responseData&&typeof data.responseData==='object'?data.responseData:{});
  else pending.reject(new ObsError(`${pending.type} failed: ${status.comment||`OBS status ${status.code??'unknown'}`}`,Number(status.code)||undefined));
 }
 private rejectPending(error:Error){
  for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}
  this.pending.clear();
 }

 request<T=any>(type:string,data?:Record<string,unknown>,timeoutMs=this.requestTimeout):Promise<T> {
  if(this.state!=='connected'||this.socket?.readyState!==WebSocket.OPEN) return Promise.reject(new ObsError('OBS is not connected'));
  const id=`scout-${this.nextId++}`;
  return new Promise<T>((resolve,reject)=>{
   const timer=setTimeout(()=>{
    this.pending.delete(id);
    reject(new ObsError(`OBS did not answer ${type} within ${timeoutMs} ms`));
    // Three unanswered requests in a row mean the socket is dead without having closed: drop it and reconnect.
    if(++this.consecutiveTimeouts>=3){this.consecutiveTimeouts=0;this.lastError='OBS stopped answering';this.socket?.terminate()}
   },timeoutMs);
   this.pending.set(id,{resolve,reject,timer,type});
   this.send(Op.request,{requestType:type,requestId:id,...(data?{requestData:data}:{})});
  });
 }

 // ---- what SCOUT does with OBS ----
 private async refreshScenes(){
  const list=await this.request<{currentProgramSceneName?:string|null;scenes?:{sceneName?:string}[]}>('GetSceneList');
  const names=(Array.isArray(list.scenes)?list.scenes:[]).map(scene=>text(scene?.sceneName)).filter((name):name is string=>!!name);
  // OBS returns scenes in reverse UI order, so sort for a stable, searchable list rather than guess the order.
  this.info.scenes=[...new Set(names)].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  this.info.currentScene=text(list.currentProgramSceneName)??this.info.currentScene;
 }
 private async refreshOutputs(){
  const [stream,record]=await Promise.allSettled([this.request<{outputActive?:boolean}>('GetStreamStatus'),this.request<{outputActive?:boolean}>('GetRecordStatus')]);
  if(stream.status==='fulfilled') this.info.streaming=stream.value.outputActive===true;
  if(record.status==='fulfilled') this.info.recording=record.value.outputActive===true;
 }
 // Switch OBS's program scene. Failures are recorded so the panel can say why nothing happened.
 async switchScene(name:string):Promise<void> {
  const at=(this.options.now??Date.now)();
  try{
   await this.request('SetCurrentProgramScene',{sceneName:name});
   this.lastSwitch={scene:name,at,ok:true};
   this.changed();
  }catch(error:any){
   this.lastSwitch={scene:name,at,ok:false,error:error.message};
   this.changed();
   throw error;
  }
 }
 // A SCOUT scene changed. Resolves once OBS has been told (or immediately when there is nothing to do).
 async onScoutScene(scene:SceneId):Promise<void> {
  const config=this.config;
  if(!config?.enabled) return;
  const plan=planScoutToObs(config,scene,this.info);
  const at=(this.options.now??Date.now)();
  if(plan.switchTo){
   if(this.state!=='connected'){this.lastSwitch={scene:plan.switchTo,at,ok:false,error:'OBS is not connected'};this.changed();return}
   try{await this.switchScene(plan.switchTo)}catch(error:any){this.options.log?.(`[obs] could not switch to "${plan.switchTo}": ${error.message}`)}
  }else if(plan.skip==='unknown-scene'){
   const target=config.sceneMap[scene];
   this.lastSwitch={scene:target,at,ok:false,error:`OBS has no scene named "${target}"`};
   this.changed();
  }
 }
 // Reload the overlay's browser source in OBS (the "refresh cache of current page" button), finding it by its
 // URL when the operator has not named it. Returns the names of the sources refreshed.
 async refreshOverlay():Promise<string[]> {
  const configured=this.config?.browserSource?.trim();
  let names:string[]=configured?[configured]:[];
  if(!names.length){
   const list=await this.request<{inputs?:{inputName?:string}[]}>('GetInputList',{inputKind:'browser_source'});
   for(const input of Array.isArray(list.inputs)?list.inputs:[]){
    const name=text(input?.inputName);
    if(!name) continue;
    try{
     const settings=await this.request<{inputSettings?:{url?:string}}>('GetInputSettings',{inputName:name});
     if(isOverlayUrl(settings.inputSettings?.url)) names.push(name);
    }catch{/* an input that cannot be read is not ours */}
   }
  }
  if(!names.length) throw new ObsError('No browser source in OBS loads this overlay (/obs or /game) — enter its name to refresh it');
  for(const inputName of names) await this.request('PressInputPropertiesButton',{inputName,propertyName:'refreshnocache'});
  return names;
 }

 // ---- status plumbing ----
 private set(state:ObsState,message:string){this.state=state;this.message=message;this.changed()}
 private changed(){try{this.options.onChange?.()}catch{}}
}
