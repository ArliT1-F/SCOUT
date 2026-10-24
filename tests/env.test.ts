import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv,applyEnv,loadEnvFile} from '../server/env.js';
import {platformHost} from './helpers/platform-host.js';

const repository=fileURLToPath(new URL('..',import.meta.url));
const temporary=async(t:any)=>{
  const dir=await mkdtemp(path.join(tmpdir(),'scout-env-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
};

test('parses comments, export prefixes, quoting and inline comments',()=>{
  const {values,errors}=parseEnv(`
# a comment
PORT=8080
export SCOUT_REMOTE=off
SCOUT_OWNER_EMAIL = " Owner@Example.com "   # inline comment after the quote
DOUBLE="line\\nbreak\\tand \\"quotes\\""
SINGLE='literal \\n stays'
HASH=abc#def
SPACED_HASH=abc # comment
EMPTY=
`);
  assert.deepEqual(errors,[]);
  assert.equal(values.PORT,'8080');
  assert.equal(values.SCOUT_REMOTE,'off');
  assert.equal(values.SCOUT_OWNER_EMAIL,' Owner@Example.com ');
  assert.equal(values.DOUBLE,'line\nbreak\tand "quotes"');
  assert.equal(values.SINGLE,'literal \\n stays');
  assert.equal(values.HASH,'abc#def');
  assert.equal(values.SPACED_HASH,'abc');
  assert.equal(values.EMPTY,'');
});

test('a malformed line is reported with its number and does not discard the rest',()=>{
  const {values,errors}=parseEnv('GOOD=1\nthis is not an assignment\nBAD-NAME=2\nUNCLOSED="oops\nALSO_GOOD=3\n');
  assert.equal(values.GOOD,'1');
  assert.equal(values.ALSO_GOOD,'3');
  assert.equal(errors.length,3);
  assert.match(errors[0],/line 2/);
  assert.match(errors[1],/line 3.*not a valid variable name/);
  assert.match(errors[2],/line 4.*unterminated/);
});

test('the real environment wins, including values that are set but empty',()=>{
  const env:Record<string,string|undefined>={SCOUT_OWNER_EMAIL:'real@example.com',SCOUT_PANEL_TOKEN:''};
  const result=applyEnv({SCOUT_OWNER_EMAIL:'file@example.com',SCOUT_PANEL_TOKEN:'from-file',GSI_TOKEN:'gsi'},env);
  assert.equal(env.SCOUT_OWNER_EMAIL,'real@example.com');
  assert.equal(env.SCOUT_PANEL_TOKEN,'from-file','an empty variable is treated as unset and filled');
  assert.equal(env.GSI_TOKEN,'gsi');
  assert.deepEqual(result.kept,['SCOUT_OWNER_EMAIL']);
  assert.deepEqual(result.applied,['SCOUT_PANEL_TOKEN','GSI_TOKEN']);
});

test('a missing file is silent and not an error',async(t)=>{
  const dir=await temporary(t);
  const messages:string[]=[];
  const result=loadEnvFile(path.join(dir,'.env'),{},message=>messages.push(message));
  assert.equal(result.found,false);
  assert.deepEqual(result.applied,[]);
  assert.deepEqual(messages,[]);
});

test('loadEnvFile reads the file, logs key names only, and honours SCOUT_ENV_FILE',async(t)=>{
  const dir=await temporary(t);
  const file=path.join(dir,'custom.env');
  await writeFile(file,'SCOUT_OWNER_EMAIL=owner@example.com\nSCOUT_BETA_API_KEY=super-secret-value\n');
  const env:Record<string,string|undefined>={SCOUT_ENV_FILE:file};
  const messages:string[]=[];
  const result=loadEnvFile(undefined,env,message=>messages.push(message));
  assert.equal(result.found,true);
  assert.equal(env.SCOUT_OWNER_EMAIL,'owner@example.com');
  assert.equal(env.SCOUT_BETA_API_KEY,'super-secret-value');
  assert.deepEqual(result.applied,['SCOUT_OWNER_EMAIL','SCOUT_BETA_API_KEY']);
  assert.ok(messages.every(message=>!message.includes('super-secret-value')),'values never reach the log');
});

test('the real host picks up .env from its working directory',async(t)=>{
  const host=await platformHost(t,{SCOUT_OWNER_EMAIL:'',SCOUT_PANEL_TOKEN:''},async directory=>{
    await writeFile(path.join(directory,'.env'),'# settings for this venue\nSCOUT_OWNER_EMAIL=owner@example.com\nSCOUT_PANEL_TOKEN=panel-token-from-env-file\n');
  });
  const status=await host.request('/api/platform/status');
  assert.equal(status.status,200);
  assert.equal(status.body.ownerConfigured,true,'SCOUT_OWNER_EMAIL came from .env');
  const session=await host.request('/api/session',undefined,{headers:{'X-Scout-Token':'panel-token-from-env-file'}});
  assert.equal(session.status,200);
  assert.equal(session.body.authenticated,true,'SCOUT_PANEL_TOKEN came from .env');
});

test('the account-service CLI reads .env too',async(t)=>{
  const dir=await temporary(t);
  await mkdir(path.join(dir,'custom'),{recursive:true});
  await writeFile(path.join(dir,'.env'),'SCOUT_ACCOUNT_DB=custom/accounts.sqlite\n');
  const env:NodeJS.ProcessEnv={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('SCOUT_'))delete env[key];
  const code=await new Promise<number>((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(repository,'node_modules','tsx','dist','cli.mjs'),path.join(repository,'server','account-service.ts'),'--list'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout!.on('data',buffer=>{output+=buffer.toString()});
    child.stderr!.on('data',buffer=>{output+=buffer.toString()});
    child.once('error',reject);
    child.once('exit',code=>{
      if(code!==0) reject(Error('account-service --list failed: '+output));
      else resolve(code??0);
    });
  });
  assert.equal(code,0);
  assert.equal(existsSync(path.join(dir,'custom','accounts.sqlite')),true,'SCOUT_ACCOUNT_DB came from .env');
});

test('the account-service CLI revokes by email and says so when there is nothing to revoke',async(t)=>{
  const dir=await temporary(t);
  const env:NodeJS.ProcessEnv={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('SCOUT_'))delete env[key];
  const run=async(...args:string[])=>new Promise<{code:number;output:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(repository,'node_modules','tsx','dist','cli.mjs'),path.join(repository,'server','account-service.ts'),...args],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout!.on('data',buffer=>{output+=buffer.toString()});
    child.stderr!.on('data',buffer=>{output+=buffer.toString()});
    child.once('error',reject);
    child.once('exit',code=>resolve({code:code??0,output}));
  });
  const missing=await run('--revoke','nobody@example.com');
  assert.equal(missing.code,1);
  assert.match(missing.output,/no application for nobody@example\.com/);
});
