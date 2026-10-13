import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeConfig} from '../../server/config.js';

const repository=fileURLToPath(new URL('../..',import.meta.url));
export const hostConfig=()=>normalizeConfig({event:{name:'Host cup'},teams:[{id:'a',name:'Alpha'},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage'}]});
/** Real index.ts, isolated writable data, and readiness signalled by its startup log (no polling). */
export async function platformHost(t:{after:(fn:()=>Promise<void>)=>void},extra:NodeJS.ProcessEnv={},prepare?:(directory:string)=>Promise<void>){
 const directory=await mkdtemp(path.join(tmpdir(),'scout-platform-host-'));await mkdir(path.join(directory,'config'),{recursive:true});
 await writeFile(path.join(directory,'config','teams.json'),JSON.stringify(hostConfig()));await writeFile(path.join(directory,'config','radars.json'),JSON.stringify({overviewSize:1024,maps:{}}));
 const port=await new Promise<number>(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const a=probe.address();probe.close(()=>resolve(typeof a==='object'&&a?a.port:0))})});
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('SCOUT_')||key.startsWith('OBS_')||['PORT','HOST','NODE_ENV','LOG_GSI'].includes(key))delete env[key];
 Object.assign(env,{PORT:String(port),NODE_ENV:'production',SCOUT_APP_ROOT:repository,SCOUT_PANEL_TOKEN:'platform-route-test-panel-token',GSI_TOKEN:'platform-route-test-gsi-token',SCOUT_OWNER_EMAIL:'owner@example.com',...extra});
 if(prepare)await prepare(directory);
 const child=spawn(process.execPath,[path.join(repository,'node_modules','tsx','dist','cli.mjs'),path.join(repository,'server','index.ts')],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr!.on('data',buffer=>{logs+=buffer.toString()});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')})}
  await rm(directory,{recursive:true,force:true});
 });
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Platform host did not start: '+logs)),30_000);
  child.once('error',error=>{clearTimeout(timer);reject(error)});
  child.once('exit',()=>{clearTimeout(timer);reject(Error('Platform host exited: '+logs))});
  child.stdout!.on('data',buffer=>{logs+=buffer.toString();if(logs.includes('SCOUT host ready on port')){clearTimeout(timer);resolve()}});
 });
 const url=`http://127.0.0.1:${port}`;
 const request=async(route:string,body?:unknown,options:{method?:string;cookie?:string;headers?:Record<string,string>}={})=>{
  const res=await fetch(url+route,{method:options.method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(options.cookie?{Cookie:options.cookie}:{}),...options.headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  const text=await res.text();let json:any=null;try{json=JSON.parse(text)}catch{}
  return {status:res.status,body:json,cookie:(res.headers.getSetCookie?.()??[]).map(c=>c.split(';')[0]).join('; ')};
 };
 return {directory,url,request};
}
