import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Connecting CS2 without touching a folder. CS2 sends live match data to SCOUT through a Game State
// Integration file in its own cfg folder, and that file carries a token the host checks. Getting the
// file into the right folder with the right token and port was the one step an operator had to do by
// hand (the installer tries once; a second Steam library or a later reinstall of CS2 defeated it).
//
// This module finds CS2 the way the installer does (Steam's registry entry, then every library listed
// in libraryfolders.vdf), writes the file with this host's token and port, and makes sure the host has
// a private token to write: the built-in CHANGE_ME is replaced by a random one, kept in gsi_token.txt in
// the data directory, which is where the desktop app and the launcher read it on every start.

export const CFG_FILE='gamestate_integration_overlay.cfg';
export const DEFAULT_GSI_TOKEN='CHANGE_ME';
export const GSI_TOKEN_FILE='gsi_token.txt';
const CS2_CFG=path.join('steamapps','common','Counter-Strike Global Offensive','game','csgo','cfg');

// The cfg text. config/gamestate_integration_overlay.cfg is the same file with CHANGE_ME and port
// 8080; tests/cs2.test.ts keeps the two identical.
export function gsiCfg(token:string,port:number):string {
 return `"SCOUT broadcast overlay"
{
 "uri" "http://127.0.0.1:${port}/gsi"
 "timeout" "5.0"
 "buffer" "0.05"
 "throttle" "0.05"
 "heartbeat" "1.0"
 "auth" { "token" "${token}" }
 "data"
 {
  "provider" "1"
  "map" "1"
  "round" "1"
  "player_id" "1"
  "player_state" "1"
  "player_weapons" "1"
  "player_position" "1"
  "allplayers_id" "1"
  "allplayers_state" "1"
  "allplayers_match_stats" "1"
  "allplayers_weapons" "1"
  "allplayers_position" "1"
  "phase_countdowns" "1"
  "allgrenades" "1"
  "bomb" "1"
 }
}
`;
}
export const newGsiToken=()=>randomBytes(16).toString('hex');

// Library folders listed in steamapps/libraryfolders.vdf. Both the current format ("path" "D:\\Games")
// and the old one ("1" "D:\\Games") are read; backslashes are escaped in the file.
export function libraryFoldersFromVdf(text:string):string[]{
 const out:string[]=[];
 for(const match of text.matchAll(/^\s*"(?:path|\d+)"\s+"([^"]+)"\s*$/gm)){
  const value=match[1].replace(/\\\\/g,'\\');
  if(/[\\/]/.test(value)) out.push(value);
 }
 return out;
}

const regQuery=(key:string,value:string)=>new Promise<string>(resolve=>{
 execFile('reg',['query',key,'/v',value],{timeout:4000,windowsHide:true},(error,stdout)=>{
  if(error){resolve('');return}
  const line=String(stdout).split(/\r?\n/).find(row=>row.includes(value)&&row.includes('REG_'));
  resolve(line?line.replace(/^.*REG_\w+\s+/,'').trim():'');
 });
});

export interface Cs2Search {platform:NodeJS.Platform;env:Record<string,string|undefined>;home:string;steamRoots:()=>Promise<string[]>;exists:(file:string)=>boolean;read:(file:string)=>Promise<string>}
const defaultSearch=():Cs2Search=>({
 platform:process.platform,env:process.env,home:os.homedir(),exists:existsSync,read:file=>readFile(file,'utf8'),
 steamRoots:async()=>process.platform==='win32'
  ?[await regQuery('HKCU\\Software\\Valve\\Steam','SteamPath'),await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam','InstallPath'),await regQuery('HKLM\\SOFTWARE\\Valve\\Steam','InstallPath')]
  :[],
});

// Every CS2 cfg folder on this machine, most likely first. SCOUT_CS2_CFG_DIR names one explicitly.
export async function findCs2CfgDirs(search:Cs2Search=defaultSearch()):Promise<string[]>{
 const p=search.platform==='win32'?path.win32:path.posix;
 const roots:string[]=[];
 const add=(dir?:string)=>{if(dir&&!roots.some(r=>r.toLowerCase()===p.normalize(dir).toLowerCase())) roots.push(p.normalize(dir))};
 for(const root of await search.steamRoots()) add(root.replace(/\//g,search.platform==='win32'?'\\':'/'));
 if(search.platform==='win32') for(const drive of [search.env['ProgramFiles(x86)']||'C:\\Program Files (x86)',search.env.ProgramFiles||'C:\\Program Files']) add(p.join(drive,'Steam'));
 else if(search.platform==='darwin') add(p.join(search.home,'Library','Application Support','Steam'));
 else for(const dir of [p.join(search.home,'.steam','steam'),p.join(search.home,'.local','share','Steam')]) add(dir);
 for(const root of [...roots]){
  try{for(const library of libraryFoldersFromVdf(await search.read(p.join(root,'steamapps','libraryfolders.vdf')))) add(library)}catch{}
 }
 const found:string[]=[];
 const explicit=search.env.SCOUT_CS2_CFG_DIR?.trim();
 if(explicit&&search.exists(explicit)) found.push(explicit);
 for(const root of roots){
  const cfg=p.join(root,CS2_CFG.split(path.sep).join(p.sep));
  if(search.exists(cfg)&&!found.includes(cfg)) found.push(cfg);
 }
 return found;
}

export interface Cs2Status {
 /** CS2 cfg folders found on this machine. Never shown as full paths in the website, only here. */
 folders:{dir:string;installed:boolean;current:boolean}[];
 tokenSet:boolean;
 port:number;
}
export interface Cs2Connection {status():Promise<Cs2Status>;connect(options?:{newToken?:boolean}):Promise<Cs2Status&{written:string[]}>}

// The host's half: knows the token and the port, writes the file. `dataDir` is the working directory,
// where gsi_token.txt lives; `setToken` updates the running host so CS2's next packet is accepted.
export function cs2Connection(options:{port:number;dataDir?:string;token:()=>string;setToken:(token:string)=>void;search?:()=>Promise<string[]>}):Cs2Connection{
 const dataDir=options.dataDir||process.cwd();
 const search=options.search||(()=>findCs2CfgDirs());
 const describe=async(written:string[]=[]):Promise<Cs2Status>=>{
  const token=options.token();
  const expected=gsiCfg(token,options.port);
  const folders=await Promise.all((await search()).map(async dir=>{
   const file=path.join(dir,CFG_FILE);
   let text:string|null=null;try{text=await readFile(file,'utf8')}catch{}
   return {dir,installed:text!==null,current:text!==null&&text.replace(/\r\n/g,'\n')===expected};
  }));
  return {folders,tokenSet:token!==DEFAULT_GSI_TOKEN,port:options.port};
 };
 return {
  status:()=>describe(),
  async connect({newToken=false}={}){
   let token=options.token();
   if(newToken||!token||token===DEFAULT_GSI_TOKEN){
    token=newGsiToken();
    await writeFile(path.join(dataDir,`${GSI_TOKEN_FILE}.tmp`),token+'\n',{mode:0o600});
    await rename(path.join(dataDir,`${GSI_TOKEN_FILE}.tmp`),path.join(dataDir,GSI_TOKEN_FILE));
    options.setToken(token);
   }
   const text=gsiCfg(token,options.port);
   // The data directory's own copy stays current too: it is what the setup guide points at.
   await mkdir(path.join(dataDir,'config'),{recursive:true});
   await writeFile(path.join(dataDir,'config',CFG_FILE),text);
   const written:string[]=[];
   for(const dir of await search()){
    try{await writeFile(path.join(dir,CFG_FILE),text);written.push(dir)}catch{}
   }
   return {...await describe(),written};
  },
 };
}