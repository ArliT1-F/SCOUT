import type {PanelRole} from './auth.js';
export const CONTROL_LEASE_TTL_MS=45_000;
export interface LeasePrincipal {id:string;name:string;role:PanelRole}
export interface ControlLeaseView {holder:string|null;principalId:string|null;role:PanelRole|null;claimedAt:number|null;lastActivityAt:number|null;expiresAt:number|null;mine:boolean}
export type LeaseResult={ok:true;lease:ControlLeaseView}|{ok:false;lease:ControlLeaseView;error:string;code:'control-lease-held'|'control-role-required'};

// A short renewable lease prevents two producers from racing scene controls. It is intentionally
// in-memory: a host restart clears control ownership rather than resurrecting a stale controller.
export class ControlLease {
 private current:{principal:LeasePrincipal;claimedAt:number;lastActivityAt:number}|null=null;
 constructor(private readonly now:()=>number=Date.now,readonly ttlMs=CONTROL_LEASE_TTL_MS){}
 private reap(){if(this.current&&this.now()-this.current.lastActivityAt>this.ttlMs)this.current=null}
 view(principalId?:string):ControlLeaseView {
  this.reap();const lease=this.current;
  return {holder:lease?.principal.name||null,principalId:lease?.principal.id||null,role:lease?.principal.role||null,claimedAt:lease?.claimedAt??null,lastActivityAt:lease?.lastActivityAt??null,expiresAt:lease?lease.lastActivityAt+this.ttlMs:null,mine:!!lease&&lease.principal.id===principalId};
 }
 claim(principal:LeasePrincipal,force=false):LeaseResult {
  this.reap();
  if(!['owner','producer'].includes(principal.role)) return {ok:false,lease:this.view(principal.id),error:'Only an owner or producer can take broadcast control.',code:'control-role-required'};
  if(!this.current||this.current.principal.id===principal.id){
   const now=this.now();
   if(!this.current)this.current={principal,claimedAt:now,lastActivityAt:now};else this.current.lastActivityAt=now;
   return {ok:true,lease:this.view(principal.id)};
  }
  if(force&&principal.role==='owner'){
   const now=this.now();this.current={principal,claimedAt:now,lastActivityAt:now};return {ok:true,lease:this.view(principal.id)};
  }
  return {ok:false,lease:this.view(principal.id),error:`Broadcast control is held by ${this.current.principal.name}. Ask them to release it, or have an owner take over.`,code:'control-lease-held'};
 }
 renew(principal:LeasePrincipal):LeaseResult {
  this.reap();
  if(!this.current)return this.claim(principal);
  if(this.current.principal.id!==principal.id)return {ok:false,lease:this.view(principal.id),error:`Broadcast control is held by ${this.current.principal.name}.`,code:'control-lease-held'};
  this.current.lastActivityAt=this.now();
  return {ok:true,lease:this.view(principal.id)};
 }
 release(principal:LeasePrincipal,force=false):LeaseResult {
  this.reap();
  if(!this.current)return {ok:true,lease:this.view(principal.id)};
  if(this.current.principal.id!==principal.id&&!(force&&principal.role==='owner'))return {ok:false,lease:this.view(principal.id),error:`Broadcast control is held by ${this.current.principal.name}.`,code:'control-lease-held'};
  this.current=null;return {ok:true,lease:this.view(principal.id)};
 }
}
