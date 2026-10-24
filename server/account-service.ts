import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdirSync} from 'node:fs';
import {migrateAccountDatabase} from './account-migrations.js';
import path from 'node:path';
import {loadEnvFile} from './env.js';
import {emailConfiguration,invitationEmail,openEmail,recoveryEmail,resendTransport,sealEmail,type EmailTransport} from './email.js';
import {DEFAULT_PLATFORM_SETTINGS,isPlatformOwner,sanitizeSettings,type PlatformSettings} from './platform.js';
import {SupabaseAccountMirror,supabaseConfiguration,type SupabaseConfiguration} from './supabase-store.js';
import {
 ACCOUNT_COOKIE,ACCOUNT_TTL_MS,DEVICE_CODE_TTL_MS,DEVICE_POLL_INTERVAL_MS,
 DEFAULT_DOWNLOAD_URL,DEFAULT_DOWNLOAD_VERSION,MAX_APPLICATIONS_PER_HOUR,MAX_LOGIN_FAILURES,MIN_PASSWORD,
 accountCookie,clearedAccountCookie,digestSecret,hashToken,newToken,newUserCode,normalizeEmail,normalizeUserCode,secretMatches,
 type AccountView,type ApplicationInput,type BetaStatusView,type DeviceGrantView,type DevicePollView,type DownloadView,type LicenceCheck,
} from './beta.js';
// The hosted half of docs/BETA.md: the same REST contract the local store implements, behind a
// socket, with the state in SQLite instead of a JSON file.
//
// Why a second implementation rather than a database driver bolted onto `server/beta.ts`? Because the
// two have genuinely different jobs. The local store answers "who may broadcast from this machine"
// with a file the operator can read, back up and delete; the hosted service answers the same for
// many machines, and has to survive restarts, concurrent requests and an operator who has no shell.
// What must *not* differ is the contract: the host proxies the browser's `/api/beta/*` calls here
// untouched, the launcher talks here through the host, and `tests/account-service.test.ts` drives
// both implementations through the same steps and compares the answers field for field.
//
// Everything is JSON, legacy errors retain `{error, code}` and now add a generated requestId; success
// is the raw value — exactly as the local service answers, because the pages were written against that.
// Cookies are the same cookie.
// Digests are the same digests (scrypt for passwords, SHA-256 for every token), so a store moved
// between the two never holds a plaintext secret.
//
// Invitation and password-recovery email are delivered through an encrypted, retryable outbox. The
// service does not serve pages: the existing SCOUT SPA talks to it through SCOUT_BETA_API_URL.
export interface AccountServiceOptions {
 /** SQLite file. Default `config/account-service/accounts.sqlite`. */
 file?:string;
 /** The bearer key the host presents for the owner-only routes (`/applications*`). */
 apiKey?:string;
 port?:number;
 host?:string;
 /** What the dashboard offers as the launcher download. */
 download?:Partial<DownloadView>;
 /** Closing applications keeps sign-in and the launcher working; only `/apply` is refused. */
 applicationsOpen?:boolean;
 /** The account allowed to write /settings; service keys never substitute for its session. */
 ownerEmail?:string;
 /** The sentence the dashboard shows about the beta (the local flow uses a review note too). */
 reviewNote?:string;
 /** The name the dashboard shows as the host behind the beta. */
 serviceName?:string;
 /** Fixed clock for tests. */
 now?:()=>number;
 /** Injected only by tests; production uses the configured Resend transport. */
 emailTransport?:EmailTransport;
 emailEncryptionKey?:Buffer;
 emailBaseUrl?:string;
 invitationTtlMs?:number;
 recoveryTtlMs?:number;
 /** `Secure` on the account cookie. 'auto' sets it when the request arrived over https. */
 secureCookies?:'auto'|boolean;
 log?:(line:string)=>void;
 /** Optional Supabase configuration override; defaults to environment variables when set. */
 supabase?:SupabaseConfiguration|null;
 supabaseFetch?:typeof fetch;
}
export interface AccountService {
 server:Server;
 port:number;
 url:string;
 close():Promise<void>;
 deliverPending():Promise<void>;
 /** The same operations the HTTP surface exposes, for the CLI and for tests that want no socket. */
 db:{file:string;list():AccountView[];decide(email:string,decision:'approve'|'reject',decidedBy:string):{account:AccountView;invite:string|null}|null};
}
interface Row extends Record<string,unknown>{}
const nowMs=Date.now;
type RequestContext={requestId:string;actorType:'anonymous'|'account'|'service';actorId?:string};
const requestContext=new AsyncLocalStorage<RequestContext>();
export async function createAccountService(options:AccountServiceOptions={}):Promise<AccountService>{
 const now=options.now??nowMs;
 const log=options.log??((line:string)=>console.log(`[accounts] ${line}`));
 const supabaseConfig=options.supabase===undefined?supabaseConfiguration():options.supabase;
 const supabaseMirror=supabaseConfig?new SupabaseAccountMirror(supabaseConfig,options.supabaseFetch??fetch,log):null;
 const file=options.file??process.env.SCOUT_ACCOUNT_DB??(supabaseMirror?':memory:':path.join('config','account-service','accounts.sqlite'));
 if(file!==':memory:') mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
 const db=new DatabaseSync(file);
 // Existing installations are adopted by migration 1 without rebuilding tables; later changes are
 // strictly additive and each version commits atomically. Close the handle if startup cannot migrate.
 try{migrateAccountDatabase(db)}catch(error){db.close();throw error}
 const download:DownloadView={
  url:options.download?.url||process.env.SCOUT_DOWNLOAD_URL||DEFAULT_DOWNLOAD_URL,
  version:options.download?.version||process.env.SCOUT_DOWNLOAD_VERSION||DEFAULT_DOWNLOAD_VERSION,
  notes:options.download?.notes||process.env.SCOUT_DOWNLOAD_NOTES||'',
 };
 const apiKey=options.apiKey??process.env.SCOUT_BETA_API_KEY??'';
 const ownerEmail=options.ownerEmail??process.env.SCOUT_OWNER_EMAIL??'';
 // Environment switches seed the desk once; existing deployments keep their behaviour on upgrade.
 db.prepare('INSERT OR IGNORE INTO platform_settings (id,data) VALUES (1,?)').run(JSON.stringify({
  ...DEFAULT_PLATFORM_SETTINGS,applicationsOpen:options.applicationsOpen??process.env.SCOUT_ACCOUNT_APPLICATIONS!=='closed',
  reviewNote:options.reviewNote??process.env.SCOUT_ACCOUNT_REVIEW_NOTE??'',
 }));
 if(supabaseMirror){
  try{await supabaseMirror.hydrate(db)}catch(error){db.close();throw error}
 }
 const rawSettings=():Record<string,unknown>=>{
  try{return JSON.parse(String(db.prepare('SELECT data FROM platform_settings WHERE id = 1').get()?.data||'{}'))}catch{return {}}
 };
 const settings=():PlatformSettings=>{
  const {_platformStore:_ignored,...rest}=rawSettings();
  return {...DEFAULT_PLATFORM_SETTINGS,...(rest as Partial<PlatformSettings>)};
 };
 const serviceName=options.serviceName??options.host??process.env.SCOUT_ACCOUNT_NAME??'SCOUT account service';
 const mailConfiguration=emailConfiguration();
 const mailKey=options.emailEncryptionKey??mailConfiguration?.encryptionKey??null;
 const mailBaseUrl=(options.emailBaseUrl??mailConfiguration?.publicBaseUrl??'').replace(/\/$/,'');
 const mailTransport=options.emailTransport??(mailConfiguration?resendTransport(mailConfiguration):null);
 const invitationTtl=options.invitationTtlMs??24*60*60*1000;
 const recoveryTtl=options.recoveryTtlMs??60*60*1000;
 const secureCookies=options.secureCookies??'auto';
 // The limits are in memory on purpose (as in the local store): they exist to blunt a burst, not to
 // be an audit trail, and a restart is a legitimate way to clear them.
 const applications=new Map<string,number[]>();
 const recoveries=new Map<string,number[]>();
 const recoveryTargets=new Map<string,number[]>();
 const failures=new Map<string,{count:number;first:number}>();
 let dbDirty=false;
 const run=(sql:string,...values:unknown[])=>{
  const result=db.prepare(sql).run(...values as never[]);
  if(Number(result.changes)>0) dbDirty=true;
  return result;
 };
 const flushSupabase=async()=>{
  if(!supabaseMirror||!dbDirty) return;
  dbDirty=false;
  await supabaseMirror.flush(db);
 };
 const get=(sql:string,...values:unknown[])=>(db.prepare(sql).get(...values as never[])??null) as Row|null;
 const all=(sql:string,...values:unknown[])=>db.prepare(sql).all(...values as never[]) as Row[];
 const writeEvent=(kind:string,accountId:string|null,detail='')=>{
  // Keep the legacy event contract intact for existing admin views while adding a dedicated, indexed
  // security audit record. Do not copy legacy detail here: it may contain email addresses or codes.
  const context=requestContext.getStore();
  run('INSERT INTO events (at,kind,account_id,detail) VALUES (?,?,?,?)',now(),kind,accountId,detail);
  run('INSERT INTO audit_logs (occurred_at,request_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES (?,?,?,?,?,?,?,?)',
   now(),context?.requestId||null,context?.actorType||'service',context?.actorId||null,kind,accountId?'account':'platform',accountId||null,'{}');
 };
 const event=(kind:string,accountId:string|null,detail='')=>{
  db.exec('BEGIN IMMEDIATE');
  try{writeEvent(kind,accountId,detail);db.exec('COMMIT')}
  catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
 };
 const requireEmail=()=>{
  if(!mailTransport||!mailKey||!mailBaseUrl)
   fail(503,'email-not-configured','Email delivery is not configured. Set SCOUT_EMAIL_API_KEY, SCOUT_EMAIL_FROM, SCOUT_EMAIL_ENCRYPTION_KEY, and SCOUT_ACCOUNT_BASE_URL before approving or resending invitations.');
  return {key:mailKey,baseUrl:mailBaseUrl};
 };
 const attributeReviewer=(value:unknown)=>{
  const email=normalizeEmail(String(value||'')),context=requestContext.getStore();
  if(email&&context&&(isPlatformOwner(email,{SCOUT_OWNER_EMAIL:ownerEmail})||settings().betaReviewers.includes(email))){context.actorType='account';context.actorId=email}
  return String(value||'operator').slice(0,254);
 };
 const queueEmail=(template:'invitation'|'password_recovery',accountId:string,message:ReturnType<typeof invitationEmail>|ReturnType<typeof recoveryEmail>)=>{
  const {key}=requireEmail();
  const id=randomUUID(),encrypted=sealEmail(message,key!),moment=now();
  run('INSERT INTO email_outbox (id,template,recipient_digest,payload_ciphertext,payload_iv,payload_tag,created_at,next_attempt_at) VALUES (?,?,?,?,?,?,?,?)',
   id,template,hashToken(normalizeEmail(message.to)),encrypted.ciphertext,encrypted.iv,encrypted.tag,moment,moment);
  return id;
 };
 let delivering=false;
 async function deliverPending(onlyId?:string){
  if(delivering||!mailTransport||!mailKey)return;
  delivering=true;
  try{
   const pending=onlyId?all('SELECT * FROM email_outbox WHERE id = ? AND sent_at IS NULL',onlyId):all('SELECT * FROM email_outbox WHERE sent_at IS NULL AND next_attempt_at <= ? ORDER BY created_at LIMIT 20',now());
   for(const item of pending){
    try{
     const message=openEmail({ciphertext:String(item.payload_ciphertext),iv:String(item.payload_iv),tag:String(item.payload_tag)},mailKey);
     await mailTransport(message,String(item.id));
     run('UPDATE email_outbox SET sent_at = ?, payload_ciphertext = \'\', payload_iv = \'\', payload_tag = \'\', last_error_code = NULL WHERE id = ? AND sent_at IS NULL',now(),item.id);
     log(`email delivery ${String(item.id)} completed`);
    }catch(error){
     const attempts=Number(item.attempts)+1,delay=[60_000,5*60_000,15*60_000,60*60_000,6*60*60_000][Math.min(attempts-1,4)];
     const status=Number((error as {status?:unknown})?.status||0);
     const errorCode=status>=400&&status<500&&status!==429?'provider-rejected':'transient';
     run('UPDATE email_outbox SET attempts = ?,next_attempt_at = ?,last_error_code = ? WHERE id = ? AND sent_at IS NULL',attempts,now()+delay,errorCode,item.id);
     log(`email delivery ${String(item.id)} deferred (${errorCode})`);
    }
   }
   await flushSupabase();
  }finally{delivering=false}
 }


 // ---------------------------------------------------------------- reading accounts
 function accountRow(id:string){return get('SELECT * FROM accounts WHERE id = ?',id)}
 function deviceViews(accountId:string):AccountView['devices']{
  return all('SELECT id,label,platform,created_at,last_seen_at FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at',accountId)
   .map(row=>({id:String(row.id),label:String(row.label),platform:String(row.platform),createdAt:Number(row.created_at),lastSeenAt:Number(row.last_seen_at)}));
 }
 function view(row:Row):AccountView{
  return {
   id:String(row.id),email:String(row.email),displayName:String(row.display_name),organisation:String(row.organisation),
   country:String(row.country),status:String(row.status) as AccountView['status'],useCase:String(row.use_case),events:String(row.events),
   createdAt:Number(row.created_at),decidedAt:row.decided_at===null?null:Number(row.decided_at),devices:deviceViews(String(row.id)),
  };
 }
 function grantInvite(accountId:string,decidedBy:string){
  const {baseUrl}=requireEmail();
  const row=accountRow(accountId);
  if(!row) return null;
  const invite=newToken(32),expiresAt=now()+invitationTtl;
  run('UPDATE accounts SET status = ?, decided_at = ?, decided_by = ?, invite_digest = ?, invite_expires_at = ?, activated_at = NULL WHERE id = ?',
   'approved',now(),decidedBy,hashToken(invite),expiresAt,accountId);
  run('INSERT OR IGNORE INTO account_roles (account_id,role,granted_at,granted_by) VALUES (?,?,?,?)',accountId,'user',now(),decidedBy);
  const url=`${baseUrl}/login?invite=${encodeURIComponent(invite)}`;
  queueEmail('invitation',accountId,invitationEmail(String(row.email),String(row.display_name),url,expiresAt));
  return invite;
 }
 function decide(id:string,decision:'approve'|'reject',decidedBy:string){
  db.exec('BEGIN IMMEDIATE');
  try{
   const row=accountRow(id);
   if(!row){db.exec('COMMIT');return null}
   if(String(row.status)==='rejected'||(decision==='approve'&&String(row.status)!=='pending'))fail(409,'already-decided',String(row.status)==='rejected'?'A rejected application is terminal. A new application is required.':'Only pending applications can be approved. Use the resend-invitation action for an unactivated approved account.');
   const invite=decision==='approve'?grantInvite(id,decidedBy):null;
   if(decision==='reject'){
    run('UPDATE accounts SET status = ?, decided_at = ?, decided_by = ?, invite_digest = NULL, invite_expires_at = NULL WHERE id = ?','rejected',now(),decidedBy,id);
    run('DELETE FROM sessions WHERE account_id = ?',id);
   }
   writeEvent(`application.${decision}`,id);
   db.exec('COMMIT');
   void flushSupabase().catch(()=>{});
   return {account:view(accountRow(id)!),invite};
  }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
 }
 // Sessions are rows with a hashed id: the cookie value itself is never stored, so a database copy
 // cannot be replayed as a sign-in.
 function sessionAccount(cookieId:string|undefined){
  if(!cookieId) return null;
  const row=get('SELECT * FROM sessions WHERE id = ?',hashToken(cookieId));
  if(!row) return null;
  if(Number(row.last_seen_at)+ACCOUNT_TTL_MS<now()||Number(row.created_at)+ACCOUNT_TTL_MS<now()){
   run('DELETE FROM sessions WHERE id = ?',row.id);
   return null;
  }
  run('UPDATE sessions SET last_seen_at = ? WHERE id = ?',now(),row.id);
  const account=accountRow(String(row.account_id));
  return account?{session:row,account}:null;
 }
 function issueSession(accountId:string,address:string,userAgent:string){
  const cookieId=newToken(24);
  run('INSERT INTO sessions (id,account_id,created_at,last_seen_at,address,user_agent) VALUES (?,?,?,?,?,?)',
   hashToken(cookieId),accountId,now(),now(),address.slice(0,60),(userAgent||'').slice(0,120));
  return cookieId;
 }
 function reap(){
  const moment=now();
  run('DELETE FROM sessions WHERE created_at + ? < ?',ACCOUNT_TTL_MS,moment);
  run('DELETE FROM grants WHERE (status = ? AND expires_at < ?) OR (status != ? AND created_at + ? < ?)','pending',moment,'pending',DEVICE_CODE_TTL_MS,moment);
 }
 // ---------------------------------------------------------------- the HTTP surface
 class HttpError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message)}}
 const fail=(status:number,code:string,message:string):never=>{throw new HttpError(status,code,message)};
 // Central authorization boundaries for the raw Node HTTP service. They deliberately preserve the
 // existing cookie/service-key contract while ensuring future routes use the same checks.
 function requireServiceKey(req:IncomingMessage){
  checkServiceKey(req);
  const context=requestContext.getStore();if(context){context.actorType='service';delete context.actorId}
 }
 function setAccountActor(accountId:string){const context=requestContext.getStore();if(context){context.actorType='account';context.actorId=accountId}}
 function requireAccount(req:IncomingMessage,message='Sign in with your SCOUT account first.'){
  const authenticated=sessionAccount(cookieId(req));
  if(!authenticated)return fail(401,'no-session',message);
  setAccountActor(String(authenticated.account.id));
  return authenticated;
 }
 function requireOwnerAccount(req:IncomingMessage){
  const current=requireAccount(req,'Sign in as the SCOUT owner to change platform settings.');
  if(current.account.status!=='approved'||current.account.activated_at===null||!isPlatformOwner(String(current.account.email),{SCOUT_OWNER_EMAIL:ownerEmail}))
   return fail(403,'not-platform-owner','Only the SCOUT owner may change platform settings.');
  return current;
 }
 function requireSameOrigin(req:IncomingMessage){
  const origin=req.headers.origin;
  if(!origin)return;
  try{if(new URL(origin).host!==req.headers.host)fail(403,'untrusted-origin','Cross-site settings requests are refused.')}catch(error){
   if(error instanceof HttpError)throw error;
   fail(403,'untrusted-origin','Cross-site settings requests are refused.');
  }
 }
 async function body(req:IncomingMessage):Promise<any>{
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of req){size+=(chunk as Buffer).length;if(size>256*1024) fail(413,'payload-too-large','That request body is too large.');chunks.push(chunk as Buffer)}
  if(!size) return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  catch{fail(400,'invalid-payload','The request body is not valid JSON.')}
 }
 const cookieId=(req:IncomingMessage)=>{
  const header=req.headers.cookie||'';
  for(const part of header.split(';')){const [name,...rest]=part.trim().split('=');if(name===ACCOUNT_COOKIE)return decodeURIComponent(rest.join('='))}
  return undefined;
 };
 const address=(req:IncomingMessage)=>req.socket.remoteAddress||'unknown';
 function setCookie(res:ServerResponse,req:IncomingMessage,value:string,ttlMs:number){
  const secure=secureCookies==='auto'?String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https'||Boolean((req.socket as any).encrypted):secureCookies;
  res.setHeader('Set-Cookie',value?accountCookie(value,ttlMs,secure):clearedAccountCookie(secure));
 }
 async function json(res:ServerResponse,status:number,value:unknown){
  if(status<500&&supabaseMirror&&dbDirty){
   try{await flushSupabase()}catch(error){
    const requestId=requestContext.getStore()?.requestId||'unknown';
    const errorType=error instanceof Error?error.name:'UnknownError';
    log(`request ${requestId} failed (${errorType})`);
    const errText=JSON.stringify({error:'The account service hit an unexpected error.',code:'internal',requestId});
    res.writeHead(500,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(errText),'Cache-Control':'no-store'});
    res.end(errText);
    return;
   }
  }
  const text=JSON.stringify(value);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(text),'Cache-Control':'no-store'});
  res.end(text);
 }
 // A launcher code brings its own throttle: at most 20 pending at a time, started from one address per
 // minute. Codes are cheap to mint but not free to guess, and a human has to approve one anyway.
 function checkServiceKey(req:IncomingMessage){
  if(!apiKey) fail(503,'service-key-required','This account service has no SCOUT_BETA_API_KEY set, so the owner-only routes are closed.');
  const header=req.headers.authorization||'';
  const candidate=header.startsWith('Bearer ')?header.slice(7):'';
  const expectedDigest=createHash('sha256').update(apiKey).digest();
  const candidateDigest=createHash('sha256').update(candidate).digest();
  if(!header.startsWith('Bearer ')||!timingSafeEqual(candidateDigest,expectedDigest)) fail(401,'bad-service-key','The service key is missing or wrong.');
 }
 const server=createServer((req,res)=>{
  const requestId=randomUUID();
  res.setHeader('X-Request-Id',requestId);
  requestContext.run({requestId,actorType:'anonymous'},()=>{
  void (async()=>{
   try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    const route=url.pathname.replace(/\/+$/,'')||'/';
    const method=req.method||'GET';
    const userAgent=String(req.headers['user-agent']||'');
    reap();
    if(method==='GET'&&route==='/healthz'){const accounts=(get('SELECT COUNT(*) AS n FROM accounts')!.n as number);return json(res,200,{ok:true,accounts,pending:Number(get('SELECT COUNT(*) AS n FROM accounts WHERE status = ?','pending')!.n),devices:Number(get('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL')!.n),emailDeliveryConfigured:Boolean(mailTransport&&mailKey&&mailBaseUrl),emailOutboxPending:Number(get('SELECT COUNT(*) AS n FROM email_outbox WHERE sent_at IS NULL')!.n)})}
    if(route==='/settings'&&method==='GET'){requireServiceKey(req);return json(res,200,{settings:settings()})}
    if(route==='/settings'&&method==='PUT'){
     requireSameOrigin(req);
     const current=requireOwnerAccount(req);
     const next=sanitizeSettings(await body(req),settings(),String(current.account.email),now());
     db.exec('BEGIN IMMEDIATE');
     try{
      const existing=rawSettings();
      const persisted=existing._platformStore!==undefined?{...next,_platformStore:existing._platformStore}:next;
      run('UPDATE platform_settings SET data = ? WHERE id = 1',JSON.stringify(persisted));
      const reviewerSet=new Set(next.betaReviewers);
      for(const account of all('SELECT id,normalized_email FROM accounts')){
       if(reviewerSet.has(String(account.normalized_email)))run('INSERT OR IGNORE INTO account_roles (account_id,role,granted_at,granted_by) VALUES (?,?,?,?)',account.id,'beta_reviewer',now(),current.account.id);
       else run('DELETE FROM account_roles WHERE account_id = ? AND role = ?',account.id,'beta_reviewer');
      }
      writeEvent('settings.updated',String(current.account.id),`v${next.version}`);
      db.exec('COMMIT');
     }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
     return json(res,200,{settings:next});
    }
    if(method==='GET'&&route==='/status'){
     const {applicationsOpen,reviewNote}=settings();
     const current=sessionAccount(cookieId(req));
     const account=current?accountRow(String(current.account.id)):null;
     const answer:BetaStatusView={
      mode:'hosted',applicationsOpen,signedIn:Boolean(account),
      account:account?view(account):null,
      // The download is only offered to an approved account — the gate lives here, not in the page.
      download:account&&String(account.status)==='approved'?download:null,
      host:serviceName,reviewNote,
     };
     return json(res,200,answer);
    }
    // Applying is the one write a stranger may make. Rate limited per address; a duplicate address is
    // told to sign in rather than told what the address is.
    if(method==='POST'&&route==='/apply'){
     if(!settings().applicationsOpen) fail(403,'applications-closed','The closed beta is not taking new applications right now.');
     const input=(await body(req)) as Partial<ApplicationInput>&{address?:string};
     const email=normalizeEmail(String(input.email||''));
     if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400,'bad-email','That does not look like an email address.');
     if(String(input.name||'').trim().length<2) fail(400,'bad-name','Tell us the name to put on the account.');
     const from=String(input.address||address(req));
     const stamps=(applications.get(from)||[]).filter(stamp=>now()-stamp<60*60*1000);
     if(stamps.length>=MAX_APPLICATIONS_PER_HOUR) fail(429,'throttled','That address has sent several applications already. Try again in an hour.');
     const existing=get('SELECT * FROM accounts WHERE normalized_email = ?',email);
     if(existing){
      if(String(existing.status)==='approved') fail(409,'already-approved','That address already has an approved account — sign in, or open the invite link from your approval.');
      fail(409,'already-applied','That address already has an application in review. Sign in if you have already set a password.');
     }
     const id=newToken(12);
     db.exec('BEGIN IMMEDIATE');
     try{
      run(`INSERT INTO accounts (id,email,normalized_email,display_name,organisation,country,use_case,events,status,password,created_at,decided_at,decided_by)
           VALUES (?,?,?,?,?,?,?,?,?,NULL,?,NULL,'')`,
       id,email,email,String(input.name||'').trim().slice(0,80),String(input.organisation||'').trim().slice(0,120),
       String(input.country||'').trim().slice(0,60),String(input.useCase||'').trim().slice(0,600),String(input.events||'').trim().slice(0,80),
       'pending',now());
      writeEvent('application',id);
      db.exec('COMMIT');
     }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
     stamps.push(now());applications.set(from,stamps);
     log('a beta application was submitted');
     return json(res,200,{account:view(accountRow(id)!),invite:null});
    }
    if(method==='POST'&&route==='/login'){
     const input=await body(req);
     const email=normalizeEmail(String(input.email||''));
     const from=address(req);
     const record=failures.get(from);
     if(record&&record.count>=MAX_LOGIN_FAILURES&&now()-record.first<15*60*1000)
      fail(429,'throttled',`Too many failed sign-ins from ${from}. Try again in ${Math.ceil((15*60*1000-(now()-record.first))/60000)} minute(s).`);
     const row=get('SELECT * FROM accounts WHERE normalized_email = ?',email);
     if(!row||!secretMatches(String(input.password||''),row.password?parseSecret(String(row.password)):null)){
      const next=!record||now()-record.first>15*60*1000?{count:1,first:now()}:{count:record.count+1,first:record.first};
      failures.set(from,next);
      fail(401,'bad-credentials','That email address and password do not match an account.');
     }
     const status=String(row!.status);
     if(status!=='approved') fail(403,status==='pending'?'pending-review':'rejected',status==='pending'?'This application is still in review. We will email you if it is approved.':'This application was not approved for the closed beta.');
     if(row!.activated_at===null)fail(401,'bad-credentials','That email address and password do not match an activated account.');
     failures.delete(from);
     run('UPDATE accounts SET last_login_at = ? WHERE id = ?',now(),row!.id);
     const cookie=issueSession(String(row!.id),from,userAgent);
     setAccountActor(String(row!.id));
     event('sign-in',String(row!.id),email);
     setCookie(res,req,cookie,ACCOUNT_TTL_MS);
     return json(res,200,{account:view(accountRow(String(row!.id))!)});
    }
    if(method==='POST'&&route==='/logout'){
     const cookie=cookieId(req);
     if(cookie) run('DELETE FROM sessions WHERE id = ?',hashToken(cookie));
     setCookie(res,req,'',0);
     return json(res,200,{ok:true});
    }
    // Invite acceptance is deliberately a single-use, time-limited, transactional transition.
    if(method==='POST'&&route==='/activate'){
     const input=await body(req);
     const password=String(input.password||'');
     if(password.length<MIN_PASSWORD) fail(400,'weak-password',`Choose a password of at least ${MIN_PASSWORD} characters.`);
     const digest=hashToken(String(input.invite||'').trim());
     const candidate=get('SELECT * FROM accounts WHERE invite_digest = ?',digest);
     if(!candidate||String(candidate.status)!=='approved'||candidate.activated_at!==null)
      fail(401,'bad-invite','That invite link is not valid. Ask the SCOUT team for a replacement invitation.');
     if(candidate!.invite_expires_at!==null&&Number(candidate!.invite_expires_at)<now()){
      run('UPDATE accounts SET invite_digest = NULL, invite_expires_at = NULL WHERE id = ? AND invite_digest = ?',candidate!.id,digest);
      fail(401,'expired-invite','That invite link has expired. Ask the SCOUT team for a replacement invitation.');
     }
     const secret=digestSecret(password),accountId=String(candidate!.id);
     db.exec('BEGIN IMMEDIATE');
     try{
      const current=get('SELECT * FROM accounts WHERE id = ? AND invite_digest = ?',accountId,digest);
      if(!current||String(current.status)!=='approved'||current.activated_at!==null)fail(401,'bad-invite','That invite link is not valid. Ask the SCOUT team for a replacement invitation.');
      if(current!.invite_expires_at!==null&&Number(current!.invite_expires_at)<now())fail(401,'expired-invite','That invite link has expired. Ask the SCOUT team for a replacement invitation.');
      run('UPDATE accounts SET password = ?, invite_digest = NULL, invite_expires_at = NULL, activated_at = ? WHERE id = ?',`${secret.salt}:${secret.digest}`,now(),accountId);
      run('INSERT OR IGNORE INTO account_roles (account_id,role,granted_at,granted_by) VALUES (?,?,?,?)',accountId,'user',now(),'activation');
      if(settings().betaReviewers.includes(normalizeEmail(String(current!.email))))run('INSERT OR IGNORE INTO account_roles (account_id,role,granted_at,granted_by) VALUES (?,?,?,?)',accountId,'beta_reviewer',now(),'platform-settings');
      const cookie=issueSession(accountId,address(req),userAgent);
      setAccountActor(accountId);writeEvent('account.activated',accountId);
      db.exec('COMMIT');
      setCookie(res,req,cookie,ACCOUNT_TTL_MS);
      return json(res,200,{account:view(accountRow(accountId)!)});
     }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
    }
    if(method==='POST'&&route==='/password-recovery'){
     requireEmail();
     const input=await body(req),email=normalizeEmail(String(input.email||'')),from=address(req);
     const stamps=(recoveries.get(from)||[]).filter(stamp=>now()-stamp<60*60*1000);
     if(stamps.length>=5)fail(429,'throttled','Too many password recovery requests. Wait before trying again.');
     stamps.push(now());recoveries.set(from,stamps);
     // Apply the same address-level limit before lookup and keep all valid addresses on the same response path.
     const validEmail=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
     const targetKey=validEmail?hashToken(email):'';
     let targetStamps=validEmail?(recoveryTargets.get(targetKey)||[]).filter(stamp=>now()-stamp<60*60*1000):[];
     const targetLimited=validEmail&&targetStamps.length>=5;
     if(validEmail&&!targetLimited){targetStamps.push(now());recoveryTargets.set(targetKey,targetStamps)}
     // Respond identically for unknown, unactivated and eligible addresses.
     if(validEmail&&!targetLimited){
      const account=get("SELECT * FROM accounts WHERE normalized_email = ? AND status = 'approved' AND activated_at IS NOT NULL",email);
      if(account){
       const token=newToken(32),expiresAt=now()+recoveryTtl;
       db.exec('BEGIN IMMEDIATE');
       try{
        run('DELETE FROM password_recovery_tokens WHERE account_id = ?',account.id);
        run('INSERT INTO password_recovery_tokens (token_digest,account_id,created_at,expires_at) VALUES (?,?,?,?)',hashToken(token),account.id,now(),expiresAt);
        const url=`${mailBaseUrl}/login?reset=${encodeURIComponent(token)}`;
        queueEmail('password_recovery',String(account.id),recoveryEmail(String(account.email),String(account.display_name),url,expiresAt));
        writeEvent('password-recovery.issued',String(account.id));
        db.exec('COMMIT');
       }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
      }
     }
     // Do not make response latency depend on whether this address has an account or on provider latency.
     void deliverPending();
     return json(res,200,{ok:true,message:'If the address belongs to an activated SCOUT account, a password reset email will be sent.'});
    }
    if(method==='POST'&&route==='/password-recovery/complete'){
     const input=await body(req),password=String(input.password||''),token=String(input.token||'').trim();
     if(password.length<MIN_PASSWORD)fail(400,'weak-password',`Choose a password of at least ${MIN_PASSWORD} characters.`);
     const secret=digestSecret(password),tokenDigest=hashToken(token),candidate=get('SELECT * FROM password_recovery_tokens WHERE token_digest = ? AND used_at IS NULL',tokenDigest);
     if(!candidate||Number(candidate.expires_at)<now())fail(400,'invalid-recovery-token','That password reset link is invalid or has expired. Request a new one.');
     const accountId=String(candidate!.account_id);
     db.exec('BEGIN IMMEDIATE');
     try{
      const current=get('SELECT * FROM password_recovery_tokens WHERE token_digest = ? AND used_at IS NULL',tokenDigest);
      if(!current||Number(current.expires_at)<now())fail(400,'invalid-recovery-token','That password reset link is invalid or has expired. Request a new one.');
      run('UPDATE accounts SET password = ? WHERE id = ? AND status = \'approved\' AND activated_at IS NOT NULL',`${secret.salt}:${secret.digest}`,accountId);
      run('UPDATE password_recovery_tokens SET used_at = ? WHERE token_digest = ?',now(),tokenDigest);
      run('DELETE FROM password_recovery_tokens WHERE account_id = ? AND token_digest != ?',accountId,tokenDigest);
      run('DELETE FROM sessions WHERE account_id = ?',accountId);
      setAccountActor(accountId);writeEvent('password-recovery.completed',accountId);
      db.exec('COMMIT');
     }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
     return json(res,200,{ok:true,message:'Your password has been reset. Sign in with your new password.'});
    }
    if(route==='/applications'&&method==='GET'){
     requireServiceKey(req);
     const rows=all('SELECT * FROM accounts ORDER BY created_at DESC');
     const invitations:Record<string,unknown>={};
     for(const row of rows){
      const invite=get('SELECT * FROM email_outbox WHERE template = ? AND recipient_digest = ? ORDER BY created_at DESC LIMIT 1','invitation',hashToken(normalizeEmail(String(row.email))));
      if(invite)invitations[String(row.id)]={status:invite.sent_at===null?'pending':'sent',activated:row.activated_at!==null,expiresAt:row.invite_expires_at===null?null:Number(row.invite_expires_at),sentAt:invite.sent_at===null?null:Number(invite.sent_at),attempts:Number(invite.attempts),errorCode:invite.last_error_code||null};
     }
     return json(res,200,{applications:rows.map(view),invitations});
    }
    const resend=route.match(/^\/applications\/([^/]+)\/resend-invitation$/);
    if(resend&&method==='POST'){
     requireServiceKey(req);
     const input=await body(req);
     const id=decodeURIComponent(resend[1]),row=accountRow(id);
     if(!row)fail(404,'not-found','That application no longer exists.');
     if(String(row!.status)!=='approved'||row!.activated_at!==null)fail(409,'invitation-not-available','A replacement invitation is only available to approved accounts that have not activated.');
     db.exec('BEGIN IMMEDIATE');
     try{
      run('DELETE FROM email_outbox WHERE template = ? AND recipient_digest = ? AND sent_at IS NULL','invitation',hashToken(normalizeEmail(String(row!.email))));
      const invite=grantInvite(id,attributeReviewer(input.requestedBy));
      writeEvent('invitation.resent',id);
      db.exec('COMMIT');
      await deliverPending();
      const delivery=get('SELECT sent_at,attempts,last_error_code FROM email_outbox WHERE template = ? AND recipient_digest = ? ORDER BY created_at DESC LIMIT 1','invitation',hashToken(normalizeEmail(String(row!.email))));
      return json(res,200,{account:view(accountRow(id)!),invite,invitationDelivery:{status:delivery?.sent_at===null?'pending':'sent',attempts:Number(delivery?.attempts||0),errorCode:delivery?.last_error_code||null}});
     }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
    }
    const decision=route.match(/^\/applications\/([^/]+)$/);
    if(decision&&method==='POST'){
     requireServiceKey(req);
     const input=await body(req);
     if(input.decision!=='approve'&&input.decision!=='reject') fail(400,'invalid-decision','A decision is approve or reject.');
     const result=decide(decodeURIComponent(decision[1]),input.decision,attributeReviewer(input.decidedBy));
     if(!result) fail(404,'not-found','That application no longer exists.');
     if(input.decision==='approve')await deliverPending();
     const delivery=input.decision==='approve'?get('SELECT sent_at,attempts,last_error_code FROM email_outbox WHERE template = ? AND recipient_digest = ? ORDER BY created_at DESC LIMIT 1','invitation',hashToken(normalizeEmail(result!.account.email))):null;
     return json(res,200,{...result,invitationDelivery:delivery?{status:delivery.sent_at===null?'pending':'sent',attempts:Number(delivery.attempts||0),errorCode:delivery.last_error_code||null}:null});
    }

    // ---- the launcher's half
    if(method==='POST'&&route==='/device/start'){
     const input=await body(req);
     const moment=now();
     const pending=Number(get('SELECT COUNT(*) AS n FROM grants WHERE status = ? AND created_at > ?','pending',moment-60*60*1000)!.n);
     if(pending>=20) fail(429,'throttled','Too many pending launcher codes. Approve or wait for the existing ones to expire.');
     let userCode=newUserCode();
     for(let attempt=0;attempt<5&&get('SELECT 1 AS x FROM grants WHERE user_code = ? AND status = ?',normalizeUserCode(userCode),'pending');attempt++) userCode=newUserCode();
     const deviceCode=newToken(32);
     run('INSERT INTO grants (device_code,user_code,label,platform,origin,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?)',
      hashToken(deviceCode),normalizeUserCode(userCode),String(input.label||'').slice(0,60),String(input.platform||'').slice(0,40),String(input.origin||'').slice(0,200),moment,moment+DEVICE_CODE_TTL_MS,'pending');
     const base=String(input.origin||'').replace(/\/$/,'');
     const answer:DeviceGrantView={userCode,deviceCode,expiresAt:moment+DEVICE_CODE_TTL_MS,interval:DEVICE_POLL_INTERVAL_MS,verificationUrl:`${base}/login?link=${encodeURIComponent(userCode)}`};
     log('a launcher pairing request was created');
     return json(res,200,answer);
    }
    if(method==='POST'&&route==='/device/poll'){
     const input=await body(req);
     const grant=get('SELECT * FROM grants WHERE device_code = ?',hashToken(String(input.deviceCode||'')));
     if(!grant) fail(404,'unknown-code','That launcher code is not known to this service. Start a new link.');
     const status=String(grant!.status);
     if(status==='pending'&&Number(grant!.expires_at)<now()) return json(res,200,{status:'expired'} as DevicePollView);
     if(status!=='approved'||!grant!.account_id) return json(res,200,{status:status==='denied'?'denied':'pending'} as DevicePollView);
     const account=accountRow(String(grant!.account_id));
     const accountView=account?{email:String(account.email),displayName:String(account.display_name)}:undefined;
     const deviceId=grant!.device_id?String(grant!.device_id):undefined;
     // Handed over exactly once, then the plaintext is gone: `devices.token_digest` is what proves the
     // installation from then on, and a launcher that missed the collection starts a new link.
     if(grant!.pending_token){
      const token=String(grant!.pending_token);
      run('UPDATE grants SET pending_token = NULL, claimed_at = ? WHERE device_code = ?',now(),grant!.device_code);
      run('UPDATE devices SET last_seen_at = ? WHERE id = ?',now(),deviceId);
      event('launcher.linked',String(grant!.account_id),deviceId||'');
      log('a launcher installation was linked');
      return json(res,200,{status:'approved',installationToken:token,deviceId,account:accountView} as DevicePollView);
     }
     return json(res,200,{status:'approved',deviceId,account:accountView} as DevicePollView);
    }
    if((route==='/device/approve'||route==='/device/deny')&&method==='POST'){
     const input=await body(req);
     const current=requireAccount(req,'Sign in with your SCOUT account before approving a launcher.');
     if(String(current.account.status)!=='approved') fail(403,'pending-review','Your account is not approved yet, so it cannot link a launcher.');
     const code=normalizeUserCode(String(input.userCode||''));
     const grant=get('SELECT * FROM grants WHERE user_code = ?',code);
     if(!grant) fail(404,'unknown-code','No launcher is waiting with that code. Copy it from the launcher window.');
     if(Number(grant!.expires_at)<now()&&String(grant!.status)==='pending') fail(410,'expired-code','That code has expired. Start a new link in the launcher.');
     if(String(grant!.status)!=='pending') fail(409,'already-decided',String(grant!.status)==='approved'?'That launcher is already linked.':'That code was already refused.');
     if(route==='/device/deny'){
      run('UPDATE grants SET status = ? WHERE device_code = ?','denied',grant!.device_code);
      event('launcher.denied',String(current!.account.id),code);
      return json(res,200,{account:view(current!.account)});
     }
     const token=newToken(32);
     const deviceId=newToken(12);
     run('INSERT INTO devices (id,account_id,label,platform,created_at,last_seen_at,revoked_at,token_digest) VALUES (?,?,?,?,?,?,NULL,?)',
      deviceId,String(current!.account.id),String(grant!.label)||'SCOUT launcher',String(grant!.platform)||'windows',now(),now(),hashToken(token));
     run('UPDATE grants SET status = ?, account_id = ?, device_id = ?, pending_token = ? WHERE device_code = ?',
      'approved',String(current!.account.id),deviceId,token,grant!.device_code);
     event('launcher.approved',String(current!.account.id),code);
     return json(res,200,{account:view(current!.account)});
    }
    if(method==='POST'&&route==='/devices/revoke'){
     const input=await body(req);
     const current=requireAccount(req);
     const deviceId=String(input.deviceId||'').trim();
     const device=deviceId?get('SELECT * FROM devices WHERE id = ? AND account_id = ? AND revoked_at IS NULL',deviceId,String(current.account.id)):null;
     if(!device) fail(404,'not-found','That launcher is not linked to this account.');
     run('UPDATE devices SET revoked_at = ? WHERE id = ?',now(),deviceId);
     event('launcher.revoked',String(current!.account.id),deviceId);
     log('a launcher installation was unlinked');
     return json(res,200,{account:view(current!.account)});
    }
    // What a running installation asks about itself. This answer is read by the launcher's licence
    // check (server/licensing.ts, src-tauri/core/src/licence.rs) and never by a page, so it takes the
    // installation's own token rather than a browser cookie. A wrong token or an unknown device is
    // `revoked`, not an error: the launcher must be able to tell "not entitled" from "did not ask".
    if(method==='POST'&&route==='/license/check'){
     const input=await body(req);
     if(input.resolveAccount)checkServiceKey(req); // internal identity extension, not a browser/licence field
     const deviceId=String(input.deviceId||'');
     const token=String(input.token||'');
     const device=deviceId?get('SELECT * FROM devices WHERE id = ?',deviceId):null;
     if(!device) return json(res,200,{status:'unknown'} as LicenceCheck);
     const account=accountRow(String(device.account_id));
     const refused:LicenceCheck={status:'revoked',email:account?String(account.email):undefined,displayName:account?String(account.display_name):undefined};
     if(device.revoked_at!==null) return json(res,200,refused);
     if(!token||hashToken(token)!==String(device.token_digest)) return json(res,200,refused);
     run('UPDATE devices SET last_seen_at = ? WHERE id = ?',now(),deviceId);
     if(!account||String(account.status)!=='approved') return json(res,200,refused);
     return json(res,200,{status:'active',email:String(account.email),displayName:String(account.display_name),...(input.resolveAccount?{accountId:String(account.id)}:{})} as LicenceCheck);
    }
    fail(404,'not-found',`This account service has no ${method} ${route}. The contract is in docs/BETA.md.`);
   }catch(error:any){
    const requestId=requestContext.getStore()?.requestId||'unknown';
    if(error instanceof HttpError) return json(res,error.status,{error:error.message,code:error.code,requestId});
    // Error messages may contain SQL, request bodies or credential-adjacent details. Keep them out of
    // routine logs; operators can correlate this safe class-only record with the response request ID.
    const errorType=error instanceof Error?error.name:'UnknownError';
    log(`request ${requestId} failed (${errorType})`);
    return json(res,500,{error:'The account service hit an unexpected error.',code:'internal',requestId});
   }
  })();
  });
 });
 const listenHost=options.host??process.env.HOST??'0.0.0.0';
 const port=options.port??Number(process.env.PORT||8790);
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,listenHost,()=>{server.off('error',reject);resolve()});
 });
 const bound=server.address();
 const actualPort=typeof bound==='object'&&bound?bound.port:port;
 const outboxTimer=setInterval(()=>{void deliverPending()},30_000);outboxTimer.unref();
 return {
  server,port:actualPort,url:`http://127.0.0.1:${actualPort}`,deliverPending:()=>deliverPending(),
  // Idempotent: a supervisor may stop the service twice, and the tests close it by hand to read the
  // file before the runner tears it down.
  async close(){
   clearInterval(outboxTimer);
   await flushSupabase().catch(()=>{});
   await new Promise<void>(resolve=>{try{server.close(()=>resolve())}catch{resolve()}});
   try{db.close()}catch{}
  },
  db:{file,list:()=>all('SELECT * FROM accounts ORDER BY created_at DESC').map(view),decide},
 };
}
// A password digest is stored as `salt:digest` — the same scrypt digest the local store keeps, so a
// store can be moved between the two without re-hashing anything.
function parseSecret(value:string){const [salt,digest]=value.split(':');return salt&&digest?{salt,digest}:null}
// ------------------------------------------------------------------ running it
// `npm run account-service` (or `tsx server/account-service.ts`) starts the service. The two flags
// exist for a deployment with no panel handy: list applications or approve one and queue its invitation email.
// `isEntry` rather than a bare import-time start, so importing this module (the tests do, to drive
// the same store without a socket) never starts a listener or runs a CLI command.
const isEntry=Boolean(process.argv[1])&&/account-service\.ts$/.test(process.argv[1]);
if(isEntry){
 // Same optional `.env` as the host (copy .env.example), so a service key and the owner email can
 // live in one file instead of a shell wrapper. Real environment variables win.
 loadEnvFile();
 const flags=process.argv.slice(2);
 const service=await createAccountService({}).catch(error=>{console.error(`[accounts] could not start: ${error.message}`);process.exit(1)});
 if(flags.includes('--list')){
  for(const account of service.db.list()) console.log(`${account.status.padEnd(9)} ${account.email.padEnd(32)} ${new Date(account.createdAt).toISOString().slice(0,10)} ${account.organisation}`);
  await service.close();process.exit(0);
 }
 const invite=flags.indexOf('--approve');
 if(invite>=0){
  const email=normalizeEmail(flags[invite+1]||'');
  const row=service.db.list().find(account=>account.email===email);
  if(!row){console.error(`[accounts] no application for ${email}`);await service.close();process.exit(1)}
  try{
   service.db.decide(row.id,'approve','command line');
   await service.deliverPending();
   console.log(`[accounts] approved ${email}; invitation delivery was attempted. Any transient provider failure is queued for automatic retry.`);
  }catch(error){
   console.error(`[accounts] approval failed: ${error instanceof Error?error.message:'unexpected error'}`);
   await service.close();process.exit(1);
  }
  await service.close();process.exit(0);
 }
 console.log(`[accounts] account service listening on ${service.url} (SQLite: ${service.db.file}, ${service.db.list().length} account(s))`);
 console.log(`[accounts] point the SCOUT host here: SCOUT_BETA_API_URL=${service.url.replace('127.0.0.1','<this machine>')} and set the same SCOUT_BETA_API_KEY on both.`);
 if(!process.env.SCOUT_BETA_API_KEY) console.log('[accounts] warning: SCOUT_BETA_API_KEY is not set, so the owner-only routes (/applications) are closed.');
}
