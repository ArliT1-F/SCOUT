import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
// The closed beta: who may download the launcher, and which installation belongs to whom.
//
// SCOUT is a local-first program — the host runs on the observer's machine and the overlay is a
// public artifact — so the *only* thing that needs an account is distribution: applications,
// approval, the download, and the link between a website profile and one Windows installation.
// That is why this module is small and separable: everything the website needs is behind
// `BetaService`, and the host can serve it two ways.
//
//   local  (default)  `config/beta/store.json` — the host is the whole beta. This is what makes
//                     the flow work today, on one machine, with no cloud account of any kind.
//   hosted            `SCOUT_BETA_API_URL` — the same REST contract served by a real backend
//                     (accounts, email, database, hosting). The host proxies the site's calls to
//                     it, so the panel, the landing page and the launcher all keep the same
//                     `/api/beta/*` paths, and moving to production is one environment variable.
//
// What is deliberately *not* here: sending email. Local mode hands the operator the invite link on
// the console, exactly like the panel token, because a host with no mail server must still be able
// to approve somebody. A hosted deployment adds SMTP behind the same `/applications/:id` decision.
//
// Secrets are stored as digests (SHA-256 or scrypt), never as values: not passwords, not session
// ids, not invite tokens, not installation tokens. The one exception is the installation token the
// launcher itself must present, kept in its own 0600 file next to the operator data.
export const ACCOUNT_COOKIE='scout_account';
export const ACCOUNT_TTL_MS=30*24*60*60*1000;
export const DEVICE_CODE_TTL_MS=10*60*1000;
export const DEVICE_POLL_INTERVAL_MS=5000;
export const MAX_APPLICATIONS_PER_HOUR=3;
export const MAX_LOGIN_FAILURES=8;
export const LOGIN_FAILURE_WINDOW_MS=15*60*1000;
// Printed on the dashboard and used by the download card. The installer publishes exactly this
// asset name (`npm run package:windows`), so a GitHub release is a complete download story.
export const DEFAULT_DOWNLOAD_URL='https://github.com/ArliT1-F/SCOUT/releases/latest';
export const DEFAULT_DOWNLOAD_VERSION='SCOUT-Setup-0.1.0.exe';
// Crockford-ish alphabet: no 0/O/1/I/L, so a code read off the launcher window and typed into a
// browser cannot be mistyped into a different valid-looking code.
const USER_CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH=8;
export type ApplicationStatus='pending'|'approved'|'rejected';
export type BetaMode='local'|'hosted';
export interface AccountSecret {salt:string;digest:string}
export interface BetaDevice {id:string;label:string;platform:string;createdAt:number;lastSeenAt:number;revokedAt:number|null;tokenDigest:string}
export interface BetaAccount {
 id:string;email:string;displayName:string;organisation:string;country:string;useCase:string;events:string;
 status:ApplicationStatus;createdAt:number;decidedAt:number|null;decidedBy:string;
 password:AccountSecret|null;invite:{digest:string;expiresAt:number}|null;devices:BetaDevice[];
}
export interface BetaSession {id:string;accountId:string;createdAt:number;lastSeenAt:number;address:string;userAgent:string}
export interface BetaGrant {
 // `deviceCode` is the digest of the code the launcher holds, exactly like every other secret here:
 // the launcher polls with the value, and this host compares digests to find the grant.
 userCode:string;deviceCode:string;label:string;platform:string;createdAt:number;expiresAt:number;
 status:'pending'|'approved'|'denied';accountId:string|null;deviceId:string|null;installationToken:string|null;
}
export interface BetaStore {version:1;accounts:BetaAccount[];sessions:BetaSession[];grants:BetaGrant[]}
export interface LinkedDeviceView {id:string;label:string;platform:string;createdAt:number;lastSeenAt:number}
export interface AccountView {
 id:string;email:string;displayName:string;organisation:string;country:string;status:ApplicationStatus;
 // The applicant's own words, kept so the owner can review without a second lookup. The view only
 // ever reaches the account it belongs to (the dashboard) or the panel owner (the review desk).
 useCase:string;events:string;createdAt:number;decidedAt:number|null;devices:LinkedDeviceView[];
}
export interface DownloadView {url:string;version:string;notes:string}
export interface BetaStatusView {
 mode:BetaMode;applicationsOpen:boolean;signedIn:boolean;account:AccountView|null;download:DownloadView|null;
 host:string;reviewNote:string;
}
export interface DeviceGrantView {userCode:string;deviceCode:string;expiresAt:number;interval:number;verificationUrl:string}
export interface DevicePollView {status:'pending'|'approved'|'denied'|'expired';installationToken?:string;deviceId?:string;account?:{email:string;displayName:string}}
export interface ApplicationInput {name:string;email:string;organisation:string;country:string;useCase:string;events:string}
export interface BetaContext {address:string;userAgent:string;origin:string;secure:boolean}
export type BetaResult<T>={ok:true;value:T}|{ok:false;status:number;code:string;message:string};
// Two halves on purpose. The site half is what the landing page, the application form and the
// dashboard call. The launcher half is what a running installation asks about itself. A local beta
// serves both from this host; a hosted deployment serves the site half itself and the host proxies
// those calls through, using only the launcher half directly.
export interface SiteBetaService {
 status(cookieId:string|undefined):Promise<BetaStatusView>;
 apply(input:ApplicationInput,context:BetaContext):Promise<BetaResult<{account:AccountView;invite:string|null}>>;
 signIn(input:{email:string;password:string},context:BetaContext):Promise<BetaResult<{cookieId:string;account:AccountView}>>;
 signOut(cookieId:string|undefined):Promise<void>;
 activate(input:{invite:string;password:string},context:BetaContext):Promise<BetaResult<{cookieId:string;account:AccountView}>>;
}
export interface LauncherBetaService {
 deviceStart(input:{label:string;platform:string},context:BetaContext):Promise<BetaResult<DeviceGrantView>>;
 devicePoll(input:{deviceCode:string}):Promise<BetaResult<DevicePollView>>;
 // The panel's own two operations, so a hosted deployment can still review applications from the
 // observer machine: in local mode they are the store, in hosted mode they carry the service key.
 applications():Promise<AccountView[]>;
 decide(id:string,decision:'approve'|'reject',decidedBy:string):Promise<BetaResult<{account:AccountView;invite:string|null}>>;
}
export interface BetaService extends SiteBetaService,LauncherBetaService {
 readonly mode:BetaMode;
 // These two need the account's own session cookie, which lives in a browser — in hosted mode the
 // browser's request is proxied instead of being re-issued from here (see server/index.ts).
 deviceDecide(cookieId:string|undefined,userCode:string,approve:boolean):Promise<BetaResult<{account:AccountView}>>;
 revokeDevice(cookieId:string|undefined,deviceId:string):Promise<BetaResult<{account:AccountView}>>;
}
export interface BetaServiceOptions {
 dir:string;
 download?:Partial<DownloadView>;
 autoApprove?:boolean;
 reviewNote?:string;
 now?:()=>number;
 host?:string;
}
export const hashToken=(value:string)=>createHash('sha256').update(value).digest('hex');
export const newToken=(bytes=24)=>randomBytes(bytes).toString('base64url');
export function digestSecret(value:string,seed?:Buffer){const salt=seed??randomBytes(16);return {salt:salt.toString('hex'),digest:scryptSync(value,salt,64).toString('hex')}}
export function secretMatches(value:string,stored:AccountSecret|null|undefined){
 if(!stored) return false;
 const expected=Buffer.from(stored.digest,'hex');
 const actual=scryptSync(value,Buffer.from(stored.salt,'hex'),expected.length);
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
export function accountCookie(id:string,ttlMs:number,secure:boolean){
 return `${ACCOUNT_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,Math.floor(ttlMs/1000))}${secure?'; Secure':''}`;
}
export const clearedAccountCookie=(secure:boolean)=>accountCookie('',0,secure);
export function newUserCode(){let code='';const bytes=randomBytes(USER_CODE_LENGTH);for(let index=0;index<USER_CODE_LENGTH;index++)code+=USER_CODE_ALPHABET[bytes[index]%USER_CODE_ALPHABET.length];return `${code.slice(0,4)}-${code.slice(4)}`}
export const normalizeUserCode=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'');
export const normalizeEmail=(value:string)=>value.trim().toLowerCase();
const isEmail=(value:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
// A password only has to be long enough that guessing is pointless once the application was
// reviewed by a human. Length, not composition rules: this is an operator tool, not a bank.
export const MIN_PASSWORD=10;
export function accountView(account:BetaAccount):AccountView {
 return {id:account.id,email:account.email,displayName:account.displayName,organisation:account.organisation,country:account.country,status:account.status,useCase:account.useCase,events:account.events,createdAt:account.createdAt,decidedAt:account.decidedAt,devices:account.devices.filter(device=>!device.revokedAt).map(device=>({id:device.id,label:device.label,platform:device.platform,createdAt:device.createdAt,lastSeenAt:device.lastSeenAt}))};
}
// ------------------------------------------------------------------ the local beta, on this host
// One JSON document under the operator data directory. It is written atomically (temp file +
// rename) exactly like config/teams.json, so a crash mid-write cannot leave a half-application
// behind, and it is loaded once at startup.
export class LocalBetaService implements BetaService {
 readonly mode:BetaMode='local';
 private store:BetaStore={version:1,accounts:[],sessions:[],grants:[]};
 private readonly dir:string;
 private readonly download:DownloadView;
 private readonly autoApprove:boolean;
 private readonly reviewNote:string;
 private readonly now:()=>number;
 private readonly host:string;
 private stamps:Map<string,number[]>=new Map();
 private failures:Map<string,{count:number;first:number}>=new Map();
 constructor(options:BetaServiceOptions){
  this.dir=options.dir;this.now=options.now??Date.now;
  this.download={url:options.download?.url||DEFAULT_DOWNLOAD_URL,version:options.download?.version||DEFAULT_DOWNLOAD_VERSION,notes:options.download?.notes||''};
  this.autoApprove=options.autoApprove===true;
  this.reviewNote=options.reviewNote||'Applications are reviewed by a human. You will receive an invite link as soon as your operator account is created.';
  this.host=options.host||'';
 }
 get storeFile(){return path.join(this.dir,'store.json')}
 async load(){
  await mkdir(this.dir,{recursive:true});
  try{const parsed=JSON.parse(await readFile(this.storeFile,'utf8'));if(parsed&&Array.isArray(parsed.accounts))this.store={version:1,accounts:parsed.accounts,sessions:parsed.sessions||[],grants:parsed.grants||[]}}
  catch(error:any){if(error?.code!=='ENOENT')console.warn('[beta] config/beta/store.json is unreadable — starting from an empty beta:',error.message)}
  this.reap();
  return this;
 }
 async save(){
  await mkdir(this.dir,{recursive:true});
  await writeFile(this.storeFile+'.tmp',JSON.stringify(this.store,null,2),{mode:0o600});
  await rename(this.storeFile+'.tmp',this.storeFile);
 }
 private reap(){
  const now=this.now();
  const before=this.store.sessions.length;
  this.store.sessions=this.store.sessions.filter(session=>now-session.lastSeenAt<ACCOUNT_TTL_MS);
  this.store.grants=this.store.grants.filter(grant=>now-grant.createdAt<DEVICE_CODE_TTL_MS*6);
  for(const [address,record] of this.failures) if(now-record.first>LOGIN_FAILURE_WINDOW_MS) this.failures.delete(address);
  for(const [address,stamps] of this.stamps) this.stamps.set(address,stamps.filter(stamp=>now-stamp<60*60*1000));
  return before-this.store.sessions.length;
 }
 private find(email:string){return this.store.accounts.find(account=>account.email===normalizeEmail(email))}
 private sessionAccount(id:string|undefined):{session:BetaSession;account:BetaAccount}|null {
  if(!id) return null;
  const digest=hashToken(id);
  const session=this.store.sessions.find(entry=>entry.id===digest);
  if(!session) return null;
  if(this.now()-session.lastSeenAt>=ACCOUNT_TTL_MS){this.store.sessions=this.store.sessions.filter(entry=>entry!==session);return null}
  const account=this.store.accounts.find(entry=>entry.id===session.accountId);
  if(!account) return null;
  session.lastSeenAt=this.now();
  return {session,account};
 }
 private issueSession(account:BetaAccount,context:BetaContext):string {
  const id=newToken(24);
  this.store.sessions.push({id:hashToken(id),accountId:account.id,createdAt:this.now(),lastSeenAt:this.now(),address:context.address,userAgent:(context.userAgent||'').slice(0,120)});
  return id;
 }
 // The site half: what the landing page, the application form and the dashboard ask for. Every
 // answer is a *view* — no digests, ids or tokens ever leave this module.
 async status(cookieId:string|undefined):Promise<BetaStatusView>{
  this.reap();
  const current=this.sessionAccount(cookieId);
  return {
   mode:this.mode,applicationsOpen:true,signedIn:!!current,account:current?accountView(current.account):null,
   download:current&&current.account.status==='approved'?this.download:null,host:this.host,reviewNote:this.reviewNote,
  };
 }
 // Applications are the one write a stranger may make, so they are rate limited by address and the
 // answer never confirms whether an address is already known — someone who applied before is told
 // to sign in instead, which is what they actually want to do.
 async apply(input:ApplicationInput,context:BetaContext):Promise<BetaResult<{account:AccountView;invite:string|null}>>{
  this.reap();
  const email=normalizeEmail(input.email);
  if(!isEmail(email)) return {ok:false,status:400,code:'bad-email',message:'That does not look like an email address.'};
  if(input.name.trim().length<2) return {ok:false,status:400,code:'bad-name',message:'Tell us the name to put on the account.'};
  const stamps=(this.stamps.get(context.address)||[]).filter(stamp=>this.now()-stamp<60*60*1000);
  if(stamps.length>=MAX_APPLICATIONS_PER_HOUR) return {ok:false,status:429,code:'throttled',message:'That address has sent several applications already. Try again in an hour.'};
  const existing=this.find(email);
  if(existing){
   if(existing.status==='approved') return {ok:false,status:409,code:'already-approved',message:'That address already has an approved account — sign in, or open the invite link from your approval.'};
   return {ok:false,status:409,code:'already-applied',message:'That address already has an application in review. Sign in if you have already set a password.'};
  }
  const account:BetaAccount={
   id:newToken(12),email,displayName:input.name.trim().slice(0,80),organisation:input.organisation.trim().slice(0,120),
   country:input.country.trim().slice(0,60),useCase:input.useCase.trim().slice(0,600),events:input.events.trim().slice(0,80),
   status:'pending',createdAt:this.now(),decidedAt:null,decidedBy:'',password:null,invite:null,devices:[],
  };
  let invite:string|null=null;
  this.store.accounts.push(account);
  stamps.push(this.now());this.stamps.set(context.address,stamps);
  if(this.autoApprove) invite=this.grantInvite(account,'automatic approval (SCOUT_BETA_AUTO_APPROVE=1)');
  await this.save();
  return {ok:true,value:{account:accountView(account),invite}};
 }
 // Approval mints a one-time invite; the applicant sets their own password through it, so no
 // password ever travels through a channel the operator — or the host console — can read.
 private grantInvite(account:BetaAccount,decidedBy:string){
  const invite=newToken(24);
  account.status='approved';account.decidedAt=this.now();account.decidedBy=decidedBy;
  account.invite={digest:hashToken(invite),expiresAt:this.now()+14*24*60*60*1000};
  return invite;
 }
 async signIn(input:{email:string;password:string},context:BetaContext):Promise<BetaResult<{cookieId:string;account:AccountView}>>{
  this.reap();
  const record=this.failures.get(context.address);
  if(record&&record.count>=MAX_LOGIN_FAILURES&&this.now()-record.first<LOGIN_FAILURE_WINDOW_MS)
   return {ok:false,status:429,code:'throttled',message:`Too many failed sign-ins from ${context.address}. Try again in ${Math.ceil((LOGIN_FAILURE_WINDOW_MS-(this.now()-record.first))/60000)} minute(s).`};
  const account=this.find(input.email);
  if(!account||!secretMatches(input.password,account.password)){
   const next:{count:number;first:number}=!record||this.now()-record.first>LOGIN_FAILURE_WINDOW_MS?{count:1,first:this.now()}:{count:record.count+1,first:record.first};
   this.failures.set(context.address,next);
   return {ok:false,status:401,code:'bad-credentials',message:'That email address and password do not match an account.'};
  }
  if(account.status!=='approved') return {ok:false,status:403,code:account.status==='pending'?'pending-review':'rejected',message:account.status==='pending'?'This application is still in review. You will get an invite link as soon as it is approved.':'This application was not approved for the closed beta.'};
  this.failures.delete(context.address);
  const cookieId=this.issueSession(account,context);
  await this.save();
  return {ok:true,value:{cookieId,account:accountView(account)}};
 }
 async signOut(cookieId:string|undefined){if(!cookieId)return;const digest=hashToken(cookieId);this.store.sessions=this.store.sessions.filter(session=>session.id!==digest);await this.save()}
 async activate(input:{invite:string;password:string},context:BetaContext):Promise<BetaResult<{cookieId:string;account:AccountView}>>{
  this.reap();
  if(input.password.length<MIN_PASSWORD) return {ok:false,status:400,code:'weak-password',message:`Choose a password of at least ${MIN_PASSWORD} characters.`};
  const digest=hashToken(input.invite.trim());
  const account=this.store.accounts.find(entry=>entry.invite?.digest===digest);
  if(!account) return {ok:false,status:401,code:'bad-invite',message:'That invite link is not valid. Ask the operator who approved you for a new one.'};
  if(account.invite&&account.invite.expiresAt<this.now()){account.invite=null;await this.save();return {ok:false,status:401,code:'expired-invite',message:'That invite link has expired. Ask for a new one.'}}
  account.password=digestSecret(input.password);
  account.invite=null;
  const cookieId=this.issueSession(account,context);
  await this.save();
  return {ok:true,value:{cookieId,account:accountView(account)}};
 }
 async decide(id:string,decision:'approve'|'reject',decidedBy:string):Promise<BetaResult<{account:AccountView;invite:string|null}>>{
  const account=this.store.accounts.find(entry=>entry.id===id);
  if(!account) return {ok:false,status:404,code:'not-found',message:'That application no longer exists.'};
  const invite=decision==='approve'?this.grantInvite(account,decidedBy):null;
  if(decision==='reject'){account.status='rejected';account.decidedAt=this.now();account.decidedBy=decidedBy;account.invite=null}
  await this.save();
  return {ok:true,value:{account:accountView(account),invite}};
 }
 async applications():Promise<AccountView[]>{
  this.reap();
  return [...this.store.accounts].sort((a,b)=>b.createdAt-a.createdAt).map(accountView);
 }
 // The device flow, RFC 8628 style: the launcher shows a short code, the operator approves it in a
 // browser they are already signed in to, and only then does the launcher receive its token. No
 // password is ever typed into the launcher, and a code alone is useless without the account.
 async deviceStart(input:{label:string;platform:string},context:BetaContext):Promise<BetaResult<DeviceGrantView>>{
  this.reap();
  const now=this.now();
  this.store.grants=this.store.grants.filter(grant=>grant.status==='pending'?grant.expiresAt>now:now-grant.createdAt<DEVICE_CODE_TTL_MS);
  if(this.store.grants.filter(grant=>grant.status==='pending'&&grant.createdAt>now-60*60*1000).length>=20)
   return {ok:false,status:429,code:'throttled',message:'Too many pending launcher codes. Approve or wait for the existing ones to expire.'};
  let userCode=newUserCode();
  for(let attempt=0;attempt<5&&this.store.grants.some(grant=>grant.userCode===normalizeUserCode(userCode)&&grant.status==='pending');attempt++) userCode=newUserCode();
  const deviceCode=newToken(32);
  const grant:BetaGrant={userCode:normalizeUserCode(userCode),deviceCode:hashToken(deviceCode),label:input.label.slice(0,60),platform:input.platform.slice(0,40),createdAt:now,expiresAt:now+DEVICE_CODE_TTL_MS,status:'pending',accountId:null,deviceId:null,installationToken:null};
  this.store.grants.push(grant);
  await this.save();
  const base=context.origin.replace(/\/$/,'');
  return {ok:true,value:{userCode,deviceCode,expiresAt:grant.expiresAt,interval:DEVICE_POLL_INTERVAL_MS,verificationUrl:`${base}/dashboard?link=${encodeURIComponent(userCode)}`}};
 }
 async devicePoll(input:{deviceCode:string}):Promise<BetaResult<DevicePollView>>{
  this.reap();
  const grant=this.store.grants.find(entry=>entry.deviceCode===hashToken(input.deviceCode));
  if(!grant) return {ok:false,status:404,code:'unknown-code',message:'That launcher code is not known to this host. Start a new link.'};
  if(grant.status==='pending'&&grant.expiresAt<this.now()) return {ok:true,value:{status:'expired'}};
  if(grant.status!=='approved'||!grant.accountId) return {ok:true,value:{status:grant.status==='denied'?'denied':'pending'}};
  const account=this.store.accounts.find(entry=>entry.id===grant.accountId);
  const view=account?{email:account.email,displayName:account.displayName}:undefined;
  // The installation token is handed over exactly once: the launcher stores it and proves its
  // identity with it from then on, so the store does not have to keep a usable copy at rest. A
  // launcher that missed the collection starts a new link, which costs one code.
  if(grant.installationToken){
   const token=grant.installationToken;
   grant.installationToken=null;
   await this.save();
   return {ok:true,value:{status:'approved',installationToken:token,deviceId:grant.deviceId||undefined,account:view}};
  }
  return {ok:true,value:{status:'approved',deviceId:grant.deviceId||undefined,account:view}};
 }
 async deviceDecide(cookieId:string|undefined,userCode:string,approve:boolean):Promise<BetaResult<{account:AccountView}>>{
  this.reap();
  const current=this.sessionAccount(cookieId);
  if(!current) return {ok:false,status:401,code:'no-session',message:'Sign in with your SCOUT account before approving a launcher.'};
  if(current.account.status!=='approved') return {ok:false,status:403,code:'pending-review',message:'Your account is not approved yet, so it cannot link a launcher.'};
  const code=normalizeUserCode(userCode);
  const grant=this.store.grants.find(entry=>entry.userCode===code);
  if(!grant) return {ok:false,status:404,code:'unknown-code',message:'No launcher is waiting with that code. Copy it from the launcher window.'};
  if(grant.expiresAt<this.now()&&grant.status==='pending'){await this.save();return {ok:false,status:410,code:'expired-code',message:'That code has expired. Start a new link in the launcher.'}};
  if(grant.status!=='pending') return {ok:false,status:409,code:'already-decided',message:grant.status==='approved'?'That launcher is already linked.':'That code was already refused.'};
  if(!approve){grant.status='denied';await this.save();return {ok:true,value:{account:accountView(current.account)}}}
  const token=newToken(32);
  const device:BetaDevice={id:newToken(12),label:grant.label||'SCOUT launcher',platform:grant.platform||'windows',createdAt:this.now(),lastSeenAt:this.now(),revokedAt:null,tokenDigest:hashToken(token)};
  current.account.devices.push(device);
  grant.status='approved';grant.accountId=current.account.id;grant.deviceId=device.id;grant.installationToken=token;
  await this.save();
  return {ok:true,value:{account:accountView(current.account)}};
 }
 async revokeDevice(cookieId:string|undefined,deviceId:string):Promise<BetaResult<{account:AccountView}>>{
  const current=this.sessionAccount(cookieId);
  if(!current) return {ok:false,status:401,code:'no-session',message:'Sign in with your SCOUT account first.'};
  const device=current.account.devices.find(entry=>entry.id===deviceId&&!entry.revokedAt);
  if(!device) return {ok:false,status:404,code:'not-found',message:'That launcher is not linked to this account.'};
  device.revokedAt=this.now();
  await this.save();
  return {ok:true,value:{account:accountView(current.account)}};
 }
}
// ------------------------------------------------------------------ the hosted beta, over HTTPS
// The same REST contract, reached with fetch. The host proxies the browser's `/api/beta/*` calls
// here (cookies and all), so the panel and the landing page never learn where the accounts really
// live, and a shared hosting deployment needs no CORS setup at all.
export class HostedBetaService implements LauncherBetaService {
 readonly mode:BetaMode='hosted';
 constructor(private readonly baseUrl:string,private readonly apiKey?:string,private readonly fetchImpl:typeof fetch=fetch){}
 private async call<T>(route:string,method:string,body?:unknown,headers?:Record<string,string>):Promise<BetaResult<T>>{
  try{
   const res=await this.fetchImpl(this.baseUrl.replace(/\/$/,'')+route,{
    method,
    headers:{'Content-Type':'application/json',...(this.apiKey?{Authorization:`Bearer ${this.apiKey}`}:{}),...headers},
    body:body===undefined?undefined:JSON.stringify(body),
   });
   const text=await res.text();
   let json:any=null;try{json=text?JSON.parse(text):null}catch{}
   if(!res.ok) return {ok:false,status:res.status,code:json?.code||'upstream-refused',message:json?.error||`The SCOUT account service answered ${res.status}.`};
   return {ok:true,value:(json??{}) as T};
  }catch(error:any){
   return {ok:false,status:503,code:'upstream-unreachable',message:`The SCOUT account service could not be reached (${error?.message||'network error'}).`};
  }
 }
 // The site half is deliberately absent here: in hosted mode the browser's /api/beta requests are
 // proxied verbatim to this service (cookies included), so a second implementation of them would
 // only be a copy that drifts. What the host itself needs is the launcher half below.
 async decide(id:string,decision:'approve'|'reject',decidedBy:string){return this.call<{account:AccountView;invite:string|null}>('/applications/'+encodeURIComponent(id),'POST',{decision,decidedBy})}
 async applications(){const result=await this.call<{applications:AccountView[]}>('/applications','GET');return result.ok?result.value.applications:[]}
 async deviceStart(input:{label:string;platform:string},context:BetaContext){return this.call<DeviceGrantView>('/device/start','POST',{...input,origin:context.origin})}
 async devicePoll(input:{deviceCode:string}){return this.call<DevicePollView>('/device/poll','POST',input)}
}
export interface BetaFactoryOptions extends Omit<BetaServiceOptions,'dir'>{dir?:string;apiUrl?:string;apiKey?:string}
// What the host gets back: the site half is null in hosted mode (the browser's requests are proxied
// there instead), the launcher half is always real, and `local` is set only for the JSON store, so
// startup knows whether it has a file to load.
export interface BetaRuntime {mode:BetaMode;site:SiteBetaService|null;launcher:LauncherBetaService;local:LocalBetaService|null}
export function createBetaService(options:BetaFactoryOptions):BetaRuntime {
 if(options.apiUrl) return {mode:'hosted',site:null,launcher:new HostedBetaService(options.apiUrl,options.apiKey),local:null};
 const service=new LocalBetaService({...options,dir:options.dir||'config/beta'});
 return {mode:'local',site:service,launcher:service,local:service};
}
// ------------------------------------------------------------------ this installation's own link
// The launcher half. `installation.json` is the launcher's identity: which account it belongs to,
// the device id the website can revoke, and the token it presents to prove it is that device. The
// file is written 0600 and lives next to the operator data (config/beta/), never in the program
// directory, so an installer update keeps the link and an uninstall can remove it deliberately.
export interface InstallationView {
 linked:boolean;deviceId:string|null;email:string|null;displayName:string|null;linkedAt:number|null;
 lastCheckedAt:number|null;pending:{userCode:string;deviceCode:string;expiresAt:number}|null;installationId:string;
}
export class Installation {
 private state:{version:1;installationId:string;account:{email:string;displayName:string}|null;deviceId:string|null;installationToken:string|null;linkedAt:number|null;lastCheckedAt:number|null;pending:{userCode:string;deviceCode:string;expiresAt:number}|null};
 constructor(private readonly file:string,private readonly now:()=>number=Date.now){
  this.state={version:1,installationId:newToken(12),account:null,deviceId:null,installationToken:null,linkedAt:null,lastCheckedAt:null,pending:null};
 }
 async load(){
  try{
   const parsed=JSON.parse(await readFile(this.file,'utf8'));
   if(parsed&&typeof parsed==='object') this.state={...this.state,...parsed};
  }catch(error:any){if(error?.code!=='ENOENT')console.warn('[beta] the launcher link file is unreadable — this installation looks unlinked:',error.message)}
  if(this.state.pending&&this.state.pending.expiresAt<this.now()) this.state.pending=null;
  return this;
 }
 async save(){
  await mkdir(path.dirname(this.file),{recursive:true});
  await writeFile(this.file+'.tmp',JSON.stringify(this.state,null,2),{mode:0o600});
  await rename(this.file+'.tmp',this.file);
 }
 view():InstallationView {
  const pending=this.state.pending&&this.state.pending.expiresAt>this.now()?this.state.pending:null;
  return {linked:!!(this.state.installationToken&&this.state.account),deviceId:this.state.deviceId,email:this.state.account?.email??null,displayName:this.state.account?.displayName??null,linkedAt:this.state.linkedAt,lastCheckedAt:this.state.lastCheckedAt,pending:pending?{userCode:pending.userCode,deviceCode:pending.deviceCode,expiresAt:pending.expiresAt}:null,installationId:this.state.installationId};
 }
 beginLink(grant:{userCode:string;deviceCode:string;expiresAt:number}){this.state.pending={userCode:grant.userCode,deviceCode:grant.deviceCode,expiresAt:grant.expiresAt}}
 completeLink(poll:{installationToken?:string;deviceId?:string;account?:{email:string;displayName:string}}){
  if(!poll.installationToken||!poll.account) return false;
  this.state.installationToken=poll.installationToken;this.state.deviceId=poll.deviceId??null;this.state.account={...poll.account};
  this.state.linkedAt=this.now();this.state.pending=null;return true;
 }
 unlink(){this.state.installationToken=null;this.state.deviceId=null;this.state.account=null;this.state.linkedAt=null;this.state.pending=null}
 touch(){this.state.lastCheckedAt=this.now()}
}
