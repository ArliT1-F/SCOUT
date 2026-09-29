import {WebSocketServer,type WebSocket} from 'ws';
// A stand-in for OBS Studio's obs-websocket 5.x server, written from the protocol document (Hello → Identify →
// Identified, then Request/RequestResponse and Event, JSON subprotocol). It exists so the bridge is exercised
// over a real WebSocket, including the failure modes that matter (wrong password, kicked, dead socket).
//
// The authentication vector is the worked example in the protocol's "Creating an authentication string"
// section: the password below, with this salt and challenge, must produce DOC_AUTH. It is hard-coded here
// (not computed with the bridge's own function) so a mistake in the bridge cannot also fool the mock.
export const DOC_PASSWORD='supersecretpassword';
export const DOC_SALT='lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
export const DOC_CHALLENGE='+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
export const DOC_AUTH='1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=';

export interface MockOptions {
 password?:boolean;          // require DOC_PASSWORD
 scenes?:string[];
 current?:string;
 port?:number;
 silent?:string[];           // request types the server never answers
 sayHello?:boolean;          // false: accept the socket but never send Hello
}
export class MockObs {
 readonly identifies:any[]=[];
 readonly requests:{type:string;data:any}[]=[];
 readonly protocols:string[]=[];
 connections=0;
 scenes:string[];
 current:string;
 streaming=false;
 recording=false;
 inputs=[
  {inputName:'Webcam',inputKind:'v4l2_input',url:undefined as string|undefined},
  {inputName:'SCOUT overlay',inputKind:'browser_source',url:'http://192.168.1.20:8080/obs?checker=0'},
  {inputName:'Chat box',inputKind:'browser_source',url:'https://chat.example/widget'},
 ];
 readonly sockets=new Set<WebSocket>();
 private wss!:WebSocketServer;
 constructor(private readonly options:MockOptions={}){
  this.scenes=options.scenes??['GAME','BRB','LOBBY'];
  this.current=options.current??this.scenes[0];
 }
 static async start(options:MockOptions={}):Promise<MockObs> {
  const mock=new MockObs(options);
  await new Promise<void>((resolve,reject)=>{
   mock.wss=new WebSocketServer({port:options.port??0,host:'127.0.0.1',handleProtocols:protocols=>protocols.has('obswebsocket.json')?'obswebsocket.json':false});
   mock.wss.once('listening',()=>resolve());
   mock.wss.once('error',reject);
   mock.wss.on('connection',(socket,request)=>mock.accept(socket,String(request.headers['sec-websocket-protocol']||'')));
  });
  return mock;
 }
 get port():number {return (this.wss.address() as {port:number}).port}
 get url():string {return `ws://127.0.0.1:${this.port}`}

 private accept(socket:WebSocket,protocol:string){
  this.connections++;this.protocols.push(protocol);this.sockets.add(socket);
  socket.on('close',()=>this.sockets.delete(socket));
  socket.on('error',()=>{});
  if(this.options.sayHello!==false){
   const hello:any={obsStudioVersion:'31.0.0',obsWebSocketVersion:'5.6.0',rpcVersion:1};
   if(this.options.password) hello.authentication={challenge:DOC_CHALLENGE,salt:DOC_SALT};
   socket.send(JSON.stringify({op:0,d:hello}));
  }
  socket.on('message',data=>{
   let message:any;try{message=JSON.parse(data.toString())}catch{return}
   if(message.op===1) this.identify(socket,message.d);
   else if(message.op===6) this.request(socket,message.d);
  });
 }
 private identify(socket:WebSocket,data:any){
  this.identifies.push(data);
  if(this.options.password&&data.authentication!==DOC_AUTH){socket.close(4009,'Authentication failed.');return}
  socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}));
 }
 private respond(socket:WebSocket,d:any,ok:boolean,code:number,responseData?:any,comment?:string){
  socket.send(JSON.stringify({op:7,d:{requestType:d.requestType,requestId:d.requestId,requestStatus:{result:ok,code,...(comment?{comment}:{})},...(responseData?{responseData}:{})}}));
 }
 private request(socket:WebSocket,d:any){
  const data=d.requestData||{};
  this.requests.push({type:d.requestType,data});
  if(this.options.silent?.includes(d.requestType)) return;
  switch(d.requestType){
   case 'GetSceneList':
    return this.respond(socket,d,true,100,{currentProgramSceneName:this.current,currentProgramSceneUuid:'u',currentPreviewSceneName:null,currentPreviewSceneUuid:null,scenes:[...this.scenes].reverse().map((sceneName,i)=>({sceneName,sceneIndex:i,sceneUuid:`uuid-${sceneName}`}))});
   case 'SetCurrentProgramScene':
    if(!this.scenes.includes(data.sceneName)) return this.respond(socket,d,false,600,undefined,'No scene was found by the name of `'+data.sceneName+'`.');
    this.current=data.sceneName;
    this.respond(socket,d,true,100);
    return this.emit('CurrentProgramSceneChanged',{sceneName:this.current,sceneUuid:`uuid-${this.current}`});
   case 'GetStreamStatus':return this.respond(socket,d,true,100,{outputActive:this.streaming,outputReconnecting:false});
   case 'GetRecordStatus':return this.respond(socket,d,true,100,{outputActive:this.recording,outputPaused:false});
   case 'GetInputList':return this.respond(socket,d,true,100,{inputs:this.inputs.filter(input=>!data.inputKind||input.inputKind===data.inputKind).map(({inputName,inputKind})=>({inputName,inputKind,unversionedInputKind:inputKind,inputUuid:`uuid-${inputName}`}))});
   case 'GetInputSettings':{
    const input=this.inputs.find(candidate=>candidate.inputName===data.inputName);
    return input?this.respond(socket,d,true,100,{inputKind:input.inputKind,inputSettings:input.url?{url:input.url}:{}}):this.respond(socket,d,false,600,undefined,'No input was found by the name of `'+data.inputName+'`.');
   }
   case 'PressInputPropertiesButton':return this.respond(socket,d,true,100);
   default:return this.respond(socket,d,false,204,undefined,'unknown request');
  }
 }
 emit(eventType:string,eventData?:any,intent=4){
  for(const socket of this.sockets) socket.send(JSON.stringify({op:5,d:{eventType,eventIntent:intent,...(eventData?{eventData}:{})}}));
 }
 // Send something the bridge must shrug off.
 sendRaw(payload:string|Buffer){for(const socket of this.sockets) socket.send(payload)}
 closeAll(code=1001,reason=''){for(const socket of this.sockets) socket.close(code,reason)}
 async stop(){
  for(const socket of this.sockets) socket.terminate();
  await new Promise<void>(resolve=>this.wss.close(()=>resolve()));
 }
}
export async function waitFor(check:()=>boolean,timeoutMs=2000,what='condition'):Promise<void> {
 const start=Date.now();
 while(!check()){
  if(Date.now()-start>timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
  await new Promise(resolve=>setTimeout(resolve,5));
 }
}
export const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
