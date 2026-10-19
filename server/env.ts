import {readFileSync} from 'node:fs';
import path from 'node:path';
// A small, dependency-free `.env` reader for the host and the account service.
//
// Why this exists at all: SCOUT is configured entirely through environment variables (PORT,
// GSI_TOKEN, SCOUT_OWNER_EMAIL, …), and a Windows install has no shell wrapper to put them in. The
// `dotenv` package would do the same job, but it is a runtime dependency for the packaged host and
// this repository deliberately keeps that tree tiny (express, ws, zod — see installer/README.md).
// Forty lines of parsing is the whole feature.
//
// Rules that matter, and are tested in tests/env.test.ts:
//   - a real environment variable ALWAYS wins; `.env` only fills names that are unset or empty, so
//     `SCOUT_OWNER_EMAIL=… npm start` overrides a stale file without editing it;
//   - the file is optional: a missing `.env` is not an error and prints nothing;
//   - no expansion, no `export` weirdness beyond a tolerated prefix, no multi-line values. Values
//     may be bare, single-quoted (literal) or double-quoted (with \n, \r, \t, \" and \\);
//   - a malformed line is reported with its line number and skipped; the rest still loads, because
//     a typo in one setting must not stop a broadcast;
//   - nothing is ever written back, logged with its value, or exposed through an API.
//
// SCOUT_ENV_FILE points at a different file (absolute, or relative to the working directory).
export const ENV_FILE_NAME='.env';
export interface EnvFileResult {
  /** Absolute path that was tried. */
  file:string;
  /** False when the file does not exist — the normal case in a checkout. */
  found:boolean;
  /** Keys taken from the file. */
  applied:string[];
  /** Keys left alone because the real environment already set them. */
  kept:string[];
  /** Human-readable problems; already logged by loadEnvFile(). */
  errors:string[];
}

type Env=Record<string,string|undefined>;
const KEY=/^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse `.env` text into key/value pairs. Per-line problems go to `errors` instead of throwing, so
 * one typo does not discard the rest of the file.
 */
export function parseEnv(text:string):{values:Record<string,string>;errors:string[]}{
  const values:Record<string,string>={};
  const errors:string[]=[];
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  lines.forEach((raw,index)=>{
    const lineNumber=index+1;
    let line=raw.trim();
    if(!line||line.startsWith('#')) return;
    // `export NAME=value` is common in shell-flavoured files; tolerate it rather than skipping the line.
    if(line.startsWith('export ')) line=line.slice(7).trimStart();
    const match=/^([^=\s]+)\s*=\s*([\s\S]*)$/.exec(line);
    if(!match){errors.push(`line ${lineNumber}: expected NAME=value`);return}
    const key=match[1];
    if(!KEY.test(key)){errors.push(`line ${lineNumber}: "${key}" is not a valid variable name`);return}
    try{values[key]=parseValue(match[2])}
    catch(error:any){errors.push(`line ${lineNumber}: ${error?.message||String(error)}`)}
  });
  return {values,errors};
}

function parseValue(raw:string):string{
  const value=raw.trim();
  if(!value) return '';
  const quote=value[0];
  if(quote==='"'||quote==="'"){
    let out='',index=1,closed=false;
    for(;index<value.length;index++){
      const char=value[index];
      if(char==='\\'&&quote==='"'&&index+1<value.length){
        const next=value[++index];
        out+=next==='n'?'\n':next==='r'?'\r':next==='t'?'\t':next;
        continue;
      }
      if(char===quote){closed=true;index++;break}
      out+=char;
    }
    if(!closed) throw Error('unterminated quoted value');
    const rest=value.slice(index).trim();
    if(rest&&!rest.startsWith('#')) throw Error('unexpected text after the closing quote');
    return out;
  }
  // Unquoted: a `#` starts a comment only when whitespace separates it from the value, so
  // `GSI_TOKEN=abc#def` keeps its literal `#` and `PORT=8080 # dev` does not.
  const comment=value.search(/\s#/);
  return (comment===-1?value:value.slice(0,comment)).trim();
}

const isSet=(env:Env,key:string)=>env[key]!==undefined&&env[key]!=='';

/** Fill `env` from parsed values. Never overwrites a name the environment already set. */
export function applyEnv(values:Record<string,string>,env:Env=process.env):{applied:string[];kept:string[]}{
  const applied:string[]=[],kept:string[]=[];
  for(const [key,value] of Object.entries(values)){
    if(isSet(env,key)){kept.push(key);continue}
    env[key]=value;applied.push(key);
  }
  return {applied,kept};
}

/**
 * Load `.env` into `process.env`. Safe to call once per process at startup: never throws, prints
 * at most one line, and reports a missing file as `found:false` without noise.
 */
export function loadEnvFile(
  file?:string,
  env:Env=process.env,
  log:(message:string)=>void=message=>console.log(message),
):EnvFileResult{
  const target=path.resolve(file||env.SCOUT_ENV_FILE?.trim()||ENV_FILE_NAME);
  const result:EnvFileResult={file:target,found:false,applied:[],kept:[],errors:[]};
  let text:string;
  try{text=readFileSync(target,'utf8')}
  catch(error:any){
    if(error?.code!=='ENOENT') log(`[env] could not read ${target}: ${error?.message||String(error)}`);
    return result;
  }
  result.found=true;
  const parsed=parseEnv(text);
  result.errors=parsed.errors;
  for(const problem of parsed.errors) log(`[env] ${target}: ${problem}`);
  Object.assign(result,applyEnv(parsed.values,env));
  if(result.applied.length) log(`[env] loaded ${result.applied.length} setting(s) from ${target}: ${result.applied.join(', ')}`);
  if(result.kept.length) log(`[env] kept ${result.kept.length} setting(s) from the real environment: ${result.kept.join(', ')}`);
  return result;
}
