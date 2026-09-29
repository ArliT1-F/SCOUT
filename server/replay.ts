import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
// Replays a `LOG_GSI=1` recording against a running host, keeping the recorded spacing (divided by
// --speed) so the store, schema validation and the broadcast clock see the same sequence the
// observer machine saw. Recording lines look like {"receivedAt":<ms>,"payload":{...}}.
export interface ReplayEntry {receivedAt:number;payload:Record<string,any>}
export interface ReplayOptions {url:string;token:string;speed:number;maxGap:number;limit:number;quiet:boolean;dry:boolean}
export interface ReplayResult {sent:number;failed:number;statuses:Record<number,number>}
export type Post=(url:string,init:{method:string;headers:Record<string,string>;body:string})=>Promise<{status:number}>;
export const defaultOptions:ReplayOptions={url:'http://127.0.0.1:8080/gsi',token:process.env.GSI_TOKEN||'CHANGE_ME',speed:1,maxGap:0,limit:0,quiet:false,dry:false};
export const usage=`npm run replay -- recordings/<file>.jsonl [options]

  --speed <n>     play the recording n times faster (default 1, real time)
  --url <url>     GSI endpoint of the running host (default http://127.0.0.1:8080/gsi)
  --token <t>     GSI token to authenticate with (default $GSI_TOKEN, then CHANGE_ME)
  --max-gap <ms>  cap idle gaps between packets, useful when skipping a long pause (default 0 = keep)
  --limit <n>     stop after n packets
  --quiet         only print the final summary
  --dry           print the plan without posting anything`;
export function parseArgs(argv:string[]):{file:string;options:ReplayOptions} {
 const options={...defaultOptions}, positional:string[]=[];
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--quiet') options.quiet=true;
  else if(arg==='--dry') options.dry=true;
  else if(arg.startsWith('--')){
   const [name,...rest]=arg.replace(/^--/,'').split('=');
   const value=rest.length?rest.join('='):argv[++i];
   if(value===undefined||value.startsWith('--')) throw new Error(`missing value for --${name}`);
   if(name==='speed') options.speed=Number(value);
   else if(name==='url') options.url=value;
   else if(name==='token') options.token=value;
   else if(name==='max-gap') options.maxGap=Number(value);
   else if(name==='limit') options.limit=Number(value);
   else throw new Error(`unknown option --${name}`);
  } else positional.push(arg);
 }
 const file=positional[0];
 if(!file) throw new Error(`expected a recording file\n\n${usage}`);
 if(positional.length>1) throw new Error(`unexpected extra argument ${positional[1]}`);
 if(!(options.speed>0)) throw new Error('--speed must be greater than 0');
 if(!(options.maxGap>=0)||!(options.limit>=0)) throw new Error('--max-gap and --limit cannot be negative');
 return {file,options};
}
export function parseReplay(text:string):ReplayEntry[] {
 const entries:ReplayEntry[]=[];
 text.split('\n').forEach((line,index)=>{
  if(!line.trim()) return;
  let parsed:any;
  try {parsed=JSON.parse(line)} catch {throw new Error(`line ${index+1} is not valid JSON`)}
  if(!parsed||typeof parsed!=='object'||typeof parsed.receivedAt!=='number'||!parsed.payload||typeof parsed.payload!=='object') throw new Error(`line ${index+1} is not a SCOUT recording entry (expected {"receivedAt":<ms>,"payload":{...}})`);
  entries.push({receivedAt:parsed.receivedAt,payload:parsed.payload});
 });
 if(!entries.length) throw new Error('recording contains no packets');
 return entries;
}
// Recorded spacing in milliseconds, scaled by --speed and clamped, never negative.
export function planDelays(entries:ReplayEntry[],speed=1,maxGap=0):number[] {
 return entries.map((entry,index)=>{
  if(index===0) return 0;
  const gap=Math.max(0,entry.receivedAt-entries[index-1].receivedAt);
  return Math.round((maxGap>0?Math.min(gap,maxGap):gap)/speed);
 });
}
function describe(payload:Record<string,any>):string {
 const map=payload.map?.name, round=payload.map?.round, phase=payload.round?.phase||payload.map?.phase;
 return [map,round!==undefined?`round ${Number(round)+1}`:undefined,phase].filter(Boolean).join(' · ')||'packet';
}
export async function replay(entries:ReplayEntry[],options:ReplayOptions,post:Post=fetch as unknown as Post):Promise<ReplayResult> {
 const delay=planDelays(entries,options.speed,options.maxGap);
 const total=options.limit>0?Math.min(options.limit,entries.length):entries.length;
 const result:ReplayResult={sent:0,failed:0,statuses:{}};
 let failures=0, lastTick=0;
 for(let i=0;i<total;i++){
  if(delay[i]>0) await new Promise(resolve=>setTimeout(resolve,delay[i]));
  if(options.dry){if(!options.quiet) console.log(`[replay] +${delay[i]}ms ${i+1}/${total} ${describe(entries[i].payload)}`);continue}
  let response:{status:number}|undefined, error:unknown;
  for(let attempt=0;attempt<3&&!response;attempt++){
   if(attempt) await new Promise(resolve=>setTimeout(resolve,500));
   try {response=await post(options.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...entries[i].payload,auth:{token:options.token}})})} catch(reason){error=reason}
  }
  if(!response){
   throw new Error(`no host answered POST ${options.url} (${error instanceof Error?error.message:String(error)}) — start the host with "npm run dev" first`);
  }
  result.statuses[response.status]=(result.statuses[response.status]||0)+1;
  if(response.status===200){result.sent++;failures=0}
  else if(response.status===401) throw new Error(`the host rejected every packet: token mismatch. Pass --token <cfg token> or start the host with a matching GSI_TOKEN.`);
  else {
   result.failed++; if(++failures>=3) throw new Error(`the host answered ${response.status} for 3 packets in a row — check the host log.`);
  }
  const now=Date.now();
  if(!options.quiet&&now-lastTick>1000){lastTick=now;console.log(`[replay] ${i+1}/${total} ${describe(entries[i].payload)} (${result.sent} accepted, ${result.failed} rejected)`)}
 }
 return result;
}
async function status(url:string):Promise<any|undefined> {
 try {const response=await fetch(url.replace(/\/gsi\/?$/,'/api/status')); return response.ok?await response.json():undefined} catch{return undefined}
}
export async function main(argv=process.argv.slice(2)):Promise<void> {
 const {file,options}=parseArgs(argv);
 const entries=parseReplay(await readFile(file,'utf8'));
 const span=entries[entries.length-1].receivedAt-entries[0].receivedAt;
 console.log(`[replay] ${file}: ${entries.length} packets over ${(span/1000).toFixed(1)}s of recorded time at speed ${options.speed}${options.dry?' (dry run)':` → ${options.url}`}`);
 const before=await status(options.url);
 const result=await replay(entries,options);
 if(options.dry) return;
 console.log(`[replay] done: ${result.sent} accepted, ${result.failed} rejected, statuses ${JSON.stringify(result.statuses)}`);
 const after=await status(options.url);
 if(before&&after){
  const merged=after.revision-before.revision, stale=(after.gsi?.rejectedLate||0)-(before.gsi?.rejectedLate||0);
  console.log(`[replay] host revision ${before.revision} → ${after.revision} (${merged} merged, ${stale} ignored as stale) · map ${after.state?.map?.name||'–'} · players ${Object.keys(after.state?.allplayers||{}).length}`);
  if(merged===0) console.warn('[replay] warning: HTTP accepted the packets but the store merged none — the host already holds newer provider timestamps. Restart the host first, or replay a newer recording.');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(`[replay] ${error instanceof Error?error.message:String(error)}`);process.exit(1)});
