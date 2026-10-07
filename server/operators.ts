import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {PanelRole} from './auth.js';

export const OPERATOR_ROLES=['producer','designer','viewer'] as const;
export type IssuableRole=typeof OPERATOR_ROLES[number];
const credentialSchema=z.object({
 id:z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
 label:z.string().trim().min(1).max(64),
 role:z.enum(OPERATOR_ROLES),
 salt:z.string().regex(/^[a-f0-9]{32}$/i),
 digest:z.string().regex(/^[a-f0-9]{64}$/i),
 createdAt:z.number().int().nonnegative(),
 revokedAt:z.number().int().nonnegative().nullable().default(null),
}).strip();
export const operatorFileSchema=z.object({version:z.literal(1).default(1),operators:z.array(credentialSchema).max(128).default([])}).strip();
export type OperatorCredential=z.infer<typeof credentialSchema>;
export type OperatorView=Pick<OperatorCredential,'id'|'label'|'role'|'createdAt'|'revokedAt'>;
export interface HashedOperatorToken {id:string;label:string;role:PanelRole;salt:string;digest:string}
const digestToken=(token:string,salt:string)=>createHash('sha256').update(salt,'hex').update(token).digest();
function constantHexMatch(candidate:Buffer,digest:string):boolean {
 const expected=Buffer.from(digest,'hex');
 return candidate.length===expected.length&&timingSafeEqual(candidate,expected);
}

// Operator credentials are high-entropy, one-time-issued bearer tokens. Only a salted SHA-256 digest
// is persisted; the plaintext is returned exactly once by issue(). The 192-bit random tokens cannot
// be feasibly dictionary-attacked, and request verification uses a constant-time comparison.
export class OperatorDirectory {
 private file:OperatorCredential[]=[];
 constructor(initial:unknown={}){this.file=operatorFileSchema.parse(initial).operators}
 get credentials():HashedOperatorToken[]{
  return this.file.filter(entry=>!entry.revokedAt).map(({id,label,role,salt,digest})=>({id,label,role,salt,digest}));
 }
 list(includeRevoked=false):OperatorView[]{
  return this.file.filter(entry=>includeRevoked||!entry.revokedAt).map(({id,label,role,createdAt,revokedAt})=>({id,label,role,createdAt,revokedAt}));
 }
 verify(token:string):HashedOperatorToken|undefined {
  for(const entry of this.file){
   if(entry.revokedAt) continue;
   const candidate=digestToken(token,entry.salt);
   if(constantHexMatch(candidate,entry.digest)) return {id:entry.id,label:entry.label,role:entry.role,salt:entry.salt,digest:entry.digest};
  }
  return undefined;
 }
 issue(input:{label:string;role:IssuableRole;now?:number}):{token:string;operator:OperatorView} {
  const label=input.label.trim();
  if(!label||label.length>64) throw new Error('Operator name must be 1–64 characters');
  if(this.file.filter(entry=>!entry.revokedAt).length>=32) throw new Error('The host already has 32 active operator tokens');
  const now=input.now??Date.now();
  const id=`op_${randomBytes(10).toString('hex')}`;
  const token=randomBytes(24).toString('base64url');
  const salt=randomBytes(16).toString('hex');
  const digest=digestToken(token,salt).toString('hex');
  const record=credentialSchema.parse({id,label,role:input.role,salt,digest,createdAt:now,revokedAt:null});
  this.file.push(record);
  return {token,operator:{id,label,role:input.role,createdAt:now,revokedAt:null}};
 }
 revoke(id:string,now=Date.now()):boolean {
  const target=this.file.find(entry=>entry.id===id&&!entry.revokedAt);
  if(!target) return false;
  target.revokedAt=now;
  return true;
 }
 serialize():string{return JSON.stringify(operatorFileSchema.parse({version:1,operators:this.file}),null,2)}
}
