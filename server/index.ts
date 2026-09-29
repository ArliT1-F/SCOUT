import express from 'express';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {MatchStore,FeedMonitor,type TokenSource} from './state.js';
const app=express(), server=createServer(app), store=new MatchStore();
const port=Number(process.env.PORT)||8080;
// Only the *source* of the token is ever recorded — the token value itself is never stored or logged.
const tokenSource:TokenSource=process.env.GSI_TOKEN?'env':'default';
const feed=new FeedMonitor(tokenSource,port);
const config=JSON.parse(await readFile('config/teams.json','utf8'));
const controlsSchema=z.object({scene:z.enum(['live','matchup','lineups','veto','break','winner']),radar:z.boolean(),killfeed:z.boolean(),lowerThird:z.boolean(),economy:z.boolean(),techPause:z.boolean(),swapped:z.boolean()});
let controls=controlsSchema.parse({scene:'live',radar:true,killfeed:true,lowerThird:true,economy:false,techPause:false,swapped:false});
try {controls=controlsSchema.parse(JSON.parse(await readFile('config/operator.json','utf8')))} catch{}
app.use(express.json({limit:'1mb'}));
const wss=new WebSocketServer({server,path:'/ws'});
function snapshot(){return {state:store.state,lastSeen:store.lastSeen,revision:store.revision,serverTime:Date.now(),config,controls,gsi:feed.snapshot()}}
function broadcast(){const data=JSON.stringify(snapshot()); for(const client of wss.clients) if(client.readyState===WebSocket.OPEN){if(client.bufferedAmount>1e6) client.terminate(); else client.send(data)}}
wss.on('connection',ws=>ws.send(JSON.stringify(snapshot())));
setInterval(broadcast,1000).unref();
let raw:ReturnType<typeof createWriteStream>|undefined;
if(process.env.LOG_GSI==='1'){await mkdir('recordings',{recursive:true});raw=createWriteStream(`recordings/gsi-${Date.now()}.jsonl`,{flags:'a'});raw.on('error',error=>{console.error('GSI recording disabled:',error.message);raw=undefined})}
app.post('/gsi',(req,res)=>{
 if(req.body?.auth?.token!==(process.env.GSI_TOKEN||'CHANGE_ME')){
  // ~20 Hz of rejects would flood the console, so the reason is logged at most once per 10 s.
  const {log}=feed.reject('auth','invalid token');
  if(log) console.warn(`[gsi] rejected a packet with an invalid token (${feed.rejectedAuth} rejected${feed.accepted?' so far, '+feed.accepted+' accepted':''}). The cfg auth token and GSI_TOKEN must match; this host is using the ${tokenSource} token.`);
  res.status(401).json({error:'Invalid GSI token'});return
 }
 if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) || !req.body.provider || typeof req.body.provider!=='object'){
  const {log}=feed.reject('shape','missing provider block');
  if(log) console.warn(`[gsi] rejected a packet without a provider block (${feed.rejectedShape} shape-rejected). Confirm the cfg is not saved as .cfg.txt and that CS2 was fully restarted.`);
  res.status(400).json({error:'Expected GSI object with provider'});return
 }
 const {auth,...payload}=req.body;
 const report=feed.accept(payload);
 if(report.first) console.log(`[gsi] first packet accepted — blocks: ${Object.keys(feed.blocks).join(', ')||'(none)'}${feed.provider?', provider '+feed.provider:''}`);
 if(report.firstAllplayers) console.log(`[gsi] allplayers block received (${feed.allplayers} player${feed.allplayers===1?'':'s'}) — observer mode confirmed`);
 if(report.observerGap) console.warn(`[gsi] ${feed.accepted} packets accepted but no allplayers block yet — CS2 is playing, not spectating. Scoreboard and clock will work; rosters and killfeed stay empty until you join as observer or GOTV.`);
 if(raw && raw.writableLength<1e6) raw.write(JSON.stringify({receivedAt:Date.now(),payload})+'\n');
 const ingested=store.ingest(payload);
 // Recovered subtrees are normal (CS2 empties fields between rounds), so they are counted and logged
 // at most once per 10 s instead of once per packet.
 if(ingested){const issues=feed.issues(ingested.issues); if(issues.log) console.warn(`[gsi] repaired ${issues.count} invalid field${issues.count===1?'':'s'} (${feed.subtreeIssues} total) — last: ${issues.last.path} ${issues.last.reason}`)}
 res.sendStatus(200); broadcast();
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
server.listen(port,'0.0.0.0',()=>console.log('SCOUT host ready on port '+port+'\n[gsi] expecting CS2 pushes at '+feed.uri+' · token source: '+tokenSource+(tokenSource==='default'?' (built-in CHANGE_ME — set GSI_TOKEN before using a changed cfg token)':'')));
