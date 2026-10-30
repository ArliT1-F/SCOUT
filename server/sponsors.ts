// Sponsors (docs/LAUNCH-FEATURES.md follow-up §1): a rotation of uploaded graphics that can be
// dropped into any scene, plus the proof-of-play numbers an organiser has to show a sponsor.
//
// The rotation itself is in server/sponsor-rotation.ts, because the overlay and the studio import it
// in the browser and it must not pull a filesystem in. This file is the host half: the ledger and CSV.
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {SPONSOR_ASSET,type SponsorSlot} from './sponsor-rotation.js';
export * from './sponsor-rotation.js';

export interface SponsorImpression {at:number;sponsorId:string;sponsorName:string;scene:string;bucket:number}
export interface SponsorReportRow {id:string;name:string;impressions:number;scenes:Record<string,number>;share:number}
export interface SponsorReport {from:number;to:number;total:number;rows:SponsorReportRow[]}
// Proof-of-play. Bounded and append-only: a long event is a few thousand ticks, not a database. The
// file is replaced atomically on every write, exactly like the other small host state files.
export class SponsorLedger {
 private entries:SponsorImpression[]=[];
 private writes:Promise<void>=Promise.resolve();
 constructor(private readonly file='config/sponsor-impressions.json',private readonly cap=5000){}
 async load(){
  try{
   const parsed=JSON.parse(await readFile(this.file,'utf8'));
   if(Array.isArray(parsed?.entries)) this.entries=parsed.entries.filter((entry:any)=>entry&&typeof entry.sponsorId==='string'&&Number.isFinite(entry.at)).slice(-this.cap);
  }catch{}
  return this;
 }
 get size(){return this.entries.length}
 // One impression per sponsor per scene per rotation step. The host samples the clock on a short
 // timer, so several samples inside the same step must collapse into one number.
 record(entry:SponsorImpression):boolean {
  if(!entry.sponsorId||!Number.isFinite(entry.at)) return false;
  const last=[...this.entries].reverse().find(candidate=>candidate.sponsorId===entry.sponsorId&&candidate.scene===entry.scene);
  if(last&&last.bucket===entry.bucket) return false;
  this.entries.push(entry);
  if(this.entries.length>this.cap) this.entries=this.entries.slice(-this.cap);
  this.writes=this.writes.then(async()=>{
   await mkdir(path.dirname(this.file),{recursive:true});
   await writeFile(`${this.file}.tmp`,JSON.stringify({version:1,entries:this.entries}),{mode:0o600});
   await rename(`${this.file}.tmp`,this.file);
  }).catch(()=>{});
  return true;
 }
 async flush(){await this.writes}
 reset():Promise<void>{this.entries=[];return this.flush()}
 report(options:{from?:number;to?:number;now?:number}={}):SponsorReport {
  const now=options.now??Date.now();
  const from=options.from??now-30*86_400_000;
  const to=options.to??now;
  const rows=new Map<string,SponsorReportRow>();
  for(const entry of this.entries){
   if(entry.at<from||entry.at>to) continue;
   const row=rows.get(entry.sponsorId)??{id:entry.sponsorId,name:entry.sponsorName,impressions:0,scenes:{},share:0};
   row.impressions++;
   row.scenes[entry.scene]=(row.scenes[entry.scene]??0)+1;
   row.name=entry.sponsorName||row.name;
   rows.set(entry.sponsorId,row);
  }
  const list=[...rows.values()].sort((first,second)=>second.impressions-first.impressions||first.name.localeCompare(second.name));
  const total=list.reduce((sum,row)=>sum+row.impressions,0);
  for(const row of list) row.share=total?Math.round((row.impressions/total)*1000)/10:0;
  return {from,to,total,rows:list};
 }
}
// The spreadsheet an organiser forwards to the sponsor. Same formula-neutralising rule as the recap.
export function sponsorCsv(report:SponsorReport):string {
 const rows:string[][]=[['sponsor','impressions','share_percent','scenes','from','to']];
 for(const row of report.rows){
  rows.push([row.name,String(row.impressions),String(row.share),Object.entries(row.scenes).map(([scene,count])=>`${scene}:${count}`).join(' '),new Date(report.from).toISOString(),new Date(report.to).toISOString()]);
 }
 return rows.map(row=>row.map(value=>{const safe=/^[=+\-@]/.test(value)?`'${value}`:value;return /[",\n]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe}).join(',')).join('\n')+'\n';
}
// A new id that survives the schema's character rule and stays readable in a written report.
export function sponsorId(){return `sponsor_${randomBytes(3).toString('hex')}`}
