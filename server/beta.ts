import {createHash,randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {PlatformSettings} from './platform.js';
import {TRIAL_DAYS,emptyBilling,isPlanId,type BillingState,type PlanId} from './plans.js';
import {describeEmailFailure,emailConfiguration,invitationEmail,openEmail,recoveryEmail,resendTransport,sealEmail,type EmailTransport,type EncryptedEmail} from './email.js';
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
// Invitations and password recovery use a local or hosted encrypted outbox. An approval is refused
// visibly if mail is not configured; no invite URL is printed or returned to a browser.
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
// A revocation reason is an operator note, not an essay: short enough to fit the review desk and
// the audit log line, long enough to say which rule was broken.
export const MAX_REVOKE_REASON=280;
// Printed on the dashboard and used by the download card. The installer publishes exactly this
// asset name (`npm run package:windows`), so a GitHub release is a complete download story.
export const DEFAULT_DOWNLOAD_URL='https://github.com/ArliT1-F/SCOUT/releases/latest';
export const DEFAULT_DOWNLOAD_VERSION='SCOUT-Setup-0.1.0.exe';
// Crockford-ish alphabet: no 0/O/1/I/L, so a code read off the launcher window and typed into a
// browser cannot be mistyped into a different valid-looking code.
const USER_CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH=8;
export type ApplicationStatus='pending'|'approved'|'rejected'|'revoked';
export type BetaMode='local'|'hosted';
export interface AccountSecret {salt:string;digest:string}
export interface BetaDevice {id:string;label:string;platform:string;createdAt:number;lastSeenAt:number;revokedAt:number|null;tokenDigest:string}
export interface BetaAccount {
 id:string;email:string;displayName:string;organisation:string;country:string;useCase:string;events:string;
 status:ApplicationStatus;createdAt:number;decidedAt:number|null;decidedBy:string;
 password:AccountSecret|null;invite:{digest:string;expiresAt:number}|null;devices:BetaDevice[];
 /** Why an approved account was revoked. Only ever set when status is 'revoked'. */
 revokedReason?:string|null;
 // Launch gate (server/plans.ts). Optional on purpose: a store written before plans existed loads
 // unchanged and is treated as a Founder account, never as an account with no access.
 plan?:PlanId|null;
 trialEndsAt?:number|null;
 billing?:BillingState|null;
}
export interface BetaSession {id:string;accountId:string;createdAt:number;lastSeenAt:number;address:string;userAgent:string}
export interface BetaGrant {
 // `deviceCode` is the digest of the code the launcher holds, exactly like every other secret here:
 // the launcher polls with the value, and this host compares digests to find the grant.
 userCode:string;deviceCode:string;label:string;platform:string;createdAt:number;expiresAt:number;
 status:'pending'|'approved'|'denied';accountId:string|null;deviceId:string|null;installationToken:string|null;
}
export interface LocalOutboxEntry extends EncryptedEmail {id:string;template:'invitation'|'password_recovery';recipientDigest:string;createdAt:number;nextAttemptAt:number;attempts:number;sentAt:number|null;lastErrorCode:string|null;lastErrorStatus:number|null;lastProviderError:string|null}
export interface LocalRecoveryToken {digest:string;accountId:string;createdAt:number;expiresAt:number;usedAt:number|null}
export interface BetaStore {version:1;accounts:BetaAccount[];sessions:BetaSession[];grants:BetaGrant[];emailOutbox?:LocalOutboxEntry[];recoveries?:LocalRecoveryToken[];audit?:Array<{at:number;action:string;accountId:string|null}>}
export interface LinkedDeviceView {id:string;label:string;platform:string;createdAt:number;lastSeenAt:number}
export interface InvitationDeliveryView {status:'sent'|'pending'|'manual'|'none';activated?:boolean;expiresAt?:number|null;sentAt?:number|null;attempts?:number;errorCode?:string|null;errorStatus?:number|null;providerError?:string|null;nextAttemptAt?:number|null;guidance?:string|null}
export interface ApplicationReviewView {applications:AccountView[];invitations:Record<string,InvitationDeliveryView>}
export interface AccountView {
 id:string;email:string;displayName:string;organisation:string;country:string;status:ApplicationStatus;
 // The applicant's own words, kept so the owner can review without a second lookup. The view only
 // ever reaches the account it belongs to (the dashboard) or the panel owner (the review desk).
 useCase:string;events:string;createdAt:number;decidedAt:number|null;devices:LinkedDeviceView[];
 /** Why an approved account was revoked. Only ever set when status is 'revoked'. */
 revokedReason:string|null;
 // The account's commercial state. `entitlements` is computed from these by server/plans.ts, which
 // is the only place that decides what they mean.
 plan?:PlanId|null;
 trialEndsAt?:number|null;
 billing?:BillingState|null;
}
export interface DownloadView {url:string;version:string;notes:string}
export interface BetaStatusView {
 mode:BetaMode;applicationsOpen:boolean;signedIn:boolean;account:AccountView|null;download:DownloadView|null;
 host:string;reviewNote:string;
 // Hosted only: whether the signed-in session belongs to an approved owner/reviewer, so a desk
 // client can tell without probing a desk route. The local service omits it; the local host
 // computes reviewer access itself.
 reviewer?:boolean;
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
 requestPasswordRecovery(email:string,context:BetaContext):Promise<BetaResult<{ok:true}>>;
 completePasswordRecovery(input:{token:string;password:string},context:BetaContext):Promise<BetaResult<{ok:true}>>;
 // Launch gate: an instant, verified-email trial. It creates an approved account whose invitation
 // email is the verification, so a stranger can broadcast the day they find SCOUT.
 startTrial(input:ApplicationInput,context:BetaContext):Promise<BetaResult<{account:AccountView;invite:string|null}>>;
}
export interface LicenceCheck {status:'active'|'revoked'|'unknown';email?:string;displayName?:string;accountId?:string} // accountId is service-only, never a licence/browser view
export interface LauncherBetaService {
 deviceStart(input:{label:string;platform:string},context:BetaContext):Promise<BetaResult<DeviceGrantView>>;
 devicePoll(input:{deviceCode:string}):Promise<BetaResult<DevicePollView>>;
 // What a running installation asks about itself: is this launcher still linked to an approved
 // account? In local mode the answer is the device list next door; in hosted mode it is the
 // account service's own record, which is the only place a revocation can be known.
 installationStatus(input:{deviceId:string;installationId:string;token:string},options?:{includeAccountId?:boolean}):Promise<BetaResult<LicenceCheck>>;
 settings?():Promise<BetaResult<{settings:PlatformSettings}>>;
 updateSettings?(input:Partial<PlatformSettings>,cookie:string):Promise<BetaResult<{settings:PlatformSettings}>>;
 // The panel's own two operations, so a hosted deployment can still review applications from the
 // observer machine: in local mode they are the store, in hosted mode they carry the service key.
 applications():Promise<AccountView[]>;
 applicationReview?():Promise<ApplicationReviewView>;
 decide(id:string,decision:'approve'|'reject'|'revoke',decidedBy:string,reason?:string):Promise<BetaResult<{account:AccountView;invite:string|null;invitationDelivery?:InvitationDeliveryView}>>;
 resendInvitation?(id:string,requestedBy:string):Promise<BetaResult<{account:AccountView;invite:string|null;invitationDelivery?:InvitationDeliveryView}>>;
 // Owner desk: move an account between plans (a manual invoice, a Founder grant or a fix after a
 // billing webhook failed). The reason is recorded by the caller in the audit trail.
 setPlan?(id:string,patch:{plan?:PlanId|null;trialEndsAt?:number|null;billing?:BillingState|null;founder?:boolean},by:string):Promise<BetaResult<{account:AccountView}>>;
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
 emailTransport?:EmailTransport;
 emailEncryptionKey?:Buffer;
 emailBaseUrl?:string;
 invitationTtlMs?:number;
 recoveryTtlMs?:number;
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
 return {id:account.id,email:account.email,displayName:account.displayName,organisation:account.organisation,country:account.country,status:account.status,useCase:account.useCase,events:account.events,createdAt:account.createdAt,decidedAt:account.decidedAt,devices:account.devices.filter(device=>!device.revokedAt).map(device=>({id:device.id,label:device.label,platform:device.platform,createdAt:device.createdAt,lastSeenAt:device.lastSeenAt})),revokedReason:account.status==='revoked'?(account.revokedReason??null):null,plan:account.plan??null,trialEndsAt:account.trialEndsAt??null,billing:account.billing??null};
}
// ------------------------------------------------------------------ the local beta, on this host
// One JSON document under the operator data directory. It is written atomically (temp file +
// rename) exactly like config/teams.json, so a crash mid-write cannot leave a half-application
// behind, and it is loaded once at startup.
export class LocalBetaService implements BetaService {
 readonly mode:BetaMode='local';
 private store:BetaStore={version:1,accounts:[],sessions:[],grants:[],emailOutbox:[],recoveries:[],audit:[]};
 private writes:Promise<void>=Promise.resolve();
 private readonly dir:string;
 private readonly download:DownloadView;
 private readonly autoApprove:boolean;
 private readonly reviewNote:string;
 private readonly now:()=>number;
 private readonly host:string;
 private readonly mailKey:Buffer|null;
 private readonly mailBaseUrl:string;
 private readonly mailTransport:EmailTransport|null;
 private readonly invitationTtl:number;
 private readonly recoveryTtl:number;
 private stamps:Map<string,number[]>=new Map();
 private failures:Map<string,{count:number;first:number}>=new Map();
 private recoveryStamps:Map<string,number[]>=new Map();
 constructor(options:BetaServiceOptions){
  this.dir=options.dir;this.now=options.now??Date.now;
  this.download={url:options.download?.url||DEFAULT_DOWNLOAD_URL,version:options.download?.version||DEFAULT_DOWNLOAD_VERSION,notes:options.download?.notes||''};
  this.autoApprove=options.autoApprove===true;
  this.reviewNote=options.reviewNote||'Applications are reviewed by a human. If approved, we will email you a single-use invitation.';
  this.host=options.host||'';
  const mail=emailConfiguration();
  this.mailKey=options.emailEncryptionKey??mail?.encryptionKey??null;
  this.mailBaseUrl=(options.emailBaseUrl??mail?.publicBaseUrl??'').replace(/\/$/,'');
  this.mailTransport=options.emailTransport??(mail?resendTransport(mail):null);
  this.invitationTtl=options.invitationTtlMs??24*60*60*1000;
  this.recoveryTtl=options.recoveryTtlMs??60*60*1000;
 }
 get storeFile(){return path.join(this.dir,'store.json')}
 async load(){
  await mkdir(this.dir,{recursive:true});
  try{const parsed=JSON.parse(await readFile(this.storeFile,'utf8'));if(parsed&&Array.isArray(parsed.accounts)){this.store={version:1,accounts:parsed.accounts,sessions:parsed.sessions||[],grants:parsed.grants||[],emailOutbox:parsed.emailOutbox||[],recoveries:parsed.recoveries||[],audit:parsed.audit||[]};for(const account of this.store.accounts)if(!('revokedReason' in account))account.revokedReason=null;for(const entry of this.store.emailOutbox??[]){const legacy=entry as Partial<LocalOutboxEntry>;if(legacy.lastErrorStatus===undefined){entry.lastErrorStatus=null;entry.lastProviderError=null}}}}
  catch(error:any){if(error?.code!=='ENOENT')console.warn('[beta] config/beta/store.json is unreadable — starting from an empty beta:',error.message)}
  this.reap();
  return this;
 }
 private mailReady(){return Boolean(this.mailKey&&this.mailBaseUrl&&this.mailTransport)}
 private emailUnavailable():BetaResult<never>{return {ok:false,status:503,code:'email-not-configured',message:'Email delivery is not configured. Set SCOUT_EMAIL_API_KEY, SCOUT_EMAIL_FROM, SCOUT_EMAIL_ENCRYPTION_KEY, and SCOUT_ACCOUNT_BASE_URL before approving or resending invitations.'}}
 private recordAudit(action:string,accountId:string|null){
  this.store.audit??=[];this.store.audit.push({at:this.now(),action,accountId});if(this.store.audit.length>2000)this.store.audit.splice(0,this.store.audit.length-2000);
 }
 private queueEmail(template:LocalOutboxEntry['template'],email:string,message:ReturnType<typeof invitationEmail>|ReturnType<typeof recoveryEmail>){
  const encrypted=sealEmail(message,this.mailKey!);
  const entry:LocalOutboxEntry={id:randomUUID(),template,recipientDigest:hashToken(normalizeEmail(email)),...encrypted,createdAt:this.now(),nextAttemptAt:this.now(),attempts:0,sentAt:null,lastErrorCode:null,lastErrorStatus:null,lastProviderError:null};
  this.store.emailOutbox??=[];this.store.emailOutbox.push(entry);return entry;
 }
 private delivery(account:BetaAccount):InvitationDeliveryView{
  const latest=(this.store.emailOutbox??[]).filter(entry=>entry.template==='invitation'&&entry.recipientDigest===hashToken(account.email)).sort((a,b)=>b.createdAt-a.createdAt)[0];
  if(!latest)return {status:'none',activated:!!account.password};
  const errorCode=latest.lastErrorCode;
  const errorStatus=latest.lastErrorStatus??null;
  const providerError=latest.lastProviderError??null;
  const pending=latest.sentAt===null;
  return {status:pending?'pending':'sent',activated:!!account.password,expiresAt:account.invite?.expiresAt??null,sentAt:latest.sentAt,attempts:latest.attempts,errorCode,errorStatus,providerError,nextAttemptAt:pending?latest.nextAttemptAt:null,guidance:pending&&errorCode?describeEmailFailure(errorStatus??0,providerError):null};
 }
 async deliverPending(){
  if(!this.mailReady())return;
  for(const entry of [...(this.store.emailOutbox??[])].filter(row=>row.sentAt===null&&row.nextAttemptAt<=this.now()).slice(0,20)){
   try{
    await this.mailTransport!(openEmail(entry,this.mailKey!),entry.id);
    entry.sentAt=this.now();entry.ciphertext='';entry.iv='';entry.tag='';entry.lastErrorCode=null;entry.lastErrorStatus=null;entry.lastProviderError=null;
   }catch(error){
    entry.attempts++;entry.nextAttemptAt=this.now()+[60_000,5*60_000,15*60_000,60*60_000,6*60*60_000][Math.min(entry.attempts-1,4)];
    const status=Number((error as {status?:unknown})?.status||0);
    const providerCode=typeof (error as {providerCode?:unknown})?.providerCode==='string'?(error as {providerCode:string}).providerCode:null;
    entry.lastErrorCode=status>=400&&status<500&&status!==429?'provider-rejected':'transient';
    entry.lastErrorStatus=status||null;entry.lastProviderError=providerCode;
   }
   await this.save();
  }
 }
 async save(){
  const snapshot=JSON.stringify(this.store,null,2);
  const write=this.writes.then(async()=>{
   await mkdir(this.dir,{recursive:true});
   await writeFile(this.storeFile+'.tmp',snapshot,{mode:0o600});
   await rename(this.storeFile+'.tmp',this.storeFile);
  });
  this.writes=write.catch(()=>{});await write;
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
   if(existing.status==='revoked') return {ok:false,status:403,code:'revoked',message:'That email address was revoked from the closed beta. Contact the SCOUT team if you believe this is a mistake.'};
   return {ok:false,status:409,code:'already-applied',message:'That address already has an application in review. Sign in if you have already set a password.'};
  }
  const account:BetaAccount={
   id:newToken(12),email,displayName:input.name.trim().slice(0,80),organisation:input.organisation.trim().slice(0,120),
   country:input.country.trim().slice(0,60),useCase:input.useCase.trim().slice(0,600),events:input.events.trim().slice(0,80),
   status:'pending',createdAt:this.now(),decidedAt:null,decidedBy:'',password:null,invite:null,devices:[],
  };
  let invite:string|null=null;
  if(this.autoApprove&&!this.mailReady())return this.emailUnavailable();
  this.store.accounts.push(account);
  stamps.push(this.now());this.stamps.set(context.address,stamps);
  this.recordAudit('application.submitted',account.id);
  if(this.autoApprove) invite=this.grantInvite(account,'automatic approval (SCOUT_BETA_AUTO_APPROVE=1)');
  await this.save();
  if(invite)await this.deliverPending();
  return {ok:true,value:{account:accountView(account),invite}};
 }
 // A trial is an application that decides itself: the account is approved immediately with a
 // 14-day window, and the invitation email is what proves the address belongs to the person who
 // asked. Without a mail transport the trial is refused rather than granted unverifiably — an
 // unverified instant account is exactly the abuse a trial must not create.
 async startTrial(input:ApplicationInput,context:BetaContext):Promise<BetaResult<{account:AccountView;invite:string|null}>>{
  this.reap();
  const email=normalizeEmail(input.email);
  if(!isEmail(email)) return {ok:false,status:400,code:'bad-email',message:'That does not look like an email address.'};
  if(input.name.trim().length<2) return {ok:false,status:400,code:'bad-name',message:'Tell us the name to put on the account.'};
  if(!this.mailReady()) return {ok:false,status:503,code:'email-unavailable',message:'This deployment cannot send email yet, so a trial cannot be verified. Apply for access instead — a human will approve you.'};
  const stamps=(this.stamps.get(context.address)||[]).filter(stamp=>this.now()-stamp<60*60*1000);
  if(stamps.length>=MAX_APPLICATIONS_PER_HOUR) return {ok:false,status:429,code:'throttled',message:'That address has started several accounts already. Try again in an hour.'};
  const existing=this.find(email);
  if(existing){
   if(existing.status==='revoked') return {ok:false,status:403,code:'revoked',message:'That email address was revoked from SCOUT. Contact the SCOUT team if you believe this is a mistake.'};
   return {ok:false,status:409,code:'already-exists',message:existing.status==='approved'?'That address already has an account — sign in.':'That address already has an application in review. Sign in if you have set a password.'};
  }
  const account:BetaAccount={
   id:newToken(12),email,displayName:input.name.trim().slice(0,80),organisation:input.organisation.trim().slice(0,120),
   country:input.country.trim().slice(0,60),useCase:input.useCase.trim().slice(0,600),events:input.events.trim().slice(0,80),
   status:'approved',createdAt:this.now(),decidedAt:this.now(),decidedBy:'trial (self-serve)',
   password:null,invite:null,devices:[],
   plan:'trial',trialEndsAt:this.now()+TRIAL_DAYS*86_400_000,billing:emptyBilling('none'),
  };
  this.store.accounts.push(account);
  stamps.push(this.now());this.stamps.set(context.address,stamps);
  const invite=this.grantInvite(account,'trial (self-serve)');
  this.recordAudit('trial.started',account.id);
  await this.save();
  await this.deliverPending();
  return {ok:true,value:{account:accountView(account),invite}};
 }
 // Owner desk: a plan change is a deliberate act with a reason, and it is written to the audit trail
 // by the caller. `founder:true` is the shortcut for "this account predates plans".
 async setPlan(id:string,patch:{plan?:PlanId|null;trialEndsAt?:number|null;billing?:BillingState|null;founder?:boolean},by:string):Promise<BetaResult<{account:AccountView}>>{
  const account=this.store.accounts.find(entry=>entry.id===id);
  if(!account) return {ok:false,status:404,code:'not-found',message:'Unknown account.'};
  if(patch.founder) account.plan='founder';
  else if(patch.plan!==undefined) account.plan=patch.plan&&isPlanId(patch.plan)?patch.plan:null;
  if(patch.trialEndsAt!==undefined) account.trialEndsAt=patch.trialEndsAt;
  if(patch.billing!==undefined) account.billing=patch.billing;
  this.recordAudit(`plan.changed:${by}:${account.plan??'none'}`,account.id);
  await this.save();
  return {ok:true,value:{account:accountView(account)}};
 }
 // Approval mints a one-time invite; the applicant sets their own password through it, so no
 // password ever travels through a channel the operator — or the host console — can read.
 private grantInvite(account:BetaAccount,decidedBy:string,renewal=false){
  const invite=newToken(32),expiresAt=this.now()+this.invitationTtl;
  if(!renewal){account.status='approved';account.decidedAt=this.now();account.decidedBy=decidedBy}
  account.invite={digest:hashToken(invite),expiresAt};
  this.store.emailOutbox=(this.store.emailOutbox??[]).filter(entry=>entry.template!=='invitation'||entry.recipientDigest!==hashToken(account.email)||entry.sentAt!==null);
  this.queueEmail('invitation',account.email,invitationEmail(account.email,account.displayName,`${this.mailBaseUrl}/login?invite=${encodeURIComponent(invite)}`,expiresAt));
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
  if(account.status!=='approved') return {ok:false,status:403,code:account.status==='pending'?'pending-review':account.status==='revoked'?'revoked':'rejected',message:account.status==='pending'?'This application is still in review. We will email you if it is approved.':account.status==='revoked'?'This account has been revoked. Contact the SCOUT team if you believe this is a mistake.':'This application was not approved for the closed beta.'};
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
  this.recordAudit('account.activated',account.id);
  await this.save();
  return {ok:true,value:{cookieId,account:accountView(account)}};
 }
 async requestPasswordRecovery(email:string,context:BetaContext):Promise<BetaResult<{ok:true}>>{
  if(!this.mailReady())return this.emailUnavailable();
  const stamps=(this.recoveryStamps.get(context.address)||[]).filter(stamp=>this.now()-stamp<60*60*1000);
  if(stamps.length>=5)return {ok:false,status:429,code:'throttled',message:'Too many password recovery requests. Wait before trying again.'};
  stamps.push(this.now());this.recoveryStamps.set(context.address,stamps);
  const account=this.find(email);
  if(account?.status==='approved'&&account.password){
   const token=newToken(32),expiresAt=this.now()+this.recoveryTtl;
   this.store.recoveries=(this.store.recoveries??[]).filter(row=>row.accountId!==account.id);
   this.store.recoveries!.push({digest:hashToken(token),accountId:account.id,createdAt:this.now(),expiresAt,usedAt:null});
   this.queueEmail('password_recovery',account.email,recoveryEmail(account.email,account.displayName,`${this.mailBaseUrl}/login?reset=${encodeURIComponent(token)}`,expiresAt));
   this.recordAudit('password-recovery.issued',account.id);await this.save();void this.deliverPending();
  }
  return {ok:true,value:{ok:true}};
 }
 async completePasswordRecovery(input:{token:string;password:string},_context:BetaContext):Promise<BetaResult<{ok:true}>>{
  if(input.password.length<MIN_PASSWORD)return {ok:false,status:400,code:'weak-password',message:`Choose a password of at least ${MIN_PASSWORD} characters.`};
  const token=this.store.recoveries?.find(row=>row.digest===hashToken(input.token.trim())&&row.usedAt===null);
  if(!token||token.expiresAt<this.now())return {ok:false,status:400,code:'invalid-recovery-token',message:'That password reset link is invalid or has expired. Request a new one.'};
  const account=this.store.accounts.find(row=>row.id===token.accountId&&row.status==='approved');
  if(!account)return {ok:false,status:400,code:'invalid-recovery-token',message:'That password reset link is invalid or has expired. Request a new one.'};
  account.password=digestSecret(input.password);account.invite=null;token.usedAt=this.now();
  this.store.recoveries=this.store.recoveries?.filter(row=>row.accountId!==account.id&&row.usedAt===null)||[];
  this.store.sessions=this.store.sessions.filter(session=>session.accountId!==account.id);
  this.recordAudit('password-recovery.completed',account.id);await this.save();
  return {ok:true,value:{ok:true}};
 }
 // Cutting access ends everything the account holds: sessions, launchers, recovery tokens, pending
 // invites and queued mail. The password digest is kept, so an erroneous revocation is recoverable
 // by restoring the status — the account signs in with its existing password and re-links launchers.
 private cutAccess(account:BetaAccount,status:'rejected'|'revoked',decidedBy:string,reason:string|null){
  account.status=status;account.decidedAt=this.now();account.decidedBy=decidedBy;
  account.revokedReason=status==='revoked'?reason:null;
  account.invite=null;
  this.store.sessions=this.store.sessions.filter(session=>session.accountId!==account.id);
  const moment=this.now();
  for(const device of account.devices)if(!device.revokedAt)device.revokedAt=moment;
  this.store.recoveries=(this.store.recoveries??[]).filter(row=>row.accountId!==account.id);
  const digest=hashToken(account.email);
  this.store.emailOutbox=(this.store.emailOutbox??[]).filter(entry=>entry.recipientDigest!==digest||entry.sentAt!==null);
 }
 async decide(id:string,decision:'approve'|'reject'|'revoke',decidedBy:string,reason=''):Promise<BetaResult<{account:AccountView;invite:string|null;invitationDelivery?:InvitationDeliveryView}>>{
  const account=this.store.accounts.find(entry=>entry.id===id);
  if(!account) return {ok:false,status:404,code:'not-found',message:'That application no longer exists.'};
  if(account.status==='revoked')return {ok:false,status:409,code:'already-decided',message:'A revoked account cannot be re-approved. Delete the account and ask for a fresh application instead.'};
  if(decision==='reject'&&account.status==='rejected')return {ok:false,status:409,code:'already-decided',message:'A rejected application is terminal. A new application is required.'};
  if(decision==='revoke'&&account.status!=='approved')return {ok:false,status:409,code:'invalid-decision',message:'Only approved accounts can be revoked. Reject a pending application instead.'};
  if(decision==='approve'&&account.status==='rejected')return {ok:false,status:409,code:'already-decided',message:'A rejected application is terminal. A new application is required.'};
  if(decision==='approve'&&account.password)return {ok:false,status:409,code:'invitation-not-available',message:'Only pending applications or approved accounts that have not activated can receive an invitation.'};
  if(decision==='approve'&&!this.mailReady())return this.emailUnavailable();
  const renewal=decision==='approve'&&account.status==='approved';
  const invite=decision==='approve'?this.grantInvite(account,decidedBy,renewal):null;
  if(decision==='reject')this.cutAccess(account,'rejected',decidedBy,null);
  if(decision==='revoke')this.cutAccess(account,'revoked',decidedBy,reason.trim().slice(0,MAX_REVOKE_REASON)||null);
  this.recordAudit(decision==='revoke'?'account.revoked':renewal?'invitation.resent':`application.${decision}`,account.id);
  await this.save();
  if(decision==='approve')await this.deliverPending();
  return {ok:true,value:{account:accountView(account),invite,invitationDelivery:decision==='approve'?this.delivery(account):undefined}};
 }
 async applications():Promise<AccountView[]>{
  this.reap();
  return [...this.store.accounts].sort((a,b)=>b.createdAt-a.createdAt).map(accountView);
 }
 async applicationReview():Promise<ApplicationReviewView>{
  this.reap();
  const invitations:ApplicationReviewView['invitations']={};
  for(const account of this.store.accounts)if(account.status==='approved')invitations[account.id]=this.delivery(account);
  return {applications:await this.applications(),invitations};
 }
 async resendInvitation(id:string,requestedBy:string){return this.decide(id,'approve',requestedBy)}
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
  return {ok:true,value:{userCode,deviceCode,expiresAt:grant.expiresAt,interval:DEVICE_POLL_INTERVAL_MS,verificationUrl:`${base}/login?link=${encodeURIComponent(userCode)}`}};
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
 async installationStatus(input:{deviceId:string;installationId:string;token:string},options?:{includeAccountId?:boolean}):Promise<BetaResult<LicenceCheck>>{
  this.reap();
  for(const account of this.store.accounts){
   const device=account.devices.find(entry=>entry.id===input.deviceId);
   if(!device) continue;
   if(device.revokedAt) return {ok:true,value:{status:'revoked',email:account.email,displayName:account.displayName}};
   // The token proves the caller is the installation the device id names, so a leaked device id
   // alone cannot be used to read the account behind it.
   if(hashToken(input.token)!==device.tokenDigest) return {ok:true,value:{status:'revoked',email:account.email,displayName:account.displayName}};
   device.lastSeenAt=this.now();
   await this.save();
   if(account.status!=='approved') return {ok:true,value:{status:'revoked',email:account.email,displayName:account.displayName}};
   return {ok:true,value:{status:'active',email:account.email,displayName:account.displayName,...(options?.includeAccountId?{accountId:account.id}:{})}};
  }
  return {ok:true,value:{status:'unknown'}};
 }
 async deviceDecide(cookieId:string|undefined,userCode:string,approve:boolean):Promise<BetaResult<{account:AccountView}>>{
  this.reap();
  const current=this.sessionAccount(cookieId);
  if(!current) return {ok:false,status:401,code:'no-session',message:'Sign in with your SCOUT account before approving a launcher.'};
  if(current.account.status!=='approved') return {ok:false,status:403,code:current.account.status==='pending'?'pending-review':current.account.status==='revoked'?'revoked':'rejected',message:current.account.status==='pending'?'Your account is not approved yet, so it cannot link a launcher.':current.account.status==='revoked'?'This account has been revoked, so it cannot link a launcher.':'This application was not approved, so it cannot link a launcher.'};
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
    method,signal:AbortSignal.timeout(30_000),
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
 async decide(id:string,decision:'approve'|'reject'|'revoke',decidedBy:string,reason=''){return this.call<{account:AccountView;invite:string|null;invitationDelivery?:InvitationDeliveryView}>('/applications/'+encodeURIComponent(id),'POST',{decision,decidedBy,...(reason?{reason}:{})})}
 async resendInvitation(id:string,requestedBy:string){return this.call<{account:AccountView;invite:string|null;invitationDelivery?:InvitationDeliveryView}>('/applications/'+encodeURIComponent(id)+'/resend-invitation','POST',{requestedBy})}
 async applicationReview(){const result=await this.call<ApplicationReviewView>('/applications','GET');return result.ok?result.value:{applications:[],invitations:{}}}
 async applications(){return (await this.applicationReview()).applications}
 async installationStatus(input:{deviceId:string;installationId:string;token:string},options?:{includeAccountId?:boolean}){return this.call<LicenceCheck>('/license/check','POST',{deviceId:input.deviceId,installationId:input.installationId,token:input.token,...(options?.includeAccountId?{resolveAccount:true}:{})})}
 async settings(){return this.call<{settings:PlatformSettings}>('/settings','GET')}
 async updateSettings(input:Partial<PlatformSettings>,cookie:string){return this.call<{settings:PlatformSettings}>('/settings','PUT',input,{Cookie:cookie})}
 async deviceStart(input:{label:string;platform:string},context:BetaContext){return this.call<DeviceGrantView>('/device/start','POST',{...input,origin:context.origin})}
 async devicePoll(input:{deviceCode:string}){return this.call<DevicePollView>('/device/poll','POST',input)}
 // The service implements these two; the host only needs them when the website is hosted and the
 // owner desk (or a trial form) runs from this machine.
 async startTrial(input:ApplicationInput,_context:BetaContext){return this.call<{account:AccountView;invite:string|null}>('/trial','POST',input)}
 async setPlan(id:string,patch:{plan?:PlanId|null;trialEndsAt?:number|null;billing?:BillingState|null;founder?:boolean},by:string){return this.call<{account:AccountView}>('/accounts/'+encodeURIComponent(id)+'/plan','POST',{...patch,by})}
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
 private writes:Promise<void>=Promise.resolve();
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
  const snapshot=JSON.stringify(this.state,null,2);
  const write=this.writes.then(async()=>{
   await mkdir(path.dirname(this.file),{recursive:true});
   await writeFile(this.file+'.tmp',snapshot,{mode:0o600});
   await rename(this.file+'.tmp',this.file);
  });
  this.writes=write.catch(()=>{});await write;
 }
 // The host's own copy of what it presents to the account service. Never part of `view()`: the
 // panel only ever needs to know *that* this installation is linked, not what it holds.
 credentials(){return {installationId:this.state.installationId,deviceId:this.state.deviceId,token:this.state.installationToken}}
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
