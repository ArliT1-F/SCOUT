import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
// The start.gg API token, saved from the panel so an operator types it once per machine instead of
// editing .env. It lives in config/startgg.json (gitignored, never in an event pack, never synced to
// the platform) and only the owner can set or remove it. The API never returns it: the panel sees
// whether one is set, where it comes from, and its last four characters so a replaced token can be
// told apart from the old one.
//
// Which token a request uses: one pasted into the import form for that request, then the saved one,
// then SCOUT_STARTGG_TOKEN from the environment.

export const STARTGG_TOKEN_FILE='config/startgg.json';
export type StartggTokenSource='panel'|'env'|null;
export interface StartggTokenView {tokenSet:boolean;source:StartggTokenSource;hint:string|null}

// start.gg personal access tokens are long hex strings. The bounds only refuse what cannot be one:
// an accidental paste of a sentence, a URL, or an empty field.
export function validStartggToken(value:string):boolean {
 return /^[^\s]{8,400}$/.test(value)&&!/^https?:/i.test(value);
}
const hintOf=(token:string)=>token.length>=12?token.slice(-4):null;

export class StartggTokenStore {
 private saved='';
 constructor(private readonly file=STARTGG_TOKEN_FILE,private readonly env:Record<string,string|undefined>=process.env){}
 async load():Promise<this>{
  try{
   const parsed=JSON.parse(await readFile(this.file,'utf8'));
   const token=typeof parsed?.token==='string'?parsed.token.trim():'';
   this.saved=validStartggToken(token)?token:'';
  }catch(error:any){
   if(error?.code!=='ENOENT') console.warn(`[start.gg] ${this.file} could not be read — import will use SCOUT_STARTGG_TOKEN if set`);
   this.saved='';
  }
  return this;
 }
 private envToken(){return String(this.env.SCOUT_STARTGG_TOKEN||'').trim()}
 // The token for one request: the form's own, else the saved one, else the environment's.
 tokenFor(supplied?:string):string {return String(supplied||'').trim()||this.saved||this.envToken()}
 view():StartggTokenView {
  const source:StartggTokenSource=this.saved?'panel':this.envToken()?'env':null;
  const token=this.saved||this.envToken();
  return {tokenSet:!!source,source,hint:token?hintOf(token):null};
 }
 async save(token:string):Promise<StartggTokenView>{
  const value=token.trim();
  if(!validStartggToken(value)) throw new Error('That does not look like a start.gg API token.');
  await mkdir(path.dirname(this.file),{recursive:true});
  // Atomic and readable by this user only (the mode matters on Linux/macOS; Windows keeps the data
  // folder's own permissions).
  await writeFile(`${this.file}.tmp`,JSON.stringify({token:value},null,2),{mode:0o600});
  await rename(`${this.file}.tmp`,this.file);
  this.saved=value;
  return this.view();
 }
 async clear():Promise<StartggTokenView>{
  try{await unlink(this.file)}catch(error:any){if(error?.code!=='ENOENT') throw error}
  this.saved='';
  return this.view();
 }
}
