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
// Archive schema v2, additive so every v1 file still loads: a per-round player snapshot at the moment
// the round ends. GSI reports assists, MVPs and per-round damage only in the live state, so this is
// the one chance to keep them. Without a snapshot the recap says "not captured" instead of guessing.
export interface SnapshotPlayer {steamid:string;name:string;side:string;kills:number;deaths:number;assists:number;mvps:number;roundKills:number;roundKillhs:number;roundDamage:number;teamIndex:number}
export interface RoundSnapshot {at:number;map:string;round:number;players:SnapshotPlayer[]}
// Highlight markers (follow-up §4). A marker is a wall-clock instant inside the archive, so it can be
// turned into a timecode for an editor and into a seek position for Replay Studio without guessing.
export interface ClipMarker {
 id:string; at:number; label:string; kind:'kill'|'round'|'manual';
 round:number|null; map:string; steamid:string;
}
export const MAX_MARKERS=500;
export function markerTimecode(startedAt:number,at:number):string {
 const total=Math.max(0,Math.round(at-startedAt));
 const hours=Math.floor(total/3_600_000),minutes=Math.floor((total%3_600_000)/60_000),seconds=Math.floor((total%60_000)/1000),ms=total%1000;
 const pad=(value:number,width=2)=>String(value).padStart(width,'0');
 return `${pad(hours,2)}:${pad(minutes)}:${pad(seconds)}.${pad(ms,3)}`;
}
export function markersCsv(archive:MatchArchive):string {
 const rows:string[][]=[['marker','kind','timecode','seconds','label','map','round','steamid']];
 for(const marker of [...(archive.markers??[])].sort((first,second)=>first.at-second.at)){
  const seconds=((marker.at-archive.startedAt)/1000).toFixed(3);
  rows.push([marker.id,marker.kind,markerTimecode(archive.startedAt,marker.at),seconds,marker.label,marker.map,marker.round===null?'':String(marker.round),marker.steamid]);
 }
 return rows.map(row=>row.map(value=>{const safe=/^[=+\-@]/.test(value)?`'${value}`:value;return /[",\n]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe}).join(',')).join('\n')+'\n';
}
export interface RecapDelivery {at:number;status:'delivered'|'failed';target:'discord'|'webhook';detail:string}
export interface MatchArchive {id:string;name:string;startedAt:number;endedAt:number|null;event:string;stage:string;teams:string[];maps:string[];format:string;events:ArchivedEvent[];snapshots?:RoundSnapshot[];markers?:ClipMarker[];delivery?:RecapDelivery|null}
export interface ArchiveSummary extends Omit<MatchArchive,'events'|'snapshots'|'markers'>{eventCount:number;kills:number;rounds:number;hasSnapshot:boolean;markers:number;delivery:RecapDelivery|null}
const MAX_ARCHIVES=40,MAX_ARCHIVED_EVENTS=10_000,MAX_SNAPSHOTS=200;
export class MatchArchiveStore {
 private archives:MatchArchive[]=[];private pending:Promise<void>=Promise.resolve();
 constructor(private readonly file='recordings/matches.json'){}
 async load(){
  try{const parsed=JSON.parse(await readFile(this.file,'utf8'));if(parsed?.version===1&&Array.isArray(parsed.archives))this.archives=parsed.archives.filter(validArchive).slice(-MAX_ARCHIVES)}catch{}
 }
 get active(){return this.archives.slice().reverse().find(archive=>!archive.endedAt)||null}
 list():ArchiveSummary[]{return this.archives.slice().reverse().map(archive=>({id:archive.id,name:archive.name,startedAt:archive.startedAt,endedAt:archive.endedAt,event:archive.event,stage:archive.stage,teams:archive.teams,maps:archive.maps,format:archive.format,eventCount:archive.events.length,kills:archive.events.filter(event=>event.type==='kill').length,rounds:archive.events.filter(event=>event.type==='round').length,hasSnapshot:Boolean(archive.snapshots?.length),markers:archive.markers?.length??0,delivery:archive.delivery??null}))}
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
 addSnapshot(snapshot:RoundSnapshot){
  const active=this.active;if(!active)return;
  // One snapshot per round per map: a late-arriving duplicate must not double-count damage.
  const existing=(active.snapshots??[]).findIndex(entry=>entry.map===snapshot.map&&entry.round===snapshot.round);
  const snapshots=active.snapshots??[];
  if(existing>=0) snapshots[existing]=snapshot; else snapshots.push(snapshot);
  active.snapshots=snapshots.slice(-MAX_SNAPSHOTS);
  this.scheduleSave();
 }
 // Markers are bounded and de-duplicated by id; the label is operator text, capped like every other
 // free-text field that ends up in a CSV.
 addMarker(id:string,marker:ClipMarker){const item=this.detail(id);if(!item)return null;const markers=(item.markers??[]).filter(existing=>existing.id!==marker.id);markers.push({...marker,label:marker.label.slice(0,120)});item.markers=markers.slice(-MAX_MARKERS);this.scheduleSave();return item.markers}
 removeMarker(id:string,markerId:string){const item=this.detail(id);if(!item)return null;item.markers=(item.markers??[]).filter(marker=>marker.id!==markerId);this.scheduleSave();return item.markers}
 setDelivery(id:string,delivery:RecapDelivery){const item=this.detail(id);if(!item)return null;item.delivery=delivery;this.scheduleSave();return item}
 private trim(archive:MatchArchive){if(archive.events.length>MAX_ARCHIVED_EVENTS)archive.events.splice(0,archive.events.length-MAX_ARCHIVED_EVENTS)}
 private scheduleSave(){
  this.pending=this.pending.then(async()=>{await mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify({version:1,archives:this.archives},null,2));await rename(tmp,this.file)}).catch(error=>console.warn('[archive] could not persist match archive:',error instanceof Error?error.message:String(error)));
 }
 async flush(){await this.pending}
}
function validArchive(value:any):value is MatchArchive{return value&&typeof value.id==='string'&&typeof value.name==='string'&&Number.isFinite(value.startedAt)&&(value.endedAt===null||Number.isFinite(value.endedAt))&&Array.isArray(value.teams)&&Array.isArray(value.maps)&&Array.isArray(value.events)}
