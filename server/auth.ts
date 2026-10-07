import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
// Panel access policy: who may *change* the broadcast. Reads stay open (the overlay is a public
// artifact — an OBS browser source on the second machine has to be able to load /obs and its
// WebSocket feed), so this module answers exactly one question: may this request mutate state?
//
// The rule is deliberately small:
//   1. A request from this machine (loopback socket) addressed to a host that cannot be a public
//      domain name — localhost, a LAN IP, *.local, a bare hostname — is the operator sitting at the
//      observer PC. Trusted without a token, exactly like the shipped behaviour.
//   2. Anything else — another laptop on the venue network, a phone, a reverse proxy or tunnel in
//      front of the host, the preview URL of a dev sandbox — needs the panel token: either the
//      session cookie the panel sets after unlocking, or the token in a request header.
//
// Two things make (1) safe to keep. The *host name is checked, not only the socket*: a proxy or
// tunnel running on the observer PC connects from 127.0.0.1, so without that check every visitor it
// forwards would look local. And mutations get a same-origin check (`originTrusted`) as well, because
// a browser reaches a local host through whatever name its page used — a rebound domain (evil.com
// resolving to the host's address) sends a Host and Origin that agree with each other.
// The token is never stored in a session record or returned by an API. The host deliberately prints
// it once as part of the startup unlock link; after startup, request and audit logs omit its value.
export const PANEL_COOKIE='scout_panel';
export const PANEL_HEADER='x-scout-token';
export const SESSION_TTL_MS=12*60*60*1000;
// Wrong tokens are counted per address: five in ten minutes locks that address out for ten minutes.
// The counter is what makes the unlock form useless to guess at — the token itself is 24 random
// bytes; this only removes the guess rate the network would otherwise allow.
export const MAX_UNLOCK_FAILURES=5;
export const FAILURE_WINDOW_MS=10*60*1000;
export const LOCKOUT_MS=10*60*1000;
export const MAX_SESSIONS=32;
export const TOKEN_BYTES=24;
export const PANEL_ROLES=['owner','producer','designer','viewer'] as const;
export type PanelRole=typeof PANEL_ROLES[number];
export const PANEL_CAPABILITIES=['control','match-edit','design','manage-operators','view-audit'] as const;
export type PanelCapability=typeof PANEL_CAPABILITIES[number];
const ROLE_CAPABILITIES:Record<PanelRole,PanelCapability[]>={
 owner:[...PANEL_CAPABILITIES],
 producer:['control','match-edit'],
 designer:['design'],
 viewer:[],
};
export const capabilitiesFor=(role:PanelRole|undefined):PanelCapability[]=>role?[...ROLE_CAPABILITIES[role]]:[];
export const hasCapability=(role:PanelRole|undefined,capability:PanelCapability)=>!!role&&ROLE_CAPABILITIES[role].includes(capability);
export type TokenSource='env'|'generated';
export type DenialCode='no-session'|'bad-session'|'remote-disabled'|'untrusted-host'|'throttled';
export type AccessVia='local'|'cookie'|'header';
export interface Principal {id:string;name:string;role:PanelRole}
export interface PanelSession {id:string;createdAt:number;lastSeenAt:number;address:string;host:string;userAgent:string;principal:Principal;credentialId:string}
export interface OperatorTokenCredential {id:string;label:string;role:PanelRole;salt:string;digest:string}
export interface AccessGranted {ok:true;local:boolean;via:AccessVia;session?:PanelSession;principal:Principal}
export interface AccessDenied {ok:false;status:401|403|429;code:DenialCode;message:string;retryAfterMs?:number;attemptsLeft?:number}
export type AccessDecision=AccessGranted|AccessDenied;
// `allowedHosts` takes the raw comma-separated environment value as well, so the caller does not have
// to pre-split it into the exact shape the policy wants.
export interface PanelAuthOptions {token?:string;operatorTokens?:OperatorTokenCredential[];remoteEnabled?:boolean;requireLocalToken?:boolean;allowedHosts?:string[]|string;ttlMs?:number;now?:()=>number}
export interface PanelSessionView {
 authenticated:boolean;local:boolean;via:AccessVia|null;address:string;host:string;
 startedAt:number|null;expiresAt:number|null;remoteEnabled:boolean;tokenSource:TokenSource;
 allowedHosts:string[];sessions:number;role:PanelRole|null;operator:string;principalId:string|null;sessionId:string|null;capabilities:PanelCapability[];
}
export interface PanelRequest {address?:string;host?:string;cookie?:string;headers?:Record<string,string|string[]|undefined>}
// A generated token is shown once, on the host console; an environment token is the operator's own,
// so a restart keeps the same link working.
export function generateToken(){return randomBytes(TOKEN_BYTES).toString('base64url')}
export function randomId(){return randomBytes(18).toString('base64url')}
// Compared through a hash so the timing cannot depend on how much of the token matched, and so a
// candidate of any length can be compared without throwing on a length mismatch.
export function tokensMatch(candidate:string,expected:string){const a=createHash('sha256').update(candidate).digest(),b=createHash('sha256').update(expected).digest();return timingSafeEqual(a,b)}
export function isLoopbackAddress(address?:string):boolean {
 if(!address) return false;
 const value=address.trim().toLowerCase().replace(/^::ffff:/,'');
 if(value==='::1'||value==='0:0:0:0:0:0:0:1') return true;
 const v4=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
 if(v4) return Number(v4[1])===127;
 // ::ffff:7f00:1 is the same IPv4-mapped loopback in hex form; some stacks report it that way.
 const hex=/^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(value);
 return !!hex&&(parseInt(hex[1],16)&0xff00)===0x7f00;
}
// Host without its port, lower case, trailing dot removed; a bracketed IPv6 keeps its address only.
export function normalizeHost(host?:string):string {
 if(!host) return '';
 const value=host.trim().toLowerCase();
 if(value.startsWith('[')){const end=value.indexOf(']');return end>0?value.slice(1,end):''}
 // Only a name with a single colon carries a port: a bare IPv6 literal (`::1`, `fe80::1`) is all
 // colons and must survive untouched, or it would be cut down to its first character.
 const name=value.split(':').length===2?value.slice(0,value.lastIndexOf(':')):value;
 return name.replace(/\.$/,'');
}
// Names a browser can only resolve inside this network: mDNS, the OS's own short names, or the
// literal address itself. A public attacker domain always carries a dot it had to register.
const LOCAL_SUFFIXES=['.local','.localhost','.internal','.lan','.home.arpa'];
export function isLocalName(host:string):boolean {
 const value=normalizeHost(host);
 if(!value) return false;
 return value==='localhost'||LOCAL_SUFFIXES.some(suffix=>value.endsWith(suffix));
}
export function isIpLiteral(host:string):boolean {return isIP(normalizeHost(host))!==0}
// The name a DNS-rebound request would carry: `http://evil.com:8080` pointed at the host's address
// makes the browser send `Host: evil.com` with a matching Origin, so a same-origin check alone
// cannot see the attack. A name like this is trusted only when the operator listed it.
export function isRebindableHost(host:string):boolean {
 const value=normalizeHost(host);
 return !!value&&value.includes('.')&&!isIpLiteral(value)&&!isLocalName(value);
}
// Trusted as an address for the panel: the literal address, a local name, the machine's own short
// host name (`observer-pc`, which carries no dot and so cannot be a domain anyone registered), or a
// name the operator listed. Everything else is a domain name that could be pointed anywhere.
export function hostTrusted(host:string,allowedHosts?:Set<string>|string[]|string):boolean {
 const value=normalizeHost(host);
 if(!value) return false;
 if(isIpLiteral(value)||isLocalName(value)||!value.includes('.')) return true;
 return toAllowedSet(allowedHosts).has(value);
}
export function toAllowedSet(raw?:Set<string>|string[]|string):Set<string> {
 if(raw instanceof Set) return raw;
 const list=Array.isArray(raw)?raw:typeof raw==='string'?raw.split(','):[];
 return new Set(list.map(entry=>normalizeHost(entry)).filter(Boolean));
}
// `Origin` is only meaningful next to the request's own Host: the browser sets both and can forge
// neither, so an Origin naming the very host the request was addressed to is same-origin by
// construction. A listed host name covers a proxy that keeps the public name in the URL while
// rewriting Host, and a browser-native client (no Origin) is left to the token check that follows.
export function originTrusted(origin:string|undefined,host:string|undefined,allowedHosts?:Set<string>|string[]|string):boolean {
 if(!origin) return true;
 let parsed:URL;
 try {parsed=new URL(origin)} catch {return false}
 const allowed=toAllowedSet(allowedHosts);
 if(normalizeHost(parsed.host)===normalizeHost(host)) return true;
 if(allowed.has(normalizeHost(parsed.host))) return true;
 // Two loopback spellings of the same local service (localhost panel, 127.0.0.1 page) are the same
 // machine; neither name can be pointed at a stranger's server.
 return (isLoopbackAddress(normalizeHost(parsed.hostname))||isLocalName(parsed.hostname))&&(isLoopbackAddress(normalizeHost(host))||isLocalName(normalizeHost(host)));
}
export function cookieValue(header:string|undefined,name:string):string|undefined {
 if(!header) return undefined;
 for(const part of header.split(';')){
  const index=part.indexOf('=');
  if(index<0) continue;
  if(part.slice(0,index).trim().toLowerCase()!==name) continue;
  const value=part.slice(index+1).trim();
  if(value.startsWith('"')&&value.endsWith('"')) return value.slice(1,-1)||undefined;
  return value||undefined;
 }
 return undefined;
}
// A script or a curl session can carry the token directly instead of holding a cookie. That path is
// also what keeps the panel usable when a browser refuses the cookie (a panel embedded in another
// site's frame, third-party storage blocked).
export function bearerToken(headers:Record<string,string|string[]|undefined>):string|undefined {
 const header=headers[PANEL_HEADER];
 const direct=Array.isArray(header)?header[0]:header;
 if(typeof direct==='string'&&direct.trim()) return direct.trim();
 const authorization=headers.authorization;
 const value=Array.isArray(authorization)?authorization[0]:authorization;
 const match=/^Bearer\s+(.+)$/i.exec((value||'').trim());
 return match?.[1].trim()||undefined;
}
// HttpOnly keeps the token out of reach of page scripts, Strict keeps it off every cross-site
// request. Secure is added only when the request itself arrived over TLS: the host normally serves
// plain HTTP on a LAN, where a Secure cookie would simply never be stored.
export function sessionCookie(id:string,ttlMs:number,secure:boolean):string {
 return `${PANEL_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Math.floor(ttlMs/1000))}${secure?'; Secure':''}`;
}
export function clearedCookie(secure:boolean):string {return sessionCookie('',0,secure)}
export function requestIsSecure(headers:Record<string,string|string[]|undefined>,socketEncrypted=false):boolean {
 if(socketEncrypted) return true;
 const proto=headers['x-forwarded-proto'];
 const value=(Array.isArray(proto)?proto[0]:proto)||'';
 return value.split(',')[0].trim().toLowerCase()==='https';
}
// Addresses the panel can print for "open this on the other machine". Loopback and link-local
// (169.254.x, fe80::) are left out: they are never reachable from another device on purpose.
export function lanAddresses(interfaces=networkInterfaces()):string[] {
 const found:string[]=[];
 for(const entries of Object.values(interfaces)){
  for(const entry of entries||[]){
   if(entry.internal) continue;
   if(entry.family==='IPv4'){if(entry.address.startsWith('169.254.')) continue;found.push(entry.address)}
   else if(/^fe80:/i.test(entry.address)) continue;
   else found.push(`[${entry.address}]`);
   if(found.length>=4) return found;
  }
 }
 return found;
}
export function panelUrls(port:number,addresses=lanAddresses()):string[] {
 return addresses.map(address=>`http://${address}:${port}`);
}
interface FailureRecord {count:number;first:number;blockedUntil:number}
// The whole policy as one object, with time injected so expiry, throttling and the session cap are
// testable without waiting. `authorize` is the per-request decision, `unlock` the only way a remote
// client gains authority, and `view` is what the panel is allowed to know about itself.
export class PanelAuth {
 readonly token:string;readonly tokenSource:TokenSource;readonly remoteEnabled:boolean;readonly requireLocalToken:boolean;readonly allowedHosts:Set<string>;readonly ttlMs:number;
 private readonly now:()=>number;
 private sessions=new Map<string,PanelSession>();
 private failures=new Map<string,FailureRecord>();
 private operatorTokens:OperatorTokenCredential[]=[];
 constructor(options:PanelAuthOptions={}){
  const configured=options.token?.trim()||'';
  this.token=configured||generateToken();
  this.tokenSource=configured?'env':'generated';
  this.remoteEnabled=options.remoteEnabled!==false;
  this.requireLocalToken=options.requireLocalToken===true;
  this.allowedHosts=toAllowedSet(options.allowedHosts);
  this.ttlMs=options.ttlMs??SESSION_TTL_MS;
  this.now=options.now??Date.now;
  this.setOperatorTokens(options.operatorTokens||[]);
 }
 get sessionCount(){return this.sessions.size}
 setOperatorTokens(tokens:OperatorTokenCredential[]){
  this.operatorTokens=tokens.map(token=>({...token}));
  const active=new Set(this.operatorTokens.map(token=>token.id));
  for(const [id,session] of this.sessions) if(session.credentialId!=='master'&&!active.has(session.credentialId))this.sessions.delete(id);
 }
 activeSessions(){this.reap();return [...this.sessions.values()].map(session=>({id:session.id,operator:session.principal.name,role:session.principal.role,address:session.address,host:session.host,createdAt:session.createdAt,lastSeenAt:session.lastSeenAt}))}
 private principalForToken(candidate:string):{principal:Principal;credentialId:string}|undefined{
  if(tokensMatch(candidate,this.token))return {principal:{id:'master',name:'Primary operator',role:'owner'},credentialId:'master'};
  for(const entry of this.operatorTokens){
   const actual=createHash('sha256').update(entry.salt,'hex').update(candidate).digest();
   const expected=Buffer.from(entry.digest,'hex');
   if(actual.length===expected.length&&timingSafeEqual(actual,expected))return {principal:{id:entry.id,name:entry.label,role:entry.role},credentialId:entry.id};
  }
  return undefined;
 }
 // Run on every request, so expired sessions and stale failure records are dropped as traffic flows
 // instead of needing a timer of their own.
 reap(now=this.now()){
  let dropped=0;
  for(const [id,session] of this.sessions) if(now-session.lastSeenAt>this.ttlMs){this.sessions.delete(id);dropped++}
  for(const [address,record] of this.failures) if(record.blockedUntil<=now&&now-record.first>FAILURE_WINDOW_MS) this.failures.delete(address);
  return dropped;
 }
 // The requested path is deliberately not part of the decision: the caller applies this to mutations
 // only, so a route added later is covered by construction instead of by remembering to protect it.
 authorize(request:PanelRequest):AccessDecision {
  const now=this.now();this.reap(now);
  const host=normalizeHost(request.host);
  const provided=bearerToken(request.headers||{});
  if(provided!==undefined){
   if(!this.remoteEnabled) return {ok:false,status:403,code:'remote-disabled',message:'Remote control is switched off on this host.'};
   const match=this.principalForToken(provided);
   if(!match) return {ok:false,status:401,code:'bad-session',message:'That operator token is not valid or has been revoked. Ask an owner for a current access token.'};
   return {ok:true,local:false,via:'header',principal:match.principal};
  }
  const id=cookieValue(request.cookie,PANEL_COOKIE);
  if(id){
   const session=this.sessions.get(id);
   if(session){session.lastSeenAt=now;return {ok:true,local:false,via:'cookie',session,principal:session.principal}}
  }
  if(isLoopbackAddress(request.address)&&!this.requireLocalToken){
   if(hostTrusted(host,this.allowedHosts)) return {ok:true,local:true,via:'local',principal:{id:'local',name:'Local operator',role:'owner'}};
   // A request that reached this process from this machine but was addressed to a public name: a
   // proxy, a tunnel, or a rebound domain. Not the operator at the observer PC, whatever the socket
   // says — a hosted preview sandbox arrives exactly like this.
   return {ok:false,status:403,code:'untrusted-host',message:`This request came from this machine but was addressed to ${host||'no host name'}, which is not a local address. Open the panel through the address the host printed, or add that name to SCOUT_ALLOWED_HOSTS.`};
  }
  if(!this.remoteEnabled) return {ok:false,status:403,code:'remote-disabled',message:'Remote control is switched off on this host: the panel can only be used from the observer machine.'};
  if(isLoopbackAddress(request.address)) return {ok:false,status:401,code:id?'bad-session':'no-session',message:id?'That panel session has ended. Unlock again with the token the host printed.':'This host asks for the panel token even from its own machine (SCOUT_REQUIRE_TOKEN=1). Enter the token the host printed at startup.'};
  return {ok:false,status:401,code:id?'bad-session':'no-session',message:id?'That panel session has ended. Unlock again with the token the host printed.':'Remote control needs the panel token. Open the link the host printed at startup, or enter the token in the panel.'};
 }
 unlock(request:{token:string;address?:string;host?:string;userAgent?:string;secure?:boolean}):{ok:true;session:PanelSession;cookie:string}|AccessDenied {
  const now=this.now();this.reap(now);
  const address=request.address||'unknown';
  const record=this.failures.get(address);
  if(record&&record.blockedUntil>now){
   const retryAfterMs=record.blockedUntil-now;
   return {ok:false,status:429,code:'throttled',message:`Too many wrong tokens from ${address}. Try again in ${Math.ceil(retryAfterMs/60000)} minute(s).`,retryAfterMs};
  }
  if(!this.remoteEnabled) return {ok:false,status:403,code:'remote-disabled',message:'Remote control is switched off on this host.'};
  const match=this.principalForToken(request.token||'');
  if(!match){
   const next=noteFailure(this.failures,address,now);
   const locked=next.count>=MAX_UNLOCK_FAILURES;
   return {ok:false,status:locked?429:401,code:locked?'throttled':'bad-session',message:locked?`Too many wrong tokens from ${address}. Try again in ${Math.ceil(LOCKOUT_MS/60000)} minute(s).`:`That operator token is not valid. Ask the host owner for a current access token.${locked?'':` ${MAX_UNLOCK_FAILURES-next.count} attempt(s) left.`}`,attemptsLeft:Math.max(0,MAX_UNLOCK_FAILURES-next.count),retryAfterMs:locked?LOCKOUT_MS:undefined};
  }
  this.failures.delete(address);
  const session:PanelSession={id:randomId(),createdAt:now,lastSeenAt:now,address,host:normalizeHost(request.host),userAgent:(request.userAgent||'').slice(0,120),principal:match.principal,credentialId:match.credentialId};
  this.sessions.set(session.id,session);
  // Oldest first: a venue keeps a handful of operator laptops, not fifty, and a cookie handed out
  // hours ago must not outlive the ones in use just because the table grew.
  while(this.sessions.size>MAX_SESSIONS){
   const oldest=[...this.sessions.values()].reduce((a,b)=>a.lastSeenAt<=b.lastSeenAt?a:b);
   this.sessions.delete(oldest.id);
  }
  return {ok:true,session,cookie:sessionCookie(session.id,this.ttlMs,request.secure===true)};
 }
 logout(id?:string){return id?this.sessions.delete(id):false}
 view(request:PanelRequest={}):PanelSessionView {
  const decision=this.authorize(request);
  const session=decision.ok?decision.session:undefined;
  const principal=decision.ok?decision.principal:undefined;
  return {
   authenticated:decision.ok,local:decision.ok&&decision.local,via:decision.ok?decision.via:null,
   address:request.address||'',host:normalizeHost(request.host),
   startedAt:session?.createdAt??null,expiresAt:session?session.createdAt+this.ttlMs:null,
   remoteEnabled:this.remoteEnabled,tokenSource:this.tokenSource,
   allowedHosts:[...this.allowedHosts],sessions:this.sessions.size,
   role:principal?.role??null,operator:principal?.name||'',principalId:principal?.id??null,sessionId:session?.id??null,
   capabilities:capabilitiesFor(principal?.role),
  };
 }
}
function noteFailure(failures:Map<string,FailureRecord>,address:string,now:number):FailureRecord {
 const record=failures.get(address);
 const next=!record||now-record.first>FAILURE_WINDOW_MS?{count:1,first:now,blockedUntil:0}:{...record,count:record.count+1};
 if(next.count>=MAX_UNLOCK_FAILURES) next.blockedUntil=now+LOCKOUT_MS;
 failures.set(address,next);
 return next;
}
