import type {BetaMode,Installation,InstallationView} from './beta.js';
// "Is this installation allowed to run?" — the question the launcher asks about itself.
//
// The honest answer for a broadcast tool is more nuanced than yes/no, so this module keeps the
// distinction the rest of SCOUT already makes: the *account* is distribution (who may download and
// link), and the *broadcast* is local (it must run at 3 a.m. in a venue with no internet, because
// somebody's final is on the line). So:
//
//   * Local mode, or a host with no account service configured: the installation is its own
//     authority, exactly like the panel is on the observer machine. The view says `active`.
//   * Hosted mode: the account service is asked, at most once per CHECK_INTERVAL_MS, and its answer
//     is cached. A service that cannot be reached does not take the broadcast down — the last
//     answer stays in force for GRACE_MS (a week), and past that the state degrades to `offline`
//     rather than `revoked`, which is a different thing and is reported as such.
//   * Revocation is immediate where it matters: the launcher asks again on its next check, and the
//     shell (src-tauri) refuses to start — or hides the overlay — when the state is not active and
//     it was asked to require a licence.
//
// Nothing here gates the operator panel's live features. That is deliberate: a licence server
// outage must never be able to stop a running broadcast. `enforced` is reported so the launcher and
// the dashboard can say plainly what is and is not being enforced.
export const CHECK_INTERVAL_MS=15*60*1000;
export const GRACE_MS=7*24*60*60*1000;
export type LicenceState='active'|'pending'|'unlinked'|'revoked'|'unknown'|'offline';
export interface LicenceView {
 mode:BetaMode;state:LicenceState;enforced:boolean;
 email:string|null;displayName:string|null;deviceId:string|null;
 checkedAt:number|null;lastGoodAt:number|null;graceExpiresAt:number|null;
 message:string;
}
export interface LicenceCheckResult {ok:boolean;status:'active'|'revoked'|'unknown';email?:string;displayName?:string;message?:string}
export interface LicenceSource {
 // The host passes the service's own method through; a test passes a stub.
 installationStatus(input:{deviceId:string;installationId:string;token:string}):Promise<{ok:true;value:{status:'active'|'revoked'|'unknown';email?:string;displayName?:string}}|{ok:false;status:number;code:string;message:string}>;
}
export interface LicenceMonitorOptions {
 mode:BetaMode;
 source?:LicenceSource;
 now?:()=>number;
 checkIntervalMs?:number;
 graceMs?:number;
 enforced?:boolean;
}
// The states a launcher treats as "may run". `unknown` is included on purpose: a device id the
// account service has never heard of is a broken link, not a revocation, and the answer to that is
// to link again — not to stop someone's broadcast mid-round.
export const RUNNABLE_STATES:LicenceState[]=['active','unknown','offline'];
export const mayRun=(view:LicenceView)=>RUNNABLE_STATES.includes(view.state);
export class LicenceMonitor {
 private lastCheckAt=0;
 private lastView:LicenceView|null=null;
 private readonly now:()=>number;
 private readonly mode:BetaMode;
 private readonly source?:LicenceSource;
 private readonly checkIntervalMs:number;
 private readonly graceMs:number;
 private readonly enforced:boolean;
 constructor(options:LicenceMonitorOptions){
  this.mode=options.mode;this.source=options.source;this.now=options.now??Date.now;
  this.checkIntervalMs=options.checkIntervalMs??CHECK_INTERVAL_MS;
  this.graceMs=options.graceMs??GRACE_MS;
  this.enforced=options.enforced===true;
 }
 // The message is the part an operator reads, so it says what happened and what to do — never a
 // bare status code.
 private describe(state:LicenceState,email:string|null):string{
  switch(state){
   case 'active':return email?`Linked to ${email}. This installation may run.`:'Linked and verified. This installation may run.';
   case 'pending':return 'A launcher link is waiting to be approved in your SCOUT dashboard.';
   case 'unlinked':return 'This installation is not linked to a SCOUT account yet. Open the panel sidebar, press Link this installation, and approve the code in your dashboard.';
   case 'revoked':return email?`The account ${email} is not entitled to run SCOUT any more, or this installation was unlinked. Link it again from a current account.`:'This installation was unlinked or revoked. Link it again from a current account.';
   case 'offline':return 'The SCOUT account service could not be reached. The last verified state stays in force until the grace period runs out; the broadcast is not affected.';
   default:return 'The account service does not recognise this installation. Link it again from the panel sidebar.';
  }
 }
 private finish(state:LicenceState,installation:InstallationView,email:string|null,checkedAt:number|null):LicenceView{
  const lastGoodAt=state==='active'?checkedAt:(this.lastView?.lastGoodAt??null);
  return {
   mode:this.mode,state,enforced:this.enforced,email,displayName:this.lastView?.displayName??null,deviceId:installation.deviceId,
   checkedAt,lastGoodAt,
   graceExpiresAt:lastGoodAt!==null?lastGoodAt+this.graceMs:null,
   message:this.describe(state,email),
  };
 }
 // Called on every read; it only talks to the service when the cached answer is stale.
 async view(installation:Installation,force=false):Promise<LicenceView>{
  const current=installation.view();
  const now=this.now();
  if(!current.linked){
   const state:LicenceState=current.pending?'pending':'unlinked';
   const view=this.finish(state,current,null,null);
   this.lastView=view;
   return view;
  }
  if(!force&&this.lastView&&now-this.lastCheckAt<this.checkIntervalMs) return this.lastView;
  if(!this.source){
   // No account service is configured: this host is the authority, which is the local beta's whole
   // premise. Reported as active, with `enforced` false so nobody is misled about what was checked.
   const state:LicenceState=current.pending?'pending':'active';
   const view=this.finish(state,current,current.email,null);
   this.lastView=view;this.lastCheckAt=now;
   return view;
  }
  const credentials=installation.credentials();
  if(!credentials.deviceId||!credentials.token){
   const view=this.finish('unlinked',current,null,null);
   this.lastView=view;return view;
  }
  const result=await this.source.installationStatus({deviceId:credentials.deviceId,installationId:credentials.installationId,token:credentials.token});
  this.lastCheckAt=now;
  let state:LicenceState;
  let email:string|null=current.email;
  if(result.ok){
   state=result.value.status==='active'?'active':result.value.status==='revoked'?'revoked':'unknown';
   if(result.value.email) email=result.value.email;
  }else{
   // A refusal with a status the service chose (401/403) is an answer; a transport failure is not.
   state=result.code==='upstream-unreachable'?'offline':'unknown';
  }
  installation.touch();
  await installation.save().catch(()=>{});
  const view=this.finish(state,installation.view(),email,now);
  this.lastView=view;
  return view;
 }
}
