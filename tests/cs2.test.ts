import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cs2Connection,CFG_FILE,DEFAULT_GSI_TOKEN,findCs2CfgDirs,GSI_TOKEN_FILE,gsiCfg,libraryFoldersFromVdf} from '../server/cs2';

// Connect CS2: finding CS2 the way the installer does, and writing its connection file with this
// host's own token and port, so an operator never opens a folder.

test('the generated file is the shipped template with the token and port filled in',()=>{
 const template=readFileSync(new URL('../config/gamestate_integration_overlay.cfg',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 assert.equal(gsiCfg(DEFAULT_GSI_TOKEN,8080),template.endsWith('\n')?template:template+'\n');
 const custom=gsiCfg('abc123',9001);
 assert.match(custom,/"uri" "http:\/\/127\.0\.0\.1:9001\/gsi"/);
 assert.match(custom,/"auth" \{ "token" "abc123" \}/);
});

test('Steam library folders are read in both vdf formats',()=>{
 const vdf=`"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t\t"label"\t\t""\n\t}\n\t"1"\t\t"D:\\\\Games\\\\SteamLibrary"\n\t"contentid"\t\t"123"\n}`;
 assert.deepEqual(libraryFoldersFromVdf(vdf),['C:\\Program Files (x86)\\Steam','D:\\Games\\SteamLibrary']);
});

test('CS2 is found in the Steam folder from the registry and in a second library',async()=>{
 const steam='C:\\Program Files (x86)\\Steam',library='D:\\Games\\SteamLibrary';
 const cfg=(root:string)=>path.win32.join(root,'steamapps','common','Counter-Strike Global Offensive','game','csgo','cfg');
 const present=new Set([cfg(library)]);
 const found=await findCs2CfgDirs({platform:'win32',env:{},home:'C:\\Users\\op',steamRoots:async()=>['c:/program files (x86)/steam',''],
  exists:file=>present.has(file),// Windows paths are case-insensitive; the fake reader below is too
  read:async file=>{if(file.toLowerCase()===path.win32.join(steam,'steamapps','libraryfolders.vdf').toLowerCase())return `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\Games\\\\SteamLibrary"\n\t}\n}`;throw Error('missing')}});
 assert.deepEqual(found,[cfg(library)],'only folders where CS2 is actually installed');
});

test('connecting replaces the built-in token, keeps it for restarts and writes every CS2 folder',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scout-cs2-'));
 try{
  const data=path.join(root,'data'),cs2a=path.join(root,'a'),cs2b=path.join(root,'b');
  for(const dir of [data,cs2a,cs2b]) await mkdir(dir,{recursive:true});
  let token=DEFAULT_GSI_TOKEN;
  const connection=cs2Connection({port:8123,dataDir:data,installed:true,token:()=>token,setToken:next=>{token=next},search:async()=>[cs2a,cs2b]});
  const before=await connection.status();
  assert.equal(before.tokenSet,false);
  assert.deepEqual(before.folders.map(folder=>folder.installed),[false,false]);
  const result=await connection.connect();
  assert.match(token,/^[0-9a-f]{32}$/,'a private random token replaces CHANGE_ME');
  assert.equal((await readFile(path.join(data,GSI_TOKEN_FILE),'utf8')).trim(),token,'kept where the desktop app reads it on start');
  assert.deepEqual(result.written,[cs2a,cs2b]);
  for(const dir of [cs2a,cs2b]) assert.equal(await readFile(path.join(dir,CFG_FILE),'utf8'),gsiCfg(token,8123));
  assert.equal(await readFile(path.join(data,'config',CFG_FILE),'utf8'),gsiCfg(token,8123),'the installed data folder copy is current');
  assert.deepEqual(result.folders.map(folder=>folder.current),[true,true]);
  assert.equal(result.tokenSet,true);
  const same=token;await connection.connect();
  assert.equal(token,same,'reconnecting keeps a private token');
  await connection.connect({newToken:true});
  assert.notEqual(token,same,'New token makes a fresh one');
  assert.equal(await readFile(path.join(cs2a,CFG_FILE),'utf8'),gsiCfg(token,8123),'and CS2 gets it straight away');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('in a checkout the committed template is never overwritten',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scout-cs2-'));
 try{
  await mkdir(path.join(root,'config'));await writeFile(path.join(root,'config',CFG_FILE),'template');
  const connection=cs2Connection({port:8080,dataDir:root,token:()=>DEFAULT_GSI_TOKEN,setToken:()=>{},search:async()=>[]});
  const result=await connection.connect();
  assert.equal(await readFile(path.join(root,'config',CFG_FILE),'utf8'),'template');
  assert.deepEqual(result.written,[],'no CS2 here, nothing written, and the caller is told so');
 }finally{await rm(root,{recursive:true,force:true})}
});
