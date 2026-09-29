import express from 'express';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {readFile,writeFile,rename,mkdir,readdir,unlink} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {MatchStore,FeedMonitor,type TokenSource} from './state.js';
import {EventTracker} from './events.js';
import {SideTracker,configSides} from './sides.js';
import {seriesState} from './series.js';
import {configSchema,normalizeConfig,type ScoutConfig} from './config.js';
import {layoutSchema,type LayoutConfig} from './layout.js';
import {radarsSchema} from './radars.js';
const app=express(), server=createServer(app), store=new MatchStore(), events=new EventTracker(), sides=new SideTracker();
const port=Number(process.env.PORT)||8080;
// Only the *source* of the token is ever recorded — the token value itself is never stored or logged.
const tokenSource:TokenSource=process.env.GSI_TOKEN?'env':'default';
const feed=new FeedMonitor(tokenSource,port);
// Operator configuration (teams, rosters, map series, tournament tree) is loaded through the same
// schema the panel saves with, so a hand-edited file is normalized exactly like a panel edit.
let config:ScoutConfig;
try{config=normalizeConfig(JSON.parse(await readFile('config/teams.json','utf8')))}
catch(error:any){console.error('[config] config/teams.json is invalid:',error.message);throw error}
// Radar calibration is operator data: pos_x/pos_y/scale from resource/overviews/<map>.txt, plus an
// optional image under public/radars/. A map without an entry has no radar, never a made-up one.
let radars:any={}; try {radars=JSON.parse(await readFile('config/radars.json','utf8'))} catch (error:any) {console.warn('[radars] config/radars.json unreadable — the radar stays off:',error.message)}
const controlsSchema=z.object({scene:z.enum(['live','matchup','lineups','veto','bracket','break','winner']),radar:z.boolean(),killfeed:z.boolean(),lowerThird:z.boolean(),economy:z.boolean(),techPause:z.boolean(),swapped:z.boolean()});
let controls=controlsSchema.parse({scene:'live',radar:true,killfeed:true,lowerThird:true,economy:false,techPause:false,swapped:false});
try {controls=controlsSchema.parse(JSON.parse(await readFile('config/operator.json','utf8')))} catch{}
// Overlay element positions (event header, scoreboard, radar, killfeed, rosters, lower-third,
// economy bar, footer) are edited by dragging in the admin preview and saved to
// config/layout.json (gitignored — defaults live in the CSS). Missing file = CSS defaults.
let layout:LayoutConfig={elements:{}};
// A missing file is the normal first-run state (the file is gitignored and the CSS defaults apply),
// so only a file that exists but cannot be parsed is worth a warning.
try {layout=layoutSchema.parse(JSON.parse(await readFile('config/layout.json','utf8')))} catch (error:any) {try{await readFile('config/layout.json');console.warn('[layout] config/layout.json is invalid — the CSS defaults stay in use:',error.message)}catch{}}
// Team logos, map pictures and radar images are operator uploads. They live under public/uploads/
// (gitignored) and are stored as plain image files referenced by path from config/teams.json or
// config/radars.json.
const UPLOAD_ROOT='public/uploads';
const IMAGE_EXTS:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg'};
const UPLOAD_KINDS:Record<string,{dir:string;exts:Record<string,string>}>={
 logo:{dir:'logos',exts:IMAGE_EXTS},
 map:{dir:'maps',exts:IMAGE_EXTS},
 radar:{dir:'radars',exts:IMAGE_EXTS},
};
await mkdir(path.join(UPLOAD_ROOT,'logos'),{recursive:true});
await mkdir(path.join(UPLOAD_ROOT,'maps'),{recursive:true});
await mkdir(path.join(UPLOAD_ROOT,'radars'),{recursive:true});
// The upload body is a base64 data URL, so this route gets its own larger JSON parser before the
// 1 mb global limit applies to the GSI hot path.
const uploadSchema=z.object({kind:z.enum(['logo','map','radar']),name:z.string().trim().max(120).optional().default(''),data:z.string().max(14*1024*1024)});
app.post('/api/upload',express.json({limit:'12mb'}),async(req,res)=>{
 const origin=req.get('origin');if(origin && new URL(origin).host!==req.get('host')){res.sendStatus(403);return}
 const parsed=uploadSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Expected {kind, name, data} with a base64 image data URL'});return}
 const {kind,name,data}=parsed.data;
 const match=/^data:(image\/(?:png|jpeg|jpg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(data);
 const spec=UPLOAD_KINDS[kind];
 if(!match||!spec){res.status(400).json({error:'Unsupported image — upload a PNG, JPEG, GIF, WEBP or SVG'});return}
 const buffer=Buffer.from(match[2],'base64');
 if(buffer.length<8||buffer.length>5*1024*1024){res.status(400).json({error:'Image must be between 8 bytes and 5 MB'});return}
 const mime=match[1].toLowerCase(), ext=spec.exts[mime];
 const slug=(name.replace(/\.[a-z0-9]+$/i,'').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,48)||'image').toLowerCase();
 const file=`${Date.now()}-${slug}.${ext}`, dir=path.join(UPLOAD_ROOT,spec.dir);
 await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,file),buffer);
 res.json({path:`uploads/${spec.dir}/${file}`});
});
// Uploaded assets must be reachable in production too, where the Vite public/ copy in dist/ is a
// build-time snapshot and would miss anything the admin uploads later.
app.use('/uploads',express.static(UPLOAD_ROOT,{immutable:true,maxAge:'7d'}));
// Drop-in radar images (public/radars/<map>.png) get the same treatment: dist/ only knows the
// files that existed at build time, but operators replace these while a tournament is running.
app.use('/radars',express.static('public/radars'));
app.use(express.json({limit:'1mb'}));
const wss=new WebSocketServer({server,path:'/ws'});
function snapshot(){return {state:store.state,lastSeen:store.lastSeen,revision:store.revision,serverTime:Date.now(),config,controls,layout,gsi:feed.snapshot(),events:events.snapshot(),sides:store.revision?sides.resolve(store.state,config):configSides(config),series:seriesState(store.state,config),radars}}
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
 if(ingested){const derived=events.observe(store.state,Date.now(),ingested.reset);
  for(const kill of derived.kills) console.log(`[events] round ${kill.round+1}: ${kill.killerName||'unknown'} killed ${kill.victimName}${kill.headshot?' (headshot)':''}`);
  if(derived.ended) console.log(`[events] round ${derived.ended.round+1} won by ${derived.ended.winner||'unknown'} (${derived.ended.reason}) — ${derived.ended.ctScore}:${derived.ended.tScore}`);
  const issues=feed.issues(ingested.issues); if(issues.log) console.warn(`[gsi] repaired ${issues.count} invalid field${issues.count===1?'':'s'} (${feed.subtreeIssues} total) — last: ${issues.last.path} ${issues.last.reason}`)}
 else if(feed.late().log) console.warn(`[gsi] ignoring a packet older than the current state (${feed.rejectedLate} ignored). Expected while replaying a recording against a warm host, or when a second observer pushes with an older clock.`);
 res.sendStatus(200); broadcast();
});
app.get('/api/status',(_req,res)=>res.json(snapshot()));
app.get('/api/config',(_req,res)=>res.json(config));
// Saving the operator configuration replaces config/teams.json atomically and broadcasts it to
// every connected view, so the HUD picks up teams, rosters, maps and the bracket without a restart.
app.put('/api/config',async(req,res)=>{
 const origin=req.get('origin');if(origin && new URL(origin).host!==req.get('host')){res.sendStatus(403);return}
 const parsed=configSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid configuration: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'config'} ${issue.message}`).slice(0,6).join('; ')});return}
 const next=normalizeConfig(parsed.data);
 try {
  await writeFile('config/teams.json.tmp',JSON.stringify(next,null,2));
  await rename('config/teams.json.tmp','config/teams.json');
  config=next;
  await pruneUploads(next,radars);
  broadcast();res.json(config);
 }catch{res.status(500).json({error:'Could not save configuration'})}
});
// Uploaded logos, map pictures and radar images are replaced freely; anything no longer referenced
// by the saved configuration is deleted so public/uploads/ cannot grow without bound across a long
// tournament. Drop-in files under public/radars/ are operator-managed and never pruned.
async function pruneUploads(current:ScoutConfig,radarsConfig:any){
 const referenced=new Set<string>();
 const keep=(value?:string)=>{if(value&&value.startsWith('uploads/')) referenced.add(value)};
 for(const team of current.teams) keep(team.logo);
 for(const map of current.maps) keep(map.image);
 for(const entry of Object.values(radarsConfig?.maps||{})) keep((entry as any)?.image);
 for(const kind of ['logos','maps','radars']){
  const dir=path.join(UPLOAD_ROOT,kind);
  let files:string[]=[];try{files=await readdir(dir)}catch{continue}
  for(const file of files){
   if(file==='.gitkeep') continue;
   const rel=`uploads/${kind}/${file}`;
   if(!referenced.has(rel)){try{await unlink(path.join(dir,file))}catch{}}
  }
 }
}
app.put('/api/controls',async(req,res)=>{
 // Reject cross-site operator mutations; this is a local, trusted-LAN service.
 const origin=req.get('origin');if(origin && new URL(origin).host!==req.get('host')){res.sendStatus(403);return}
 const parsed=controlsSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid controls'});return}
 try {await writeFile('config/operator.json.tmp',JSON.stringify(parsed.data,null,2));await rename('config/operator.json.tmp','config/operator.json');controls=parsed.data;broadcast();res.json(controls)}catch{res.status(500).json({error:'Could not save controls'})}
});
// Radar calibration + custom images are operator data: the admin panel's Custom radars editor PUTs
// here, the file is replaced atomically, and every output view re-renders with the new radar.
app.put('/api/radars',async(req,res)=>{
 const origin=req.get('origin');if(origin && new URL(origin).host!==req.get('host')){res.sendStatus(403);return}
 const parsed=radarsSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid radar configuration: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'radars'} ${issue.message}`).slice(0,6).join('; ')});return}
 const next=parsed.data;
 try {
  await writeFile('config/radars.json.tmp',JSON.stringify(next,null,2));
  await rename('config/radars.json.tmp','config/radars.json');
  radars=next;
  await pruneUploads(config,next);
  broadcast();res.json(radars);
 }catch{res.status(500).json({error:'Could not save radar configuration'})}
});
// Overlay element positions from the admin's Arrange mode. Saved as top-left coordinates on the
// 1920×1080 canvas; an empty elements map is the shipped CSS default layout.
app.put('/api/layout',async(req,res)=>{
 const origin=req.get('origin');if(origin && new URL(origin).host!==req.get('host')){res.sendStatus(403);return}
 const parsed=layoutSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid layout: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'layout'} ${issue.message}`).slice(0,6).join('; ')});return}
 try {
  await writeFile('config/layout.json.tmp',JSON.stringify(parsed.data,null,2));
  await rename('config/layout.json.tmp','config/layout.json');
  layout=parsed.data;
  broadcast();res.json(layout);
 }catch{res.status(500).json({error:'Could not save layout'})}
});
if(process.env.NODE_ENV==='production'){app.use(express.static('dist'));app.get('*',(_req,res)=>res.sendFile(path.resolve('dist/index.html')))}else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares)}
app.use((err:any,_req:any,res:any,_next:any)=>{res.status(err.status||500).json({error:err.status===400?'Invalid JSON':'Request failed'})});
server.listen(port,'0.0.0.0',()=>console.log('SCOUT host ready on port '+port+'\n[gsi] expecting CS2 pushes at '+feed.uri+' · token source: '+tokenSource+(tokenSource==='default'?' (built-in CHANGE_ME — set GSI_TOKEN before using a changed cfg token)':'')));
