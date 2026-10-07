import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
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
// Everything is JSON, errors are `{error, code}`, and success is the raw value — exactly as the
// local service answers, because the pages were written against that. Cookies are the same cookie.
// Digests are the same digests (scrypt for passwords, SHA-256 for every token), so a store moved
// between the two never holds a plaintext secret.
//
// What this deliberately does not do: send email (the operator copies the invite link, exactly as the
// local flow prints it), reset passwords (a new invite is the reset), or serve any page. It is an
// account service, not a website — the website is the same SPA the host serves, pointed at this
// service with SCOUT_BETA_API_URL.
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
 /** The sentence the dashboard shows about the beta (the local flow uses a review note too). */
 reviewNote?:string;
 /** The name the dashboard shows as the host behind the beta. */
 serviceName?:string;
 /** Fixed clock for tests. */
 now?:()=>number;
 /** `Secure` on the account cookie. 'auto' sets it when the request arrived over https. */
 secureCookies?:'auto'|boolean;
 log?:(line:string)=>void;
}
export interface AccountService {
 server:Server;
 port:number;
 url:string;
 close():Promise<void>;
 /** The same operations the HTTP surface exposes, for the CLI and for tests that want no socket. */
 db:{file:string;list():AccountView[];decide(email:string,decision:'approve'|'reject',decidedBy:string):{account:AccountView;invite:string|null}|null};
}
interface Row extends Record<string,unknown>{}
const nowMs=Date.now;
export async function createAccountService(options:AccountServiceOptions={}):Promise<AccountService>{
 const now=options.now??nowMs;
 const file=options.file??process.env.SCOUT_ACCOUNT_DB??path.join('config','account-service','accounts.sqlite');
 if(file!==':memory:') mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
 const db=new DatabaseSync(file);
 db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
   id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, organisation TEXT NOT NULL,
   country TEXT NOT NULL, use_case TEXT NOT NULL, events TEXT NOT NULL, status TEXT NOT NULL,
   password TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT NOT NULL DEFAULT '',
   invite_digest TEXT, invite_expires_at INTEGER, last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
   id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
   address TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS devices (
   id TEXT PRIMARY KEY, account_id TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL,
   created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER, token_digest TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS grants (
   device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL,
   origin TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
   account_id TEXT, device_id TEXT, pending_token TEXT, claimed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
   at INTEGER NOT NULL, kind TEXT NOT NULL, account_id TEXT, detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
  CREATE INDEX IF NOT EXISTS devices_account ON devices (account_id);
  CREATE INDEX IF NOT EXISTS grants_user_code ON grants (user_code);
  CREATE INDEX IF NOT EXISTS accounts_status ON accounts (status);
 `);
 const download:DownloadView={
  url:options.download?.url||process.env.SCOUT_DOWNLOAD_URL||DEFAULT_DOWNLOAD_URL,
  version:options.download?.version||process.env.SCOUT_DOWNLOAD_VERSION||DEFAULT_DOWNLOAD_VERSION,
  notes:options.download?.notes||process.env.SCOUT_DOWNLOAD_NOTES||'',
 };
 const apiKey=options.apiKey??process.env.SCOUT_BETA_API_KEY??'';
 const applicationsOpen=options.applicationsOpen??process.env.SCOUT_ACCOUNT_APPLICATIONS!=='closed';
 const reviewNote=options.reviewNote??process.env.SCOUT_ACCOUNT_REVIEW_NOTE??'';
 const serviceName=options.serviceName??options.host??process.env.SCOUT_ACCOUNT_NAME??'SCOUT account service';
 const secureCookies=options.secureCookies??'auto';
 const log=options.log??((line:string)=>console.log(`[accounts] ${line}`));
 // The limits are in memory on purpose (as in the local store): they exist to blunt a burst, not to
 // be an audit trail, and a restart is a legitimate way to clear them.
 const applications=new Map<string,number[]>();
 const failures=new Map<string,{count:number;first:number}>();
 const run=(sql:string,...values:unknown[])=>db.prepare(sql).run(...values as never[]);
 const get=(sql:string,...values:unknown[])=>(db.prepare(sql).get(...values as never[])??null) as Row|null;
 const all=(sql:string,...values:unknown[])=>db.prepare(sql).all(...values as never[]) as Row[];
 const event=(kind:string,accountId:string|null,detail='')=>run('INSERT INTO events (at,kind,account_id,detail) VALUES (?,?,?,?)',now(),kind,accountId,detail);

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
  const invite=newToken(24);
  run('UPDATE accounts SET status = ?, decided_at = ?, decided_by = ?, invite_digest = ?, invite_expires_at = ? WHERE id = ?',
   'approved',now(),decidedBy,hashToken(invite),now()+14*24*60*60*1000,accountId);
  return invite;
 }
 function decide(id:string,decision:'approve'|'reject',decidedBy:string){
  const row=accountRow(id);
  if(!row) return null;
  const invite=decision==='approve'?grantInvite(id,decidedBy):null;
  if(decision==='reject') run('UPDATE accounts SET status = ?, decided_at = ?, decided_by = ?, invite_digest = NULL, invite_expires_at = NULL WHERE id = ?','rejected',now(),decidedBy,id);
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id); // a re-decision ends existing sessions
  return {account:view(accountRow(id)!),invite};
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
 const fail=(status:number,code:string,message:string)=>{throw new HttpError(status,code,message)};
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
 function json(res:ServerResponse,status:number,value:unknown){const text=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(text),'Cache-Control':'no-store'});res.end(text)}
 // A launcher code brings its own throttle: at most 20 pending at a time, started from one address per
 // minute. Codes are cheap to mint but not free to guess, and a human has to approve one anyway.
 function checkServiceKey(req:IncomingMessage){
  if(!apiKey) fail(503,'service-key-required','This account service has no SCOUT_BETA_API_KEY set, so the owner-only routes are closed.');
  const header=req.headers.authorization||'';
  if(header!==`Bearer ${apiKey}`) fail(401,'bad-service-key','The service key is missing or wrong.');
 }
 const server=createServer((req,res)=>{
  void (async()=>{
   const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
   const route=url.pathname.replace(/\/+$/,'')||'/';
   const method=req.method||'GET';
   const userAgent=String(req.headers['user-agent']||'');
   try{
    reap();
    if(method==='GET'&&route==='/healthz'){const accounts=(get('SELECT COUNT(*) AS n FROM accounts')!.n as number);return json(res,200,{ok:true,accounts,pending:Number(get('SELECT COUNT(*) AS n FROM accounts WHERE status = ?','pending')!.n),devices:Number(get('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL')!.n)})}
    if(method==='GET'&&route==='/status'){
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
     if(!applicationsOpen) fail(403,'applications-closed','The closed beta is not taking new applications right now.');
     const input=(await body(req)) as Partial<ApplicationInput>&{address?:string};
     const email=normalizeEmail(String(input.email||''));
     if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400,'bad-email','That does not look like an email address.');
     if(String(input.name||'').trim().length<2) fail(400,'bad-name','Tell us the name to put on the account.');
     const from=String(input.address||address(req));
     const stamps=(applications.get(from)||[]).filter(stamp=>now()-stamp<60*60*1000);
     if(stamps.length>=MAX_APPLICATIONS_PER_HOUR) fail(429,'throttled','That address has sent several applications already. Try again in an hour.');
     const existing=get('SELECT * FROM accounts WHERE email = ?',email);
     if(existing){
      if(String(existing.status)==='approved') fail(409,'already-approved','That address already has an approved account — sign in, or open the invite link from your approval.');
      fail(409,'already-applied','That address already has an application in review. Sign in if you have already set a password.');
     }
     const id=newToken(12);
     run(`INSERT INTO accounts (id,email,display_name,organisation,country,use_case,events,status,password,created_at,decided_at,decided_by)
          VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,'')`,
      id,email,String(input.name||'').trim().slice(0,80),String(input.organisation||'').trim().slice(0,120),
      String(input.country||'').trim().slice(0,60),String(input.useCase||'').trim().slice(0,600),String(input.events||'').trim().slice(0,80),
      'pending',now());
     stamps.push(now());applications.set(from,stamps);
     event('application',id,email);
     log(`application from ${email} is waiting for review`);
     return json(res,200,{account:view(accountRow(id)!),invite:null});
    }
    if(method==='POST'&&route==='/login'){
     const input=await body(req);
     const email=normalizeEmail(String(input.email||''));
     const from=address(req);
     const record=failures.get(from);
     if(record&&record.count>=MAX_LOGIN_FAILURES&&now()-record.first<15*60*1000)
      fail(429,'throttled',`Too many failed sign-ins from ${from}. Try again in ${Math.ceil((15*60*1000-(now()-record.first))/60000)} minute(s).`);
     const row=get('SELECT * FROM accounts WHERE email = ?',email);
     if(!row||!secretMatches(String(input.password||''),row.password?parseSecret(String(row.password)):null)){
      const next=!record||now()-record.first>15*60*1000?{count:1,first:now()}:{count:record.count+1,first:record.first};
      failures.set(from,next);
      fail(401,'bad-credentials','That email address and password do not match an account.');
     }
     const status=String(row!.status);
     if(status!=='approved') fail(403,status==='pending'?'pending-review':'rejected',status==='pending'?'This application is still in review. You will get an invite link as soon as it is approved.':'This application was not approved for the closed beta.');
     failures.delete(from);
     run('UPDATE accounts SET last_login_at = ? WHERE id = ?',now(),row!.id);
     const cookie=issueSession(String(row!.id),from,userAgent);
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
    // The invite is the password reset: it is single-use, expires in 14 days, and only an operator
    // approval mints one — which is what makes "no reset email" an acceptable answer for a beta.
    if(method==='POST'&&route==='/activate'){
     const input=await body(req);
     const password=String(input.password||'');
     if(password.length<MIN_PASSWORD) fail(400,'weak-password',`Choose a password of at least ${MIN_PASSWORD} characters.`);
     const row=get('SELECT * FROM accounts WHERE invite_digest = ?',hashToken(String(input.invite||'').trim()));
     if(!row) fail(401,'bad-invite','That invite link is not valid. Ask the operator who approved you for a new one.');
     if(row!.invite_expires_at!==null&&Number(row!.invite_expires_at)<now()){
      run('UPDATE accounts SET invite_digest = NULL, invite_expires_at = NULL WHERE id = ?',row!.id);
      fail(401,'expired-invite','That invite link has expired. Ask for a new one.');
     }
     const secret=digestSecret(password);
     run('UPDATE accounts SET password = ?, invite_digest = NULL, invite_expires_at = NULL, status = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?',
      `${secret.salt}:${secret.digest}`,'approved',now(),row!.id);
     const cookie=issueSession(String(row!.id),address(req),userAgent);
     event('activate',String(row!.id),String(row!.email));
     setCookie(res,req,cookie,ACCOUNT_TTL_MS);
     return json(res,200,{account:view(accountRow(String(row!.id))!)});
    }
    if(route==='/applications'&&method==='GET'){
     checkServiceKey(req);
     const rows=all('SELECT * FROM accounts ORDER BY created_at DESC');
     return json(res,200,{applications:rows.map(view)});
    }
    const decision=route.match(/^\/applications\/([^/]+)$/);
    if(decision&&method==='POST'){
     checkServiceKey(req);
     const input=await body(req);
     if(input.decision!=='approve'&&input.decision!=='reject') fail(400,'invalid-decision','A decision is approve or reject.');
     const result=decide(decodeURIComponent(decision[1]),input.decision,String(input.decidedBy||'operator'));
     if(!result) fail(404,'not-found','That application no longer exists.');
     event(`application.${input.decision}`,result!.account.id,result!.account.email);
     return json(res,200,result);
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
     const answer:DeviceGrantView={userCode,deviceCode,expiresAt:moment+DEVICE_CODE_TTL_MS,interval:DEVICE_POLL_INTERVAL_MS,verificationUrl:`${base}/dashboard?link=${encodeURIComponent(userCode)}`};
     log(`a launcher started a link — approve ${userCode} ${base?`at ${answer.verificationUrl}`:''}`);
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
      log(`a launcher was linked to ${accountView?.email||'an account'}`);
      return json(res,200,{status:'approved',installationToken:token,deviceId,account:accountView} as DevicePollView);
     }
     return json(res,200,{status:'approved',deviceId,account:accountView} as DevicePollView);
    }
    if((route==='/device/approve'||route==='/device/deny')&&method==='POST'){
     const input=await body(req);
     const current=sessionAccount(cookieId(req));
     if(!current) fail(401,'no-session','Sign in with your SCOUT account before approving a launcher.');
     if(String(current!.account.status)!=='approved') fail(403,'pending-review','Your account is not approved yet, so it cannot link a launcher.');
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
     const current=sessionAccount(cookieId(req));
     if(!current) fail(401,'no-session','Sign in with your SCOUT account first.');
     const deviceId=String(input.deviceId||'').trim();
     const device=deviceId?get('SELECT * FROM devices WHERE id = ? AND account_id = ? AND revoked_at IS NULL',deviceId,String(current!.account.id)):null;
     if(!device) fail(404,'not-found','That launcher is not linked to this account.');
     run('UPDATE devices SET revoked_at = ? WHERE id = ?',now(),deviceId);
     event('launcher.revoked',String(current!.account.id),deviceId);
     log(`a launcher was unlinked from ${current!.account.email}`);
     return json(res,200,{account:view(current!.account)});
    }
    // What a running installation asks about itself. This answer is read by the launcher's licence
    // check (server/licensing.ts, src-tauri/core/src/licence.rs) and never by a page, so it takes the
    // installation's own token rather than a browser cookie. A wrong token or an unknown device is
    // `revoked`, not an error: the launcher must be able to tell "not entitled" from "did not ask".
    if(method==='POST'&&route==='/license/check'){
     const input=await body(req);
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
     return json(res,200,{status:'active',email:String(account.email),displayName:String(account.display_name)} as LicenceCheck);
    }
    fail(404,'not-found',`This account service has no ${method} ${route}. The contract is in docs/BETA.md.`);
   }catch(error:any){
    if(error instanceof HttpError) return json(res,error.status,{error:error.message,code:error.code});
    log(`a request failed: ${error?.message||error}`);
    return json(res,500,{error:'The account service hit an unexpected error.',code:'internal'});
   }
  })();
 });
 const listenHost=options.host??process.env.HOST??'0.0.0.0';
 const port=options.port??Number(process.env.PORT||8790);
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,listenHost,()=>{server.off('error',reject);resolve()});
 });
 const bound=server.address();
 const actualPort=typeof bound==='object'&&bound?bound.port:port;
 return {
  server,port:actualPort,url:`http://127.0.0.1:${actualPort}`,
  // Idempotent: a supervisor may stop the service twice, and the tests close it by hand to read the
  // file before the runner tears it down.
  async close(){
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
// exist for a deployment with no panel handy: list the applications, and approve one and print the
// invite link the applicant needs.
// `isEntry` rather than a bare import-time start, so importing this module (the tests do, to drive
// the same store without a socket) never starts a listener or runs a CLI command.
const isEntry=Boolean(process.argv[1])&&/account-service\.ts$/.test(process.argv[1]);
if(isEntry){
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
  const result=service.db.decide(row.id,'approve','command line');
  const base=(process.env.SCOUT_ACCOUNT_BASE_URL||'').replace(/\/$/,'');
  console.log(`[accounts] approved ${email}`);
  console.log(base?`[accounts] send them this one-time invite link:\n[accounts]   ${base}/login?invite=${encodeURIComponent(result?.invite||'')}`:`[accounts] set SCOUT_ACCOUNT_BASE_URL to print the full invite link; the token is ${result?.invite||''}`);
  await service.close();process.exit(0);
 }
 console.log(`[accounts] account service listening on ${service.url} (SQLite: ${service.db.file}, ${service.db.list().length} account(s))`);
 console.log(`[accounts] point the SCOUT host here: SCOUT_BETA_API_URL=${service.url.replace('127.0.0.1','<this machine>')} and set the same SCOUT_BETA_API_KEY on both.`);
 if(!process.env.SCOUT_BETA_API_KEY) console.log('[accounts] warning: SCOUT_BETA_API_KEY is not set, so the owner-only routes (/applications) are closed.');
}
