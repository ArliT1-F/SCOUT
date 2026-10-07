import {appendFile,mkdir,readdir,stat,unlink,writeFile,rename,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import type {KillEvent,RoundEvent} from './events.js';
import type {ScoutConfig} from './config.js';

const GSI_PREFIX='gsi-',GSI_EXTENSION='.jsonl',MAX_RECORDING_BYTES=32*1024*1024,MAX_RECORDINGS=12;
const safeFile=(name:string)=>/^gsi-[0-9]{10,16}(?:-[a-z0-9_-]{1,24})?\.jsonl$/i.test(name);
export interface RecordingFile {name:string;bytes:number;modifiedAt:number;kind:'gsi'}
export class GsiRecorder {
 private enabled=false;private filename='';private bytes=0;private queue:Promise<void>=Promise.resolve();
 constructor(private readonly directory='recordings'){}
 async initialize(enabled=false){await mkdir(this.directory,{recursive:true});this.enabled=enabled;if(enabled)await this.openNext()}
 get status(){return {enabled:this.enabled,file:this.filename||null,bytes:this.bytes,maxFileBytes:MAX_RECORDING_BYTES}}
 async setEnabled(enabled:boolean){
  if(enabled===this.enabled)return this.status;
  this.enabled=enabled;
  if(enabled)await this.openNext();else{await this.queue;this.filename='';this.bytes=0}
  return this.status;
 }
 write(receivedAt:number,payload:unknown){
  if(!this.enabled)return;
  const line=JSON.stringify({receivedAt,payload})+'\n';
  this.queue=this.queue.then(async()=>{
   if(!this.enabled)return;
   if(this.bytes+Buffer.byteLength(line)>MAX_RECORDING_BYTES)await this.openNext();
   await appendFile(path.join(this.directory,this.filename),line,'utf8');this.bytes+=Buffer.byteLength(line);
  }).catch(error=>{this.enabled=false;console.warn('[recording] GSI recording disabled:',error instanceof Error?error.message:String(error))});
 }
 async list():Promise<RecordingFile[]>{
  await this.queue;let names:string[]=[];try{names=await readdir(this.directory)}catch{}
  const files:RecordingFile[]=[];
  for(const name of names){if(!safeFile(name))continue;try{const info=await stat(path.join(this.directory,name));files.push({name,bytes:info.size,modifiedAt:info.mtimeMs,kind:'gsi'})}catch{}}
  return files.sort((a,b)=>b.modifiedAt-a.modifiedAt).slice(0,MAX_RECORDINGS);
 }
 async read(name:string,maxBytes=MAX_RECORDING_BYTES):Promise<string>{
  if(!safeFile(name))throw new Error('Invalid recording name');
  const file=path.join(this.directory,name),info=await stat(file);
  if(info.size>maxBytes)throw new Error(`Recording is ${info.size} bytes; the maximum preview size is ${maxBytes} bytes`);
  return readFile(file,'utf8');
 }
 private async openNext(){
  await mkdir(this.directory,{recursive:true});
  const suffix=this.filename?`-${randomBytes(3).toString('hex')}`:'';
  this.filename=`${GSI_PREFIX}${Date.now()}${suffix}${GSI_EXTENSION}`;this.bytes=0;
  await writeFile(path.join(this.directory,this.filename),'','utf8');
  await this.prune();
 }
 private async prune(){
  let names:string[]=[];try{names=(await readdir(this.directory)).filter(safeFile)}catch{}
  const records=await Promise.all(names.map(async name=>({name,mtime:(await stat(path.join(this.directory,name)).catch(()=>({mtimeMs:0}))).mtimeMs})));
  records.sort((a,b)=>b.mtime-a.mtime);
  for(const item of records.slice(MAX_RECORDINGS))await unlink(path.join(this.directory,item.name)).catch(()=>{});
 }
}

export interface ArchivedEvent {at:number;type:'kill'|'round';data:KillEvent|RoundEvent}
export interface MatchArchive {id:string;name:string;startedAt:number;endedAt:number|null;event:string;stage:string;teams:string[];maps:string[];format:string;events:ArchivedEvent[]}
export interface ArchiveSummary extends Omit<MatchArchive,'events'>{eventCount:number;kills:number;rounds:number}
const MAX_ARCHIVES=40,MAX_ARCHIVED_EVENTS=10_000;
export class MatchArchiveStore {
 private archives:MatchArchive[]=[];private pending:Promise<void>=Promise.resolve();
 constructor(private readonly file='recordings/matches.json'){}
 async load(){
  try{const parsed=JSON.parse(await readFile(this.file,'utf8'));if(parsed?.version===1&&Array.isArray(parsed.archives))this.archives=parsed.archives.filter(validArchive).slice(-MAX_ARCHIVES)}catch{}
 }
 get active(){return this.archives.slice().reverse().find(archive=>!archive.endedAt)||null}
 list():ArchiveSummary[]{return this.archives.slice().reverse().map(archive=>({id:archive.id,name:archive.name,startedAt:archive.startedAt,endedAt:archive.endedAt,event:archive.event,stage:archive.stage,teams:archive.teams,maps:archive.maps,format:archive.format,eventCount:archive.events.length,kills:archive.events.filter(event=>event.type==='kill').length,rounds:archive.events.filter(event=>event.type==='round').length}))}
 detail(id:string){return this.archives.find(archive=>archive.id===id)||null}
 start(name:string,config:ScoutConfig,now=Date.now()):MatchArchive {
  if(this.active)throw new Error(`Match session “${this.active.name}” is already recording`);
  const label=name.trim().slice(0,100)||config.event.name||'Untitled match';
  const item:MatchArchive={id:`match_${now}_${randomBytes(4).toString('hex')}`,name:label,startedAt:now,endedAt:null,event:config.event.name,stage:config.event.stage,teams:config.teams.map(team=>team.name),maps:config.maps.map(map=>map.name),format:config.format,events:[]};
  this.archives.push(item);this.archives=this.archives.slice(-MAX_ARCHIVES);this.scheduleSave();return item;
 }
 finish(now=Date.now()):MatchArchive|null {const item=this.active;if(!item)return null;item.endedAt=now;this.scheduleSave();return item}
 addKill(event:KillEvent){const active=this.active;if(!active)return;active.events.push({at:event.at,type:'kill',data:event});this.trim(active);this.scheduleSave()}
 addRound(event:RoundEvent){const active=this.active;if(!active)return;active.events.push({at:event.endedAt,type:'round',data:event});this.trim(active);this.scheduleSave()}
 private trim(archive:MatchArchive){if(archive.events.length>MAX_ARCHIVED_EVENTS)archive.events.splice(0,archive.events.length-MAX_ARCHIVED_EVENTS)}
 private scheduleSave(){
  this.pending=this.pending.then(async()=>{await mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify({version:1,archives:this.archives},null,2));await rename(tmp,this.file)}).catch(error=>console.warn('[archive] could not persist match archive:',error instanceof Error?error.message:String(error)));
 }
 async flush(){await this.pending}
}
function validArchive(value:any):value is MatchArchive{return value&&typeof value.id==='string'&&typeof value.name==='string'&&Number.isFinite(value.startedAt)&&(value.endedAt===null||Number.isFinite(value.endedAt))&&Array.isArray(value.teams)&&Array.isArray(value.maps)&&Array.isArray(value.events)}
