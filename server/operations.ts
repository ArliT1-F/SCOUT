import {mkdir,readFile,rename,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
// Distributing the launcher, and knowing whether the thing is healthy.
//
// Two small desks that belong to whoever runs the deployment rather than to a broadcast:
//
//   * ReleaseRegistry — which installer the dashboard hands out. Publishing is an operator action:
//     build `SCOUT-Setup-<version>.exe` (`npm run package:windows`), drop it in `public/download/`,
//     publish it here, and every approved account's dashboard points at it. A release can also point
//     at an external URL (a CDN, a GitHub release) when the file is not served by this host.
//   * RequestLog — a bounded in-memory view of what this host has been asked for, so the operations
//     tab can answer "is anything failing?" and "did anybody download the beta?" without a log
//     pipeline. It is deliberately memory-only: a host that restarts (an update, a reboot at the
//     venue) starts clean, and nothing about an operator's traffic is written to disk.
export interface ReleaseInfo {
 version:string;
 /** Basename under public/download/, or null when the release points somewhere else. */
 file:string|null;
 url:string;
 notes:string;
 publishedAt:number;
 publishedBy:string;
 downloads:number;
 sizeBytes:number|null;
}
export type ReleaseDecision={ok:true;release:ReleaseInfo}|{ok:false;message:string};
export const VERSION_PATTERN=/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
export class ReleaseRegistry {
 private releases:ReleaseInfo[]=[];
 constructor(private readonly file:string,private readonly downloadDir:string,private readonly now:()=>number=Date.now){}
 async load(){
  try{
   const parsed=JSON.parse(await readFile(this.file,'utf8'));
   if(Array.isArray(parsed?.releases)) this.releases=parsed.releases.filter((entry:any)=>entry&&typeof entry.version==='string');
  }catch(error:any){if(error?.code!=='ENOENT')console.warn('[ops] the release list is unreadable — starting from none published:',error.message)}
  return this;
 }
 async save(){
  await mkdir(path.dirname(this.file),{recursive:true});
  await writeFile(this.file+'.tmp',JSON.stringify({version:1,releases:this.releases},null,2));
  await rename(this.file+'.tmp',this.file);
 }
 list(){return [...this.releases].sort((a,b)=>b.publishedAt-a.publishedAt)}
 latest(){return this.list()[0]??null}
 /** Publishing the same version again replaces it: an operator fixing a bad upload is normal. */
 async publish(input:{version:string;file?:string;url?:string;notes?:string;by:string}):Promise<ReleaseDecision>{
  const version=input.version.trim().replace(/^v/,'');
  if(!VERSION_PATTERN.test(version)) return {ok:false,message:'Use a version like 0.4.1 (optionally with -beta.2).'};
  const file=input.file?path.basename(input.file.trim()):null;
  let url=(input.url||'').trim();
  let sizeBytes:number|null=null;
  if(file){
   if(!/\.exe$/i.test(file)) return {ok:false,message:'The installer file name must end in .exe.'};
   try{sizeBytes=(await stat(path.join(this.downloadDir,file))).size}
   catch{return {ok:false,message:`No ${file} in the download folder yet. Build it with npm run package:windows and copy it into public/download/.`}}
   url=url||`/download/${encodeURIComponent(file)}`;
  }
  if(!/^https?:\/\/|^\//.test(url)) return {ok:false,message:'Give either a file in the download folder or an http(s) URL.'};
  const existing=this.releases.find(entry=>entry.version===version);
  const release:ReleaseInfo={version,file,url,notes:(input.notes||'').slice(0,400),publishedAt:this.now(),publishedBy:input.by,downloads:existing?.downloads??0,sizeBytes};
  this.releases=[release,...this.releases.filter(entry=>entry.version!==version)];
  await this.save();
  return {ok:true,release};
 }
 async retire(version:string){
  const before=this.releases.length;
  this.releases=this.releases.filter(entry=>entry.version!==version);
  if(this.releases.length!==before) await this.save();
  return this.releases.length!==before;
 }
 /** Counted when the dashboard hands a file out; the tally is what tells an operator how the beta is going. */
 async noteDownload(name:string){
  const base=path.basename(name);
  const release=this.releases.find(entry=>entry.file===base);
  if(!release) return false;
  release.downloads++;
  await this.save().catch(()=>{});
  return true;
 }
}
export interface RequestEntry {at:number;method:string;path:string;status:number;ms:number;address:string}
export interface RequestSummary {total:number;byClass:{ok:number;redirect:number;clientError:number;serverError:number};top:Array<{path:string;count:number}>;recent:RequestEntry[];windowMs:number}
export class RequestLog {
 private entries:RequestEntry[]=[];
 private counters=new Map<string,number>();
 private total=0;
 constructor(private readonly capacity=400,private readonly windowMs=15*60*1000,private readonly now:()=>number=Date.now){}
 record(entry:RequestEntry){
  this.total++;
  this.entries.push(entry);
  if(this.entries.length>this.capacity) this.entries.splice(0,this.entries.length-this.capacity);
  const key=`${entry.method} ${entry.path.replace(/\/[0-9a-f-]{6,}$/i,'/:id')}`;
  this.counters.set(key,(this.counters.get(key)||0)+1);
 }
 summary():RequestSummary{
  const since=this.now()-this.windowMs;
  const recent=this.entries.filter(entry=>entry.at>=since);
  const byClass={ok:0,redirect:0,clientError:0,serverError:0};
  for(const entry of recent){
   if(entry.status>=500) byClass.serverError++;
   else if(entry.status>=400) byClass.clientError++;
   else if(entry.status>=300) byClass.redirect++;
   else byClass.ok++;
  }
  const top=[...this.counters.entries()].map(([route,count])=>({path:route,count})).sort((a,b)=>b.count-a.count).slice(0,8);
  return {total:this.total,byClass,top,recent:[...recent].reverse().slice(0,40),windowMs:this.windowMs};
 }
}
// What an operator should look at, derived from the desks above. Ranked, never more than a handful:
// a wall of green ticks is not a health check.
export interface AttentionItem {level:'info'|'warn'|'bad';title:string;detail:string}
export interface HealthInput {
 startedAt:number;version:string;pid:number;
 beta:{mode:string;applications:{pending:number;approved:number;rejected:number};devices:number};
 licence:{state:string;enforced:boolean;email:string|null}|null;
 releases:{published:number;latest:string|null;downloads:number};
 requests:RequestSummary;
 output:{clients:number;gsiPackets:number;gsiAgeMs:number|null;gsiRejected:number;recording:boolean};
}
export interface HealthSnapshot extends HealthInput {uptimeMs:number;attention:AttentionItem[];generatedAt:number}
export function healthSnapshot(input:HealthInput,now=Date.now()):HealthSnapshot{
 const attention:AttentionItem[]=[];
 const {beta,licence,releases,requests,output}=input;
 if(output.gsiAgeMs===null) attention.push({level:'info',title:'No CS2 feed yet',detail:'Waiting for the first GSI packet. Start CS2 with the GSI config installed, or use the panel demo feed.'});
 else if(output.gsiAgeMs>5000) attention.push({level:'warn',title:'CS2 feed is stale',detail:`The last GSI packet arrived ${Math.round(output.gsiAgeMs/1000)} s ago.`});
 if(output.gsiRejected>0) attention.push({level:'warn',title:`${output.gsiRejected} GSI packet(s) rejected`,detail:'Usually a token mismatch between the Game State Integration cfg and GSI_TOKEN.'});
 if(requests.byClass.serverError>0) attention.push({level:'bad',title:`${requests.byClass.serverError} server error(s) in the last ${Math.round(requests.windowMs/60000)} min`,detail:'Look at the recent requests below for the failing route.'});
 if(beta.mode==='local'&&beta.applications.pending>0) attention.push({level:'info',title:`${beta.applications.pending} beta application(s) waiting`,detail:'Approve or reject them from the Beta applications tab.'});
 if(licence&&licence.enforced&&licence.state!=='active') attention.push({level:'bad',title:'Licence is not active',detail:`This installation reports "${licence.state}". The launcher refuses to run while SCOUT_REQUIRE_LICENCE=1.`});
 if(!releases.published) attention.push({level:'info',title:'No launcher release published',detail:'The dashboard points at the default download URL. Publish the installer here to host it yourself.'});
 if(input.output.clients===0) attention.push({level:'info',title:'No output connected',detail:'No OBS browser source or wall display has loaded /obs yet.'});
 return {...input,uptimeMs:now-input.startedAt,attention,generatedAt:now};
}
