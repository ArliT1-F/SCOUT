import express from 'express';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {readFile,writeFile,rename,mkdir,readdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {MatchStore,FeedMonitor,type TokenSource} from './state.js';
import {EventTracker} from './events.js';
import {SideTracker,configSides} from './sides.js';
import {seriesState} from './series.js';
import {configSchema,normalizeConfig,type ScoutConfig} from './config.js';
import {layoutSchema,type LayoutConfig} from './layout.js';
import {defaultOverlay,overlaySchema,type OverlayConfig} from './overlay.js';
import {OperatorDirectory} from './operators.js';
import {ControlLease,type LeasePrincipal} from './lease.js';
import {AuditTrail} from './audit.js';
import {GsiRecorder,MatchArchiveStore} from './recordings.js';
import {createEventPack,eventPackSchema,restoreEventPack} from './packs.js';
import {radarsSchema} from './radars.js';
import {UPLOAD_DIRS,referencedUploads,isPrunable} from './uploads.js';
import {controlsSchema,defaultControls,SCENE_IDS,type Controls} from './controls.js';
import {ObsBridge} from './obs.js';
import {obsConfigSchema,defaultObsConfig,planObsToScout,type ObsConfig} from './obs-config.js';
import {PanelAuth,PANEL_COOKIE,cookieValue,originTrusted,requestIsSecure,clearedCookie,panelUrls,hasCapability,type PanelSessionView,type PanelCapability,type Principal,type PanelRole} from './auth.js';
import {appPath} from './runtime.js';
import {hostname} from 'node:os';
import {createBetaService,Installation,ACCOUNT_COOKIE,ACCOUNT_TTL_MS,accountCookie,clearedAccountCookie,DEVICE_POLL_INTERVAL_MS,DEFAULT_DOWNLOAD_URL,DEFAULT_DOWNLOAD_VERSION,type BetaContext,type BetaResult,type BetaRuntime} from './beta.js';
const app=express(), server=createServer(app), store=new MatchStore(), events=new EventTracker(), sides=new SideTracker();
const port=Number(process.env.PORT)||8080;
// ---- Operator access from another machine (server/auth.ts). Reads stay open on purpose: the OBS
// browser source of a second machine has to load /obs and its WebSocket feed with no credentials, and
// so does a wall display. Everything that *changes* the broadcast needs authority: the operator at
// this machine, or a session unlocked with the panel token. With no SCOUT_PANEL_TOKEN the host
// generates one per run and prints it here — the console is the only place it is ever shown.
const panelToken=process.env.SCOUT_PANEL_TOKEN?.trim()||'';
let operatorStore=new OperatorDirectory();
try{operatorStore=new OperatorDirectory(JSON.parse(await readFile('config/operators.json','utf8')))}catch(error:any){if(error?.code!=='ENOENT')console.warn('[operators] config/operators.json is invalid — using an empty operator directory:',error.message)}
const panel=new PanelAuth({
 token:panelToken,operatorTokens:operatorStore.credentials,
 remoteEnabled:process.env.SCOUT_REMOTE?.toLowerCase()!=='off',
 requireLocalToken:process.env.SCOUT_REQUIRE_TOKEN==='1',
 allowedHosts:process.env.SCOUT_ALLOWED_HOSTS,
});
const lease=new ControlLease();
const audit=new AuditTrail('recordings');await audit.load();
const recorder=new GsiRecorder('recordings');await recorder.initialize(process.env.LOG_GSI==='1');
const archives=new MatchArchiveStore('recordings/matches.json');await archives.load();
// ---- Closed beta (server/beta.ts): who may download the launcher, and which installation belongs
// to which website account. Local by default — the host *is* the beta, and applications, invites
// and launcher links live in config/beta/ next to the operator data. Point SCOUT_BETA_API_URL at a
// hosted account service to move all of that off the machine; the /api/beta/* paths stay the same,
// so the panel, the landing page and the launcher need no changes.
const betaDir=process.env.SCOUT_BETA_DIR||'config/beta';
const beta:BetaRuntime=createBetaService({
 dir:betaDir,
 apiUrl:process.env.SCOUT_BETA_API_URL,
 apiKey:process.env.SCOUT_BETA_API_KEY,
 autoApprove:process.env.SCOUT_BETA_AUTO_APPROVE==='1',
 host:hostname(),
 download:{url:process.env.SCOUT_DOWNLOAD_URL||DEFAULT_DOWNLOAD_URL,version:process.env.SCOUT_DOWNLOAD_VERSION||DEFAULT_DOWNLOAD_VERSION,notes:process.env.SCOUT_DOWNLOAD_NOTES||''},
});
if(beta.local) await beta.local.load();
const installation=new Installation(path.join(betaDir,'installation.json'));await installation.load();
const betaContext=(req:express.Request):BetaContext=>({address:req.socket.remoteAddress||'unknown',userAgent:req.get('user-agent')||'',origin:betaOrigin(req),secure:requestIsSecure(req.headers)});
// The origin an invite link or a launcher code points at: the address the operator actually used,
// so the link works on the observer machine and on the phone that approves a launcher.
function betaOrigin(req:express.Request){
 const forwarded=(req.get('x-forwarded-proto')||'').split(',')[0].trim();
 const scheme=forwarded||(requestIsSecure(req.headers)?'https':'http');
 return `${scheme}://${req.get('host')||'localhost:'+port}`;
}
function sendBetaResult<T>(res:express.Response,result:BetaResult<T>,onOk?:(value:T)=>void){
 if(!result.ok){res.status(result.status).json({error:result.message,code:result.code});return}
 (onOk||((value:T)=>res.json(value)))(result.value);
}
const accountCookieId=(req:express.Request)=>cookieValue(req.get('cookie'),ACCOUNT_COOKIE);
// The launcher polls its own code in the background once a link is started, so the panel card flips
// to "linked" without anybody refreshing it. Only one timer runs, and it stops itself on a decision,
// on expiry, or when the pending code is replaced.
let linkPoll:ReturnType<typeof setInterval>|null=null;
function watchInstallationLink(){
 if(linkPoll) return;
 const pending=installation.view().pending;
 if(!pending) return;
 const deviceCode=pending.deviceCode;
 linkPoll=setInterval(()=>{
  void (async()=>{
   const current=installation.view().pending;
   if(!current||current.deviceCode!==deviceCode){if(linkPoll)clearInterval(linkPoll);linkPoll=null;return}
   const poll=await beta.launcher.devicePoll({deviceCode});
   if(!poll.ok) return;
   const state=poll.value.status;
   if(state==='pending') return;
   if(linkPoll)clearInterval(linkPoll);
   linkPoll=null;
   if(state==='approved'&&installation.completeLink(poll.value)){
    await installation.save();
    console.log(`[beta] this installation is now linked to ${installation.view().email}`);
   }else{
    installation.touch();
    await installation.save();
    console.log(`[beta] the launcher code was ${state} — start a new link from the panel when you are ready.`);
   }
   broadcast();
  })();
 },DEVICE_POLL_INTERVAL_MS);
 linkPoll.unref?.();
}
if(panelToken&&panelToken.length<16) console.warn(`[panel] SCOUT_PANEL_TOKEN is only ${panelToken.length} characters — use a long random token when the network is not yours alone.`);
if(panel.tokenSource==='generated') console.log('[panel] No SCOUT_PANEL_TOKEN set, so this run has its own token. Set the variable to keep one token across restarts.');
if(panel.remoteEnabled){
 const nearby=panelUrls(port);
 console.log('[panel] Remote control is ON — open one of these from the other machine. The link carries the token, once:');
 for(const base of nearby.length?nearby:[`http://localhost:${port}`]) console.log(`[panel]   ${base}/?token=${encodeURIComponent(panel.token)}`);
 if(!nearby.length) console.log('[panel]   (no LAN address found — connect to this machine through its own address)');
} else console.log('[panel] Remote control is OFF (SCOUT_REMOTE=off): only a request from this machine can change the broadcast.');
// The token source is reported in status. The value appears once in the intentional startup unlock link,
// but is not persisted or repeated in request and audit logs.
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
// Overlay Studio state is versioned independently from the legacy position-only layout, so saved
// themes, layers and custom graphics can evolve without breaking older layout.json files.
let overlay:OverlayConfig=defaultOverlay();
try{overlay=overlaySchema.parse(JSON.parse(await readFile('config/overlay.json','utf8')))}catch(error:any){if(error?.code!=='ENOENT')console.warn('[overlay] config/overlay.json is invalid — using the production defaults:',error.message)}
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
 overlay:{dir:'overlays',exts:IMAGE_EXTS},
};
for(const dir of UPLOAD_DIRS) await mkdir(path.join(UPLOAD_ROOT,dir),{recursive:true});
// ---- The gate in front of every mutation. It is deliberately path/method based rather than a list of
// routes: a route added later is protected by construction, whichever operator feature it belongs to.
// POST /gsi is CS2's own feed and authenticates with the GSI token inside its body, and POST/DELETE
// /api/session is the way in and the way out.
const PUBLIC_BETA_PATHS=new Set([
 '/api/beta/apply','/api/beta/login','/api/beta/logout','/api/beta/activate',
 '/api/beta/device/start','/api/beta/device/poll','/api/beta/device/approve','/api/beta/device/deny',
 '/api/beta/devices/revoke',
]);
function isProtected(req:express.Request){
 if(!req.path.startsWith('/api/')) return false;
 if(req.method==='GET'||req.method==='HEAD'||req.method==='OPTIONS') return false;
 if(req.path==='/api/session') return false;
 // The closed beta's public doors (server/beta.ts). An applicant has no panel authority by
 // definition, and an account session is its own credential — on a hosted deployment there is no
 // panel session at all. These routes carry their own same-origin check and their own throttles.
 // Everything else under /api/beta (the owner's application list, the launcher link) stays behind
 // the panel gate like every other mutation.
 return !PUBLIC_BETA_PATHS.has(req.path);
}
// Same-origin as well as token: a browser page on another site must not be able to drive the panel,
// and a name the operator listed (a proxy that rewrites Host) is treated as the operator's own.
function sameOrigin(req:express.Request){return originTrusted(req.get('origin'),req.get('host'),panel.allowedHosts)}
function panelRequest(req:express.Request){return {address:req.socket.remoteAddress,host:req.get('host'),cookie:req.get('cookie'),headers:req.headers}}
function privateRead(req:express.Request,res:express.Response,capability:PanelCapability){
 if(!sameOrigin(req)){res.status(403).json({error:'Cross-site operator requests are refused.',code:'untrusted-origin'});return false}
 const decision=panel.authorize(panelRequest(req));
 if(!decision.ok){res.status(decision.status).json({error:decision.message,code:decision.code});return false}
 res.locals.access=decision;return permit(res,capability);
}
app.use((req:express.Request,res:express.Response,next:express.NextFunction)=>{
 if(!isProtected(req)) return next();
 if(!sameOrigin(req)){res.status(403).json({error:'Cross-site operator requests are refused. Open the panel itself.'});return}
 const decision=panel.authorize(panelRequest(req));
 if(decision.ok){res.locals.access=decision;return next()}
 res.status(decision.status).json({error:decision.message,code:decision.code,attemptsLeft:decision.attemptsLeft});
});
function accessPrincipal(res:express.Response):Principal{return res.locals.access?.principal||{id:'system',name:'SCOUT system',role:'owner'}};
function permit(res:express.Response,capability:PanelCapability){
 const principal=accessPrincipal(res);
 if(hasCapability(principal.role,capability))return true;
 res.status(403).json({error:`${capability} permission is required. Your role is ${principal.role}.`,code:'insufficient-role',capability,role:principal.role});return false;
}
function ownerOnly(res:express.Response){
 if(accessPrincipal(res).role==='owner')return true;
 res.status(403).json({error:'Owner access is required for this operation.',code:'insufficient-role',role:accessPrincipal(res).role});return false;
}
function leaseControl(req:express.Request,res:express.Response,force=false){
 const principal=accessPrincipal(res);const result=lease.claim(principal,force);
 if(!result.ok){res.status(result.code==='control-role-required'?403:423).json({error:result.error,code:result.code,lease:result.lease});return false}
 audit.record(principal,'control.lease.claim',force?'owner takeover':'broadcast control claimed');
 broadcast();return true;
}
function requireControl(req:express.Request,res:express.Response){
 const principal=accessPrincipal(res);const result=lease.renew(principal);
 if(!result.ok){res.status(result.code==='control-role-required'?403:423).json({error:result.error,code:result.code,lease:result.lease});return false}
 return true;
}
function releaseControl(req:express.Request,res:express.Response,force=false){
 const principal=accessPrincipal(res);const result=lease.release(principal,force);
 if(!result.ok){res.status(423).json({error:result.error,code:result.code,lease:result.lease});return false}
 audit.record(principal,'control.lease.release',force?'owner released active controller':'broadcast control released');broadcast();res.json({lease:result.lease});return true;
}
async function saveOperatorDirectory(){
 await mkdir('config',{recursive:true});await writeFile('config/operators.json.tmp',operatorStore.serialize());await rename('config/operators.json.tmp','config/operators.json');panel.setOperatorTokens(operatorStore.credentials);
}
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
const uploadSchema=z.object({kind:z.enum(['logo','map','radar','player','overlay']),name:z.string().trim().max(120).optional().default(''),data:z.string().max(14*1024*1024)});
app.post('/api/upload',express.json({limit:'12mb'}),async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'design'))return;
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
 audit.record(accessPrincipal(res),'asset.upload',`uploads/${spec.dir}/${file} · ${buffer.length} bytes`);
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
// Event packs include locally uploaded, validated artwork; only this route gets a larger parser.
app.use('/api/pack/import',express.json({limit:'70mb'}));
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
function snapshot(session?:PanelSessionView){const active=archives.active;return {state:store.state,lastSeen:store.lastSeen,revision:store.revision,serverTime:Date.now(),config,controls,layout,overlay,lease:lease.view(session?.principalId||undefined),recording:recorder.status,archive:active?{id:active.id,name:active.name,startedAt:active.startedAt,eventCount:active.events.length}:null,gsi:feed.snapshot(),events:events.snapshot(),sides:store.revision?sides.resolve(store.state,config):configSides(config),series:seriesState(store.state,config),radars,obs:{config:obsConfig,status:obs.status()},...(session?{session}:{})}}
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
 audit.record(attempt.session.principal,'session.unlock',`${attempt.session.address} · ${attempt.session.principal.role}`);
 res.setHeader('Set-Cookie',attempt.cookie);
 res.json(panel.view({...panelRequest(req),headers:{},cookie:`${PANEL_COOKIE}=${attempt.session.id}`}));
});
app.delete('/api/session',(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 const current=panel.view(panelRequest(req));
 if(current.principalId&&current.role){const principal={id:current.principalId,name:current.operator,role:current.role};if(current.role==='owner')lease.release(principal);audit.record(principal,'session.logout',`${current.address} · ${current.via||'session'}`)}
 if(panel.logout(cookieValue(req.get('cookie'),PANEL_COOKIE))) console.log(`[panel] a remote session ended — ${panel.sessionCount} active`);
 res.setHeader('Set-Cookie',clearedCookie(requestIsSecure(req.headers)));
 res.json(panel.view({...panelRequest(req),headers:{},cookie:''}));
});
// ---- Closed beta (server/beta.ts): accounts, applications and the launcher link. The launcher
// half is always this host's own concern; the site half is served here in local mode and proxied to
// SCOUT_BETA_API_URL in hosted mode (the proxy sits at the end of this file), so every path the
// landing page, the login page and the dashboard use is identical in both.
const linkStartSchema=z.object({label:z.string().trim().max(60).optional().default('')}).strip();
app.post('/api/beta/link/start',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!ownerOnly(res))return;
 const current=installation.view();
 if(current.linked){res.status(409).json({error:`This installation is already linked to ${current.email}. Unlink it first to move it to another account.`,code:'already-linked'});return}
 const parsed=linkStartSchema.safeParse(req.body||{});
 const started=await beta.launcher.deviceStart({label:parsed.success&&parsed.data.label?parsed.data.label:hostname(),platform:process.platform},betaContext(req));
 sendBetaResult(res,started,async value=>{
  installation.beginLink(value);
  await installation.save();
  watchInstallationLink();
  console.log(`[beta] launcher link started — approve ${value.userCode} while signed in at ${value.verificationUrl}`);
  res.json({link:installation.view(),code:value.userCode,expiresAt:value.expiresAt,verificationUrl:value.verificationUrl,interval:value.interval});
 });
});
app.post('/api/beta/link/unlink',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!ownerOnly(res))return;
 const view=installation.view();
 installation.unlink();
 await installation.save();
 if(linkPoll){clearInterval(linkPoll);linkPoll=null}
 audit.record(accessPrincipal(res),'beta.installation.unlink',view.email||view.installationId);
 res.json({link:installation.view()});
});
// What the panel card and an installer script read. This is the machine's own link state, so it
// needs a panel session — but no particular capability: a producer may look, only an owner links.
app.get('/api/beta/link',(req,res)=>{
 const decision=panel.authorize(panelRequest(req));
 if(!decision.ok){res.status(decision.status).json({error:decision.message,code:decision.code});return}
 res.json({mode:beta.mode,link:installation.view()});
});
// The owner's side of the applications. Approving mints the one-time invite link, which is printed
// here exactly like the panel token is: this host may have no mail server, so the console (and the
// response) is how the operator hands it over. The invite value is never written to the audit trail.
app.get('/api/beta/applications',(req,res)=>{
 if(!privateRead(req,res,'view-audit'))return;
 void beta.launcher.applications().then(applications=>res.json({mode:beta.mode,applications,link:installation.view(),download:{url:process.env.SCOUT_DOWNLOAD_URL||DEFAULT_DOWNLOAD_URL,version:process.env.SCOUT_DOWNLOAD_VERSION||DEFAULT_DOWNLOAD_VERSION}}));
});
app.post('/api/beta/applications/:id',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!ownerOnly(res))return;
 const decision=req.body?.decision==='approve'?'approve':req.body?.decision==='reject'?'reject':null;
 if(!decision){res.status(400).json({error:'Choose approve or reject.',code:'invalid-decision'});return}
 const result=await beta.launcher.decide(String(req.params.id),decision,accessPrincipal(res).name);
 sendBetaResult(res,result,value=>{
  const inviteUrl=value.invite?`${betaOrigin(req)}/login?invite=${encodeURIComponent(value.invite)}`:null;
  audit.record(accessPrincipal(res),`beta.application.${decision}`,value.account.email);
  if(inviteUrl) console.log(`[beta] approved ${value.account.email} — send them this one-time invite link:\n[beta]   ${inviteUrl}`);
  res.json({application:value.account,inviteUrl});
 });
});
if(beta.site){
 const site=beta.site,local=beta.local!;
 const applicationSchema=z.object({name:z.string().trim().min(2).max(80),email:z.string().trim().min(5).max(160),
  organisation:z.string().trim().max(120).optional().default(''),country:z.string().trim().max(60).optional().default(''),
  useCase:z.string().trim().max(600).optional().default(''),events:z.string().trim().max(80).optional().default('')});
 const credentialsSchema=z.object({email:z.string().trim().min(5).max(160),password:z.string().min(1).max(200)}).strip();
 const activateSchema=z.object({invite:z.string().trim().min(10).max(200),password:z.string().min(1).max(200)}).strip();
 const raiseSchema=z.object({userCode:z.string().trim().min(4).max(16)}).strip();
 const deviceStartSchema=z.object({deviceCode:z.string().trim().min(10).max(200)}).strip();
 const notify=(req:express.Request,value:{account:{email:string;organisation:string};invite:string|null})=>{
  if(value.invite) console.log(`[beta] ${value.account.email} was approved on the spot (SCOUT_BETA_AUTO_APPROVE=1) — invite link:\n[beta]   ${betaOrigin(req)}/login?invite=${encodeURIComponent(value.invite)}`);
  else console.log(`[beta] application from ${value.account.email} (${value.account.organisation||'no organisation'}) is waiting for review — approve it in the panel, or with POST /api/beta/applications/:id`);
 };
 app.get('/api/beta/status',async(req,res)=>res.json(await site.status(accountCookieId(req))));
 app.post('/api/beta/apply',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const parsed=applicationSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Tell us your name and an email address we can reach you at.',code:'invalid-application'});return}
  const result=await site.apply(parsed.data,betaContext(req));
  sendBetaResult(res,result,value=>{
   notify(req,value);
   res.json({application:value.account,inviteUrl:value.invite?`${betaOrigin(req)}/login?invite=${encodeURIComponent(value.invite)}`:null});
  });
 });
 app.post('/api/beta/login',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const parsed=credentialsSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Enter the email address and password of your SCOUT account.',code:'invalid-credentials'});return}
  const result=await site.signIn(parsed.data,betaContext(req));
  sendBetaResult(res,result,value=>{
   res.setHeader('Set-Cookie',accountCookie(value.cookieId,ACCOUNT_TTL_MS,requestIsSecure(req.headers)));
   res.json({account:value.account});
  });
 });
 app.post('/api/beta/logout',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  await site.signOut(accountCookieId(req));
  res.setHeader('Set-Cookie',clearedAccountCookie(requestIsSecure(req.headers)));
  res.json({ok:true});
 });
 // An invite link is the only way a password is ever set, so the applicant chooses it in their own
 // browser — the operator never sees it, and the invite stops working the moment it is used.
 app.post('/api/beta/activate',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const parsed=activateSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:`Choose a password of at least 10 characters.`,code:'invalid-invite'});return}
  const result=await site.activate(parsed.data,betaContext(req));
  sendBetaResult(res,result,value=>{
   console.log(`[beta] ${value.account.email} activated their account and set a password`);
   res.setHeader('Set-Cookie',accountCookie(value.cookieId,ACCOUNT_TTL_MS,requestIsSecure(req.headers)));
   res.json({account:value.account});
  });
 });
 // Launcher side of the device flow: the installer shows a code (start), then waits (poll) until the
 // account owner approves it in a browser. Both are rate limited in server/beta.ts.
 app.post('/api/beta/device/start',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const parsed=linkStartSchema.safeParse(req.body||{});
  sendBetaResult(res,await beta.launcher.deviceStart({label:parsed.success&&parsed.data.label?parsed.data.label:hostname(),platform:parsed.success?String((req.body||{}).platform||process.platform):process.platform},betaContext(req)));
 });
 app.post('/api/beta/device/poll',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const parsed=deviceStartSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Send the device code the launcher was given.',code:'invalid-code'});return}
  sendBetaResult(res,await beta.launcher.devicePoll(parsed.data));
 });
 app.post('/api/beta/device/approve',async(req,res)=>deviceDecision(req,res,true));
 app.post('/api/beta/device/deny',async(req,res)=>deviceDecision(req,res,false));
 async function deviceDecision(req:express.Request,res:express.Response,approve:boolean){
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const parsed=raiseSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:'Enter the code shown in the launcher window.',code:'invalid-code'});return}
  const result=await local.deviceDecide(accountCookieId(req),parsed.data.userCode,approve);
  sendBetaResult(res,result,value=>{
   if(approve) console.log(`[beta] ${value.account.email} linked a launcher`);
   res.json({account:value.account});
  });
 }
 app.post('/api/beta/devices/revoke',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  const deviceId=typeof req.body?.deviceId==='string'?req.body.deviceId.trim():'';
  if(!deviceId){res.status(400).json({error:'Choose the launcher to unlink.',code:'invalid-device'});return}
  const result=await local.revokeDevice(accountCookieId(req),deviceId);
  sendBetaResult(res,result,value=>{
   console.log(`[beta] ${value.account.email} unlinked a launcher`);
   res.json({account:value.account});
  });
 });
 console.log(`[beta] Closed beta accounts are stored in ${betaDir}/store.json (local mode). Approve an application in the panel, or set SCOUT_BETA_API_URL to use a hosted account service.`);
}else{
 // Hosted accounts: the browser's requests go upstream unchanged — same path, same cookie, same
 // body — so the landing page, the panel and the launcher all see one account service. Nothing is
 // cached or rewritten on the way; an unreachable service is reported as exactly that.
 const upstream=(process.env.SCOUT_BETA_API_URL||'').replace(/\/$/,'');
 app.use('/api/beta',async(req,res)=>{
  if(!sameOrigin(req)){res.sendStatus(403);return}
  try{
   const response=await fetch(upstream+req.originalUrl.replace(/^\/api\/beta/,''),{
    method:req.method,
    headers:{'Content-Type':'application/json',...(req.get('cookie')?{Cookie:req.get('cookie') as string}:{}),...(process.env.SCOUT_BETA_API_KEY?{Authorization:`Bearer ${process.env.SCOUT_BETA_API_KEY}`}:{})},
    body:req.method==='GET'||req.method==='HEAD'?undefined:JSON.stringify(req.body??{}),
   });
   const text=await response.text();
   const cookies=typeof response.headers.getSetCookie==='function'?response.headers.getSetCookie():[];
   if(cookies.length) res.setHeader('Set-Cookie',cookies);
   res.status(response.status).type(response.headers.get('content-type')||'application/json').send(text);
  }catch(error:any){
   res.status(503).json({error:`The SCOUT account service could not be reached (${error?.message||'network error'}).`,code:'upstream-unreachable'});
  }
 });
 console.log(`[beta] Closed beta accounts are served by ${upstream||'(no SCOUT_BETA_API_URL set)'} — the host proxies /api/beta to it.`);
}
const operatorInput=z.object({label:z.string().trim().min(1).max(64),role:z.enum(['producer','designer','viewer'])}).strip();
app.get('/api/operators',(req,res)=>{
 if(!privateRead(req,res,'manage-operators'))return;
 res.json({operators:operatorStore.list(),sessions:panel.activeSessions()});
});
app.post('/api/operators',async(req,res)=>{
 if(!permit(res,'manage-operators'))return;
 const parsed=operatorInput.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Provide an operator name and role (producer, designer, or viewer).'});return}
 try{const created=operatorStore.issue(parsed.data);await saveOperatorDirectory();audit.record(accessPrincipal(res),'operators.issue',`${created.operator.label} · ${created.operator.role}`);res.json(created)}catch(error:any){res.status(400).json({error:error.message||'Could not issue operator access'})}
});
app.delete('/api/operators/:id',async(req,res)=>{
 if(!permit(res,'manage-operators'))return;
 const id=String(req.params.id||'');if(!operatorStore.revoke(id)){res.status(404).json({error:'Active operator not found'});return}
 try{await saveOperatorDirectory();audit.record(accessPrincipal(res),'operators.revoke',id);res.json({ok:true,operators:operatorStore.list()})}catch{res.status(500).json({error:'Could not persist operator revocation'})}
});
app.get('/api/lease',(req,res)=>{
 const current=panel.view(panelRequest(req));res.json({lease:lease.view(current.principalId||undefined)});
});
app.post('/api/lease',(req,res)=>{
 if(!permit(res,'control'))return;
 const parsed=z.object({force:z.boolean().optional().default(false)}).safeParse(req.body||{});if(!parsed.success){res.status(400).json({error:'Invalid lease request'});return}
 if(parsed.data.force&&accessPrincipal(res).role!=='owner'){res.status(403).json({error:'Only an owner can take over an active control lease.',code:'insufficient-role'});return}
 if(!leaseControl(req,res,parsed.data.force))return;res.json({lease:lease.view(accessPrincipal(res).id)});
});
app.delete('/api/lease',(req,res)=>{
 if(!permit(res,'control'))return;
 const force=req.query.force==='1';if(force&&accessPrincipal(res).role!=='owner'){res.status(403).json({error:'Only an owner can release another operator’s lease.',code:'insufficient-role'});return}
 releaseControl(req,res,force);
});
app.get('/api/audit',(req,res)=>{
 if(!privateRead(req,res,'view-audit'))return;
 const count=Math.min(1000,Math.max(1,Number(req.query.limit)||200));res.json({entries:audit.list(count)});
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
 recorder.write(Date.now(),payload);
 const ingested=store.ingest(payload);
 // Recovered subtrees are normal (CS2 empties fields between rounds), so they are counted and logged
 // at most once per 10 s instead of once per packet.
 if(ingested){const derived=events.observe(store.state,Date.now(),ingested.reset);
  for(const kill of derived.kills){archives.addKill(kill);console.log(`[events] round ${kill.round+1}: ${kill.killerName||'unknown'} killed ${kill.victimName}${kill.headshot?' (headshot)':''}`)}
  if(derived.ended){archives.addRound(derived.ended);console.log(`[events] round ${derived.ended.round+1} won by ${derived.ended.winner||'unknown'} (${derived.ended.reason}) — ${derived.ended.ctScore}:${derived.ended.tScore}`)}
  const issues=feed.issues(ingested.issues); if(issues.log) console.warn(`[gsi] repaired ${issues.count} invalid field${issues.count===1?'':'s'} (${feed.subtreeIssues} total) — last: ${issues.last.path} ${issues.last.reason}`)}
 else if(feed.late().log) console.warn(`[gsi] ignoring a packet older than the current state (${feed.rejectedLate} ignored). Expected while replaying a recording against a warm host, or when a second observer pushes with an older clock.`);
 res.sendStatus(200); broadcast();
});
app.get('/api/status',(req,res)=>res.json(snapshot(panel.view(panelRequest(req)))));
app.get('/api/pack/export',async(req,res)=>{
 if(!privateRead(req,res,'design'))return;
 try{const pack=await createEventPack(config,radars,layout,overlay,UPLOAD_ROOT);const slug=(config.event.name||'SCOUT-event').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'scout-event';audit.record(accessPrincipal(res),'event-pack.export',`${slug} · ${pack.assets.length} assets`);res.setHeader('Content-Disposition',`attachment; filename="${slug}.scoutpack.json"`);res.json(pack)}catch(error:any){res.status(500).json({error:error.message||'Could not build event pack'})}
});
app.post('/api/pack/import',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'design'))return;
 const checked=eventPackSchema.safeParse(req.body);if(!checked.success){res.status(400).json({error:'Invalid event pack: '+checked.error.issues.slice(0,6).map(issue=>`${issue.path.join('.')||'pack'} ${issue.message}`).join('; ')});return}
 try{
  const restored=await restoreEventPack(checked.data,UPLOAD_ROOT);
  const files:[string,unknown][]=[['config/teams.json',restored.config],['config/radars.json',restored.radars],['config/layout.json',restored.layout],['config/overlay.json',restored.overlay]];
  for(const [file,value] of files)await writeFile(file+'.tmp',JSON.stringify(value,null,2));
  for(const [file] of files)await rename(file+'.tmp',file);
  config=restored.config;radars=restored.radars;layout=restored.layout;overlay=restored.overlay;
  await pruneUploads(config,radars,overlay);audit.record(accessPrincipal(res),'event-pack.import',`${config.event.name||'event'} · ${restored.assets} assets`);broadcast();res.json({ok:true,assets:restored.assets,assetBytes:restored.assetBytes,config,radars,layout,overlay});
 }catch(error:any){res.status(400).json({error:error.message||'Could not import event pack'})}
});
app.get('/api/recordings',async(_req,res)=>res.json({files:await recorder.list(),status:recorder.status}));
app.get('/api/recordings/:name',async(req,res)=>{
 try{const body=await recorder.read(String(req.params.name));res.type('text/plain').send(body)}catch(error:any){res.status(error.code==='ENOENT'?404:400).json({error:error.message||'Could not read recording'})}
});
app.post('/api/recordings',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 const parsed=z.object({enabled:z.boolean()}).safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Choose whether GSI recording is enabled.'});return}
 try{const status=await recorder.setEnabled(parsed.data.enabled);audit.record(accessPrincipal(res),status.enabled?'recording.start':'recording.stop',status.file||'');broadcast();res.json({status,files:await recorder.list()})}catch(error:any){res.status(500).json({error:error.message||'Could not change recording state'})}
});
app.get('/api/archive',(_req,res)=>res.json({archives:archives.list(),active:archives.active?.id||null}));
app.get('/api/archive/:id',(req,res)=>{const item=archives.detail(String(req.params.id));if(!item){res.status(404).json({error:'Match archive not found'});return}res.json(item)});
app.post('/api/archive/start',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 const parsed=z.object({name:z.string().trim().max(100).optional().default('')}).safeParse(req.body||{});if(!parsed.success){res.status(400).json({error:'Match name is too long.'});return}
 try{const item=archives.start(parsed.data.name,config);audit.record(accessPrincipal(res),'archive.start',item.name);broadcast();res.json(item)}catch(error:any){res.status(409).json({error:error.message||'Could not start match archive'})}
});
app.post('/api/archive/finish',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 const item=archives.finish();if(!item){res.status(409).json({error:'No match archive is active.'});return}
 await archives.flush();audit.record(accessPrincipal(res),'archive.finish',item.name);broadcast();res.json(item);
});
app.get('/api/remote/state',(req,res)=>{if(!privateRead(req,res,'control'))return;const principal=accessPrincipal(res),currentLease=lease.view(principal.id);res.json({controls,lease:currentLease,canControl:!currentLease.holder||currentLease.mine,recording:recorder.status,archive:archives.active?{id:archives.active.id,name:archives.active.name,eventCount:archives.active.events.length}:null,scenes:SCENE_IDS,serverTime:Date.now()})});
const remoteActionSchema=z.object({action:z.string().trim().min(1).max(80),minutes:z.number().int().min(1).max(600).optional()}).strip();
app.post('/api/remote/action',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 const parsed=remoteActionSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid remote action'});return}
 const action=parsed.data.action;let patch:Partial<Controls>|undefined;
 if(action.startsWith('scene:')&&SCENE_IDS.includes(action.slice(6) as any))patch={scene:action.slice(6) as Controls['scene']};
 else if(action.startsWith('toggle:')&&['radar','killfeed','lowerThird','economy','techPause','swapped'].includes(action.slice(7))){const key=action.slice(7) as keyof Controls;patch={[key]:!controls[key]} as Partial<Controls>}
 else if(action==='break.start')patch={scene:'break',breakEndsAt:Date.now()+(parsed.data.minutes||5)*60_000};
 else if(action==='break.stop')patch={scene:controls.scene==='break'?'live':controls.scene,breakEndsAt:null};
 else{res.status(400).json({error:'Unsupported action. Use scene:<id>, toggle:<control>, break.start, or break.stop.'});return}
 const before=controls.scene;await saveControls({...controls,...patch});audit.record(accessPrincipal(res),'remote.action',action);if(controls.scene!==before)void obs.onScoutScene(controls.scene);res.json({ok:true,controls,lease:lease.view(accessPrincipal(res).id)});
});
app.get('/api/config',(_req,res)=>res.json(config));
// Saving the operator configuration replaces config/teams.json atomically and broadcasts it to
// every connected view, so the HUD picks up teams, rosters, maps and the bracket without a restart.
app.put('/api/config',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'match-edit'))return;
 const parsed=configSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid configuration: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'config'} ${issue.message}`).slice(0,6).join('; ')});return}
 const next=normalizeConfig(parsed.data);
 try {
  await writeFile('config/teams.json.tmp',JSON.stringify(next,null,2));
  await rename('config/teams.json.tmp','config/teams.json');
  config=next;
  await pruneUploads(next,radars);
  audit.record(accessPrincipal(res),'match.config.update',`${config.teams.map(team=>team.name).join(' vs ')} · ${config.maps.length} maps`);
  broadcast();res.json(config);
 }catch{res.status(500).json({error:'Could not save configuration'})}
});
// Uploaded logos, map pictures, portraits and radar images are replaced freely; anything no longer
// referenced by the saved configuration is deleted so public/uploads/ cannot grow without bound across
// a long tournament. Recent uploads are spared (see server/uploads.ts) because they may be waiting for
// their Save click. Drop-in files under public/radars/ are operator-managed and never pruned.
async function pruneUploads(current:ScoutConfig,radarsConfig:any,overlayConfig:OverlayConfig=overlay){
 const referenced=referencedUploads(current,radarsConfig,overlayConfig);
 for(const kind of UPLOAD_DIRS){
  const dir=path.join(UPLOAD_ROOT,kind);
  let files:string[]=[];try{files=await readdir(dir)}catch{continue}
  for(const file of files) if(isPrunable(file,referenced,kind)){try{await unlink(path.join(dir,file))}catch{}}
 }
}
app.put('/api/controls',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 const parsed=controlsSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Invalid controls'});return}
 const before=controls.scene;
 try {await saveControls(parsed.data);audit.record(accessPrincipal(res),'controls.update',`${before} → ${parsed.data.scene}`);res.json(controls)}catch{res.status(500).json({error:'Could not save controls'});return}
 // Fire and forget: OBS being slow or absent must never delay the operator's scene change.
 if(controls.scene!==before) void obs.onScoutScene(controls.scene);
});
// Radar calibration + custom images are operator data: the admin panel's Custom radars editor PUTs
// here, the file is replaced atomically, and every output view re-renders with the new radar.
app.put('/api/radars',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'design'))return;
 const parsed=radarsSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid radar configuration: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'radars'} ${issue.message}`).slice(0,6).join('; ')});return}
 const next=parsed.data;
 try {
  await writeFile('config/radars.json.tmp',JSON.stringify(next,null,2));
  await rename('config/radars.json.tmp','config/radars.json');
  radars=next;
  await pruneUploads(config,next);
  audit.record(accessPrincipal(res),'radars.update',`${Object.keys(radars.maps).length} calibrated maps`);
  broadcast();res.json(radars);
 }catch{res.status(500).json({error:'Could not save radar configuration'})}
});
// Overlay element positions from the admin's Arrange mode. Saved as top-left coordinates on the
// 1920×1080 canvas; an empty elements map is the shipped CSS default layout.
app.put('/api/layout',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'design'))return;
 const parsed=layoutSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid layout: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'layout'} ${issue.message}`).slice(0,6).join('; ')});return}
 try {
  await writeFile('config/layout.json.tmp',JSON.stringify(parsed.data,null,2));
  await rename('config/layout.json.tmp','config/layout.json');
  layout=parsed.data;audit.record(accessPrincipal(res),'layout.update','legacy position layout');
  broadcast();res.json(layout);
 }catch{res.status(500).json({error:'Could not save layout'})}
});
app.get('/api/overlay',(_req,res)=>res.json(overlay));
app.put('/api/overlay',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'design'))return;
 const parsed=overlaySchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid overlay studio configuration: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'overlay'} ${issue.message}`).slice(0,8).join('; ')});return}
 try{
  await writeFile('config/overlay.json.tmp',JSON.stringify(parsed.data,null,2));
  await rename('config/overlay.json.tmp','config/overlay.json');
  overlay=parsed.data;await pruneUploads(config,radars,overlay);
  audit.record(accessPrincipal(res),'overlay.update',`${overlay.widgets.length} layers · ${overlay.theme.name}`);
  broadcast();res.json(overlay);
 }catch{res.status(500).json({error:'Could not save overlay studio configuration'})}
});
// OBS integration API. Every mutation is same-origin only, like the rest of the operator API, and none of it can
// return or store the OBS password.
const obsView=()=>({config:obsConfig,status:obs.status()});
app.get('/api/obs',(_req,res)=>res.json(obsView()));
app.put('/api/obs',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!ownerOnly(res))return;
 const parsed=obsConfigSchema.safeParse(req.body);
 if(!parsed.success){res.status(400).json({error:'Invalid OBS settings: '+parsed.error.issues.map(issue=>`${issue.path.join('.')||'settings'} ${issue.message}`).slice(0,4).join('; ')});return}
 try {
  await writeFile('config/obs.json.tmp',JSON.stringify(parsed.data,null,2));
  await rename('config/obs.json.tmp','config/obs.json');
  obsConfig=parsed.data;obs.configure(obsConfig);audit.record(accessPrincipal(res),'obs.settings.update',`${obsConfig.enabled?'enabled':'disabled'} · ${Object.values(obsConfig.sceneMap).filter(Boolean).length} scene mappings`);broadcast();res.json(obsView());
 }catch{res.status(500).json({error:'Could not save the OBS settings'})}
});
app.post('/api/obs/reconnect',(req,res)=>{if(!sameOrigin(req)){res.sendStatus(403);return}if(!ownerOnly(res))return;obs.reconnect();audit.record(accessPrincipal(res),'obs.reconnect');res.json(obsView())});
const obsSwitchSchema=z.object({scene:z.string().trim().min(1).max(200)});
app.post('/api/obs/switch',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 const parsed=obsSwitchSchema.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'Choose an OBS scene'});return}
 try {await obs.switchScene(parsed.data.scene);audit.record(accessPrincipal(res),'obs.scene.switch',parsed.data.scene);res.json({ok:true,...obsView()})}catch(error:any){res.status(502).json({error:error.message})}
});
app.post('/api/obs/refresh-overlay',async(req,res)=>{
 if(!sameOrigin(req)){res.sendStatus(403);return}
 if(!permit(res,'control')||!requireControl(req,res))return;
 try {const refreshed=await obs.refreshOverlay();audit.record(accessPrincipal(res),'obs.overlay.refresh',refreshed.join(', '));res.json({refreshed})}catch(error:any){res.status(502).json({error:error.message})}
});
if(process.env.NODE_ENV==='production'){app.use(express.static(appPath('dist')));app.get('*',(_req,res)=>res.sendFile(appPath('dist','index.html')))}else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares)}
app.use((err:any,_req:any,res:any,_next:any)=>{res.status(err.status||500).json({error:err.status===400?'Invalid JSON':'Request failed'})});
// A packaged install starts the host from a launcher (installer/README.md). Recording the process id
// lets scout-stop.cmd - and the uninstaller - stop this host instead of guessing among node
// processes; the value is only ever used after checking it is really a node.exe. A checkout never
// sets the variable, so nothing is written next to the sources.
if(process.env.SCOUT_PID_FILE) await writeFile(process.env.SCOUT_PID_FILE,String(process.pid)).catch(()=>{});
server.listen(port,'0.0.0.0',()=>console.log('SCOUT host ready on port '+port+'\n[gsi] expecting CS2 pushes at '+feed.uri+' · token source: '+tokenSource+(tokenSource==='default'?' (built-in CHANGE_ME — set GSI_TOKEN before using a changed cfg token)':'')));
