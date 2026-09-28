import express from 'express';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {MatchStore} from './state.js';
const app=express(), server=createServer(app), store=new MatchStore();
const config=JSON.parse(await readFile('config/teams.json','utf8'));
const controlsSchema=z.object({scene:z.enum(['live','matchup','lineups','veto','break','winner']),radar:z.boolean(),killfeed:z.boolean(),lowerThird:z.boolean(),economy:z.boolean(),techPause:z.boolean(),swapped:z.boolean()});
let controls=controlsSchema.parse({scene:'live',radar:true,killfeed:true,lowerThird:true,economy:false,techPause:false,swapped:false});
try {controls=controlsSchema.parse(JSON.parse(await readFile('config/operator.json','utf8')))} catch{}
app.use(express.json({limit:'1mb'}));
const wss=new WebSocketServer({server,path:'/ws'});
function snapshot(){return {state:store.state,lastSeen:store.lastSeen,revision:store.revision,serverTime:Date.now(),config,controls}}
function broadcast(){const data=JSON.stringify(snapshot()); for(const client of wss.clients) if(client.readyState===WebSocket.OPEN){if(client.bufferedAmount>1e6) client.terminate(); else client.send(data)}}
wss.on('connection',ws=>ws.send(JSON.stringify(snapshot())));
setInterval(broadcast,1000).unref();
let raw:ReturnType<typeof createWriteStream>|undefined;
if(process.env.LOG_GSI==='1'){await mkdir('recordings',{recursive:true});raw=createWriteStream(`recordings/gsi-${Date.now()}.jsonl`,{flags:'a'});raw.on('error',error=>{console.error('GSI recording disabled:',error.message);raw=undefined})}
app.post('/gsi',(req,res)=>{
 if(req.body?.auth?.token!==(process.env.GSI_TOKEN||'CHANGE_ME')){res.status(401).json({error:'Invalid GSI token'});return}
 if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) || !req.body.provider || typeof req.body.provider!=='object'){res.status(400).json({error:'Expected GSI object with provider'});return}
 const {auth,...payload}=req.body;
 if(raw && raw.writableLength<1e6) raw.write(JSON.stringify({receivedAt:Date.now(),payload})+'\n');
 store.ingest(payload); res.sendStatus(200); broadcast();
});
app.get('/api/status',(_req,res)=>res.json(snapshot()));
app.put('/api/controls',async(req,res)=>{
 // Reject cross-site operator mutations; this is a local, trusted-LAN service.
 const origin=req.get('origin');if(origin && new URL(origin).host!==req.get('host')){res.sendStatus(403);return}
 const parsed=controlsSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid controls'});return}
 try {await writeFile('config/operator.json.tmp',JSON.stringify(parsed.data,null,2));await rename('config/operator.json.tmp','config/operator.json');controls=parsed.data;broadcast();res.json(controls)}catch{res.status(500).json({error:'Could not save controls'})}
});
if(process.env.NODE_ENV==='production'){app.use(express.static('dist'));app.get('*',(_req,res)=>res.sendFile(path.resolve('dist/index.html')))}else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares)}
app.use((err:any,_req:any,res:any,_next:any)=>{res.status(err.status||500).json({error:err.status===400?'Invalid JSON':'Request failed'})});
server.listen(Number(process.env.PORT)||8080,'0.0.0.0',()=>console.log('SCOUT host ready on port '+(process.env.PORT||8080)));
