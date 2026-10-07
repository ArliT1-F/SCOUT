import {appendFile,mkdir,readFile,rename,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
import type {PanelRole} from './auth.js';
import type {LeasePrincipal} from './lease.js';
export interface AuditRecord {at:number;actor:string;role:PanelRole;action:string;detail:string}
const LIMIT=1000,MAX_BYTES=2*1024*1024;
export class AuditTrail {
 private records:AuditRecord[]=[];
 private pending:Promise<void>=Promise.resolve();
 constructor(private readonly directory='recordings'){}
 async load(){
  await mkdir(this.directory,{recursive:true});
  const names=['audit.jsonl.2','audit.jsonl.1','audit.jsonl'];
  const list:AuditRecord[]=[];
  for(const name of names){
   try{const data=await readFile(path.join(this.directory,name),'utf8');for(const line of data.split('\n').slice(-LIMIT)){try{const item=JSON.parse(line);if(valid(item))list.push(item)}catch{}}}catch{}
  }
  this.records=list.sort((a,b)=>a.at-b.at).slice(-LIMIT);
 }
 record(principal:LeasePrincipal,action:string,detail=''){
  const entry:AuditRecord={at:Date.now(),actor:principal.name.slice(0,64),role:principal.role,action:action.slice(0,80),detail:detail.replace(/[\r\n\t]/g,' ').slice(0,300)};
  this.records.push(entry);if(this.records.length>LIMIT)this.records.splice(0,this.records.length-LIMIT);
  this.pending=this.pending.then(()=>this.persist(entry)).catch(error=>console.warn('[audit] could not persist audit entry:',error instanceof Error?error.message:String(error)));
 }
 list(limit=200):AuditRecord[]{return this.records.slice(-Math.max(1,Math.min(LIMIT,limit))).reverse()}
 private async persist(entry:AuditRecord){
  await mkdir(this.directory,{recursive:true});
  const file=path.join(this.directory,'audit.jsonl');
  await appendFile(file,JSON.stringify(entry)+'\n','utf8');
  let bytes=0;try{bytes=(await stat(file)).size}catch{}
  if(bytes<=MAX_BYTES)return;
  const second=path.join(this.directory,'audit.jsonl.2'),first=path.join(this.directory,'audit.jsonl.1');
  await unlink(second).catch(()=>{});await rename(first,second).catch(()=>{});await rename(file,first).catch(()=>{});
 }
}
function valid(value:any):value is AuditRecord{return value&&Number.isFinite(value.at)&&typeof value.actor==='string'&&typeof value.role==='string'&&typeof value.action==='string'&&typeof value.detail==='string'}
