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
import {UPLOAD_DIRS,referencedUploads,isPrunable} from './uploads.js';
import {controlsSchema,defaultControls,type Controls} from './controls.js';
import {ObsBridge} from './obs.js';
import {obsConfigSchema,defaultObsConfig,planObsToScout,type ObsConfig} from './obs-config.js';
import {PanelAuth,PANEL_COOKIE,cookieValue,originTrusted,requestIsSecure,clearedCookie,panelUrls,type PanelSessionView} from './auth.js';
const app=express(), server=createServer(app), store=new MatchStore(), events=new EventTracker(), sides=new SideTracker();
const port=Number(process.env.PORT)||8080;
// ---- Operator access from another machine (server/auth.ts). Reads stay open on purpose: the OBS
// browser source of a second machine has to load /obs and its WebSocket feed with no credentials, and
// so does a wall display. Everything that *changes* the broadcast needs authority: the operator at
// this machine, or a session unlocked with the panel token. With no SCOUT_PANEL_TOKEN the host
// generates one per run and prints it here — the console is the only place it is ever shown.
const panelToken=process.env.SCOUT_PANEL_TOKEN?.trim()||'';
const panel=new PanelAuth({
 token:panelToken,
 remoteEnabled:process.env.SCOUT_REMOTE?.toLowerCase()!=='off',
 requireLocalToken:process.env.SCOUT_REQUIRE_TOKEN==='1',
 allowedHosts:process.env.SCOUT_ALLOWED_HOSTS,
});
if(panelToken&&panelToken.length<16) console.warn(`[panel] SCOUT_PANEL_TOKEN is only ${panelToken.length} characters — use a long random token when the network is not yours alone.`);
if(panel.tokenSource==='generated') console.log('[panel] No SCOUT_PANEL_TOKEN set, so this run has its own token. Set the variable to keep one token across restarts.');
if(panel.remoteEnabled){
 const nearby=panelUrls(port);
 console.log('[panel] Remote control is ON — open one of these from the other machine. The link carries the token, once:');
 for(const base of nearby.length?nearby:[`http://localhost:${port}`]) console.log(`[panel]   ${base}/?token=${encodeURIComponent(panel.token)}`);
 if(!nearby.length) console.log('[panel]   (no LAN address found — connect to this machine through its own address)');
} else console.log('[panel] Remote control is OFF (SCOUT_REMOTE=off): only a request from this machine can change the broadcast.');
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
let controls:Controls=defaultControls;
try {controls=controlsSchema.parse(JSON.parse(await readFile('config/operator.json','utf8')))} catch{}
// Optional OBS Studio integration. config/obs.json is per-machine (gitignored); with no file the integration is off
// unless OBS_WS_URL is set. The password is never part of it — it only ever comes from OBS_WS_PASSWORD.
let obsConfig:ObsConfig=defaultObsConfig();
try {obsConfig=obsConfigSchema.parse({...defaultObsConfig(),...JSON.parse(await readFile('config/obs.json','utf8'))})} catch (error:any) {if(error?.code!=='ENOENT') console.warn('[obs] config/obs.json is invalid — using the defaults:',error.message)}
// Overlay element positions (event header, scoreboard, radar, killfeed, rosters, lower-third,
// economy bar, footer) are edited by dragging in the admin preview and saved to
// config/layout.json (gitignored — defaults live in the CSS). Missing file = CSS defaults.
let layout:LayoutConfig={elements:{}};
// A missing file is the normal first-run state (the file is gitignored and the CSS defaults apply),
// so only a file that exists but cannot be parsed is worth a warning.
try {layout=layoutSchema.parse(JSON.parse(await readFile('config/layout.json','utf8')))} catch (error:any) {try{await readFile('config/layout.json');console.warn('[layout] config/layout.json is invalid — the CSS defaults stay in use:',error.message)}catch{}}
// Team logos, map pictures, player portraits and radar images are operator uploads. They live under
// public/uploads/ (gitignored) and are stored as plain image files referenced by path from
// config/teams.json or config/radars.json.
const UPLOAD_ROOT='public/uploads';
const IMAGE_EXTS:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg'};
const UPLOAD_KINDS:Record<string,{dir:string;exts:Record<string,string>}>={
 logo:{dir:'logos',exts:IMAGE_EXTS},
 map:{dir:'maps',exts:IMAGE_EXTS},
 radar:{dir:'radars',exts:IMAGE_EXTS},
 player:{dir:'players',exts:IMAGE_EXTS},
};
for(const dir of UPLOAD_DIRS) await mkdir(path.join(UPLOAD_ROOT,dir),{recursive:true});
// ---- The gate in front of every mutation. It is deliberately path/method based rather than a list of
// routes: a route added later is protected by construction, whichever operator feature it belongs to.
// POST /gsi is CS2's own feed and authenticates with the GSI token inside its body, and POST/DELETE
// /api/session is the way in and the way out.
function isProtected(req:express.Request){
 if(!req.path.startsWith('/api/')) return false;
 if(req.method==='GET'||req.method==='HEAD'||req.method==='OPTIONS') return false;
 return req.path!=='/api/session';
}
// Same-origin as well as token: a browser page on another site must not be able to drive the panel,
// and a name the operator listed (a proxy that rewrites Host) is treated as the operator's own.
function sameOrigin(req:express.Request){return originTrusted(req.get('origin'),req.get('host'),panel.allowedHosts)}
function panelRequest(req:express.Request){return {address:req.socket.remoteAddress,host:req.get('host'),cookie:req.get('cookie'),headers:req.headers}}
app.use((req:express.Request,res:express.Response,next:express.NextFunction)=>{
 if(!isProtected(req)) return next();
 if(!sameOrigin(req)){res.status(403).json({error:'Cross-site operator requests are refused. Open the panel itself.'});return}
 const decision=panel.authorize(panelRequest(req));
 if(decision.ok) return next();
 res.status(decision.status).json({error:decision.message,code:decision.code,attemptsLeft:decision.attemptsLeft});
});
// `?token=…` is the link the host prints: it becomes a cookie and a redirect, so the token never
// stays in the address bar, in the browser history or in a Referer sent to another origin (the
// panel loads its fonts from one).
app.use((req:express.Request,res:express.Response,next:express.NextFunction)=>{
 const raw=req.query?.token;
 if(req.method!=='GET'||req.path.startsWith('/api/')||typeof raw!=='string'||!raw) return next();
 const attempt=panel.unlock({token:raw,address:req.socket.remoteAddress,host:req.get('host'),userAgent:req.get('user-agent'),secure:requestIsSecure(req.headers)});
 if(!attempt.ok){
  if(attempt.retryAfterMs) res.setHeader('Retry-After',String(Math.ceil(attempt.retryAfterMs/1000)));
  // The refusal page is plain HTML written by hand, so the message is escaped rather than trusted:
  // it can name the address the request came from.
  const escape=(value:string)=>value.replace(/[&<>]/g,character=>character==='&'?'&amp;':character==='<'?'&lt;':'&gt;');
  res.status(attempt.status).type('html').send(`<!doctype html><meta charset="utf-8"><title>SCOUT — panel locked</title><body style="font:14px system-ui;background:#0b0a0d;color:#efeaf2;padding:48px"><h1 style="font-size:18px">${attempt.code==='throttled'?'Too many wrong tokens':'That link is not valid'}</h1><p style="color:#ab9fb5;max-width:520px">${escape(attempt.message)}</p><p style="color:#7e7289">The token is printed on the host console when it starts.</p>`);
  console.warn(`[panel] refused a token link from ${req.socket.remoteAddress||'unknown'} — ${attempt.code}`);
  return;
 }
 console.log(`[panel] remote session opened from ${attempt.session.address} (${attempt.session.userAgent||'unknown client'}) — ${panel.sessionCount} active`);
 res.setHeader('Set-Cookie',attempt.cookie);
 const query:Record<string,string>={};
 for(const [key,value] of Object.entries(req.query)) if(key!=='token'&&typeof value==='string') query[key]=value;
 const search=new URLSearchParams(query).toString();
 res.redirect(302,req.path+(search?'?'+search:''));
});
// The upload body is a base64 data URL, so this route gets its own larger JSON parser before the
// 1 mb global limit applies to the GSI hot path.
const uploadSchema=z.object({kind:z.enum(['logo','map','radar','player']),name:z.string().trim().max(120).optional().default(''),data:z.string().max(14*1024*1024)});
app.post('/api/upload',express.json({limit:'12mb'}),async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
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
// Scene thumbnails (public/thumbs/<map>.png) are replaced the same way — dropped in mid-event —
// so they get a route of their own instead of relying on the build-time copy in dist/.
app.use('/thumbs',express.static('public/thumbs'));
app.use(express.json({limit:'1mb'}));
// The WebSocket carries the same snapshot the public overlay renders, so it stays readable — but a
// handshake from another site is refused: no legitimate cross-site client exists, and a rebound
// domain reaching this host is exactly what it looks like. A browser sends Origin, a native client
// does not, and a proxy keeps the public name in Host; those are the cases that pass.
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
 let pathname='';
 try {pathname=new URL(req.url||'/','http://localhost').pathname} catch {}
 if(pathname!=='/ws'){socket.destroy();return}
 if(!originTrusted(req.headers.origin,req.headers.host,panel.allowedHosts)){
  console.warn(`[panel] refused a WebSocket handshake with Origin ${req.headers.origin} (host ${req.headers.host}) — add that name to SCOUT_ALLOWED_HOSTS if it is your own panel address.`);
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  socket.destroy();return;
 }
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
function snapshot(session?:PanelSessionView){return {state:store.state,lastSeen:store.lastSeen,revision:store.revision,serverTime:Date.now(),config,controls,layout,gsi:feed.snapshot(),events:events.snapshot(),sides:store.revision?sides.resolve(store.state,config):configSides(config),series:seriesState(store.state,config),radars,obs:{config:obsConfig,status:obs.status()},...(session?{session}:{})}}
function broadcast(){const data=JSON.stringify(snapshot()); for(const client of wss.clients) if(client.readyState===WebSocket.OPEN){if(client.bufferedAmount>1e6) client.terminate(); else client.send(data)}}
// The first snapshot of a connection carries *that* connection's session view, so the panel knows
// whether it is local, remote, authenticated and when its session expires without a second request.
wss.on('connection',(ws,req)=>ws.send(JSON.stringify(snapshot(req?panel.view({address:req.socket.remoteAddress,host:req.headers.host,cookie:req.headers.cookie,headers:req.headers}):undefined))));
setInterval(broadcast,1000).unref();
// ---- Panel session: unlock with the token the host printed, keep the cookie, or send the token as
// `X-Scout-Token` / `Authorization: Bearer` on each mutation (that is the path for a script, and for a
// browser that refuses the cookie). Neither endpoint ever returns the token.
app.get('/api/session',(req,res)=>res.json(panel.view(panelRequest(req))));
const unlockSchema=z.object({token:z.string().trim().min(1).max(256)});
app.post('/api/session',(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 const parsed=unlockSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Enter the panel token printed by the host.',code:'no-session'});return}
 const attempt=panel.unlock({token:parsed.data.token,address:req.socket.remoteAddress,host:req.get('host'),userAgent:req.get('user-agent'),secure:requestIsSecure(req.headers)});
 if(!attempt.ok){
  if(attempt.retryAfterMs) res.setHeader('Retry-After',String(Math.ceil(attempt.retryAfterMs/1000)));
  // The address and the reason are logged; the token that was tried never is.
  console.warn(`[panel] refused an unlock from ${req.socket.remoteAddress||'unknown'} — ${attempt.code}${attempt.attemptsLeft!==undefined?` (${attempt.attemptsLeft} attempt(s) left)`:''}`);
  res.status(attempt.status).json({error:attempt.message,code:attempt.code,attemptsLeft:attempt.attemptsLeft});
  return;
 }
 console.log(`[panel] remote session opened from ${attempt.session.address} (${attempt.session.userAgent||'unknown client'}) — ${panel.sessionCount} active`);
 res.setHeader('Set-Cookie',attempt.cookie);
 res.json(panel.view({...panelRequest(req),headers:{},cookie:`${PANEL_COOKIE}=${attempt.session.id}`}));
});
app.delete('/api/session',(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(panel.logout(cookieValue(req.get('cookie'),PANEL_COOKIE))) console.log(`[panel] a remote session ended — ${panel.sessionCount} active`);
 res.setHeader('Set-Cookie',clearedCookie(requestIsSecure(req.headers)));
 res.json(panel.view({...panelRequest(req),headers:{},cookie:''}));
});
// ---- Optional OBS Studio bridge (server/obs.ts). Nothing here can affect GSI ingest or the overlay: the bridge only
// connects outward, every failure stays inside its own status, and with it off no socket is ever opened.
async function saveControls(next:Controls){
 await writeFile('config/operator.json.tmp',JSON.stringify(next,null,2));
 await rename('config/operator.json.tmp','config/operator.json');
 controls=next;broadcast();
}
const obs=new ObsBridge({
 password:()=>process.env.OBS_WS_PASSWORD||undefined,
 onChange:()=>broadcast(),
 log:message=>console.log(message),
 // OBS changed scene (a hotkey, a Stream Deck) or echoed SCOUT's own switch. Two-way sync follows the former; the
 // planner returns nothing for the latter, and this path never asks OBS to switch back, so it cannot loop.
 onProgramScene:name=>{const next=planObsToScout(obsConfig,name,controls.scene);if(next) saveControls({...controls,scene:next}).catch(()=>{})},
});
obs.configure(obsConfig);
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
app.get('/api/status',(req,res)=>res.json(snapshot(panel.view(panelRequest(req)))));
app.get('/api/config',(_req,res)=>res.json(config));
// Saving the operator configuration replaces config/teams.json atomically and broadcasts it to
// every connected view, so the HUD picks up teams, rosters, maps and the bracket without a restart.
app.put('/api/config',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
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
// Uploaded logos, map pictures, portraits and radar images are replaced freely; anything no longer
// referenced by the saved configuration is deleted so public/uploads/ cannot grow without bound across
// a long tournament. Recent uploads are spared (see server/uploads.ts) because they may be waiting for
// their Save click. Drop-in files under public/radars/ are operator-managed and never pruned.
async function pruneUploads(current:ScoutConfig,radarsConfig:any){
 const referenced=referencedUploads(current,radarsConfig);
 for(const kind of UPLOAD_DIRS){
  const dir=path.join(UPLOAD_ROOT,kind);
  let files:string[]=[];try{files=await readdir(dir)}catch{continue}
  for(const file of files) if(isPrunable(file,referenced,kind)){try{await unlink(path.join(dir,file))}catch{}}
 }
}
app.put('/api/controls',async(req,res)=>{
 // Cross-site and unauthenticated mutations never reach here — the gate above refuses both. This route
 // only validates the switches and saves them.
 if(!sameOrigin(req)){res.sendStatus(403);return}
 const parsed=controlsSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid controls'});return}
 const before=controls.scene;
 try {await saveControls(parsed.data);res.json(controls)}catch{res.status(500).json({error:'Could not save controls'});return}
 // Fire and forget: OBS being slow or absent must never delay the operator's scene change.
 if(controls.scene!==before) void obs.onScoutScene(controls.scene);
});
// Radar calibration + custom images are operator data: the admin panel's Custom radars editor PUTs
// here, the file is replaced atomically, and every output view re-renders with the new radar.
app.put('/api/radars',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
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
 if(!sameOrigin(req)){res.sendStatus(403);return}
 const parsed=layoutSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid layout: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'layout'} ${issue.message}`).slice(0,6).join('; ')});return}
 try {
  await writeFile('config/layout.json.tmp',JSON.stringify(parsed.data,null,2));
  await rename('config/layout.json.tmp','config/layout.json');
  layout=parsed.data;
  broadcast();res.json(layout);
 }catch{res.status(500).json({error:'Could not save layout'})}
});
// OBS integration API. Every mutation is same-origin only, like the rest of the operator API, and none of it can
// return or store the OBS password.
const obsView=()=>({config:obsConfig,status:obs.status()});
app.get('/api/obs',(_req,res)=>res.json(obsView()));
app.put('/api/obs',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 const parsed=obsConfigSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid OBS settings: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'settings'} ${issue.message}`).slice(0,4).join('; ')});return}
 try {
  await writeFile('config/obs.json.tmp',JSON.stringify(parsed.data,null,2));
  await rename('config/obs.json.tmp','config/obs.json');
  obsConfig=parsed.data;obs.configure(obsConfig);broadcast();res.json(obsView());
 }catch{res.status(500).json({error:'Could not save the OBS settings'})}
});
app.post('/api/obs/reconnect',(req,res)=>{if(!sameOrigin(req)){res.sendStatus(403);return}obs.reconnect();res.json(obsView())});
const obsSwitchSchema=z.object({scene:z.string().trim().min(1).max(200)});
app.post('/api/obs/switch',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 const parsed=obsSwitchSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Choose an OBS scene'});return}
 try {await obs.switchScene(parsed.data.scene);res.json({ok:true,...obsView()})}catch(error:any){res.status(502).json({error:error.message})}
});
app.post('/api/obs/refresh-overlay',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 try {res.json({refreshed:await obs.refreshOverlay()})}catch(error:any){res.status(502).json({error:error.message})}
});
if(process.env.NODE_ENV==='production'){app.use(express.static('dist'));app.get('*',(_req,res)=>res.sendFile(path.resolve('dist/index.html')))}else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares)}
app.use((err:any,_req:any,res:any,_next:any)=>{res.status(err.status||500).json({error:err.status===400?'Invalid JSON':'Request failed'})});
server.listen(port,'0.0.0.0',()=>console.log('SCOUT host ready on port '+port+'\n[gsi] expecting CS2 pushes at '+feed.uri+' · token source: '+tokenSource+(tokenSource==='default'?' (built-in CHANGE_ME — set GSI_TOKEN before using a changed cfg token)':'')));
