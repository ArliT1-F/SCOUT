import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StartggTokenStore,validStartggToken} from '../server/startgg-token';

// The start.gg token saved from the panel: kept in its own file, preferred over the environment,
// never shown back in full, and easy to remove.

const TOKEN='a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
async function tempStore(env:Record<string,string|undefined>={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'scout-startgg-token-'));
 const file=path.join(dir,'config','startgg.json');
 return {dir,file,store:await new StartggTokenStore(file,env).load()};
}

test('a saved token is used, survives a restart, and only its last four characters are shown',async()=>{
 const {dir,file,store}=await tempStore();
 try{
  assert.deepEqual(store.view(),{tokenSet:false,source:null,hint:null});
  assert.equal(store.tokenFor(),'');
  const view=await store.save(`  ${TOKEN}  `);
  assert.deepEqual(view,{tokenSet:true,source:'panel',hint:'c5d6'});
  assert.equal(JSON.stringify(view).includes(TOKEN),false,'the view never carries the token');
  assert.equal(store.tokenFor(),TOKEN);
  assert.equal(store.tokenFor('one-off-token-123'),'one-off-token-123','a token pasted for one import wins');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{token:TOKEN});
  if(process.platform!=='win32') assert.equal((await stat(file)).mode&0o077,0,'readable by this user only');
  const reloaded=await new StartggTokenStore(file,{}).load();
  assert.equal(reloaded.tokenFor(),TOKEN,'it is still there after the host restarts');
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('the saved token beats SCOUT_STARTGG_TOKEN, and removing it falls back to the environment',async()=>{
 const {dir,store}=await tempStore({SCOUT_STARTGG_TOKEN:'envtoken-0000-1111'});
 try{
  assert.deepEqual(store.view(),{tokenSet:true,source:'env',hint:'1111'});
  await store.save(TOKEN);
  assert.equal(store.tokenFor(),TOKEN);
  const after=await store.clear();
  assert.deepEqual(after,{tokenSet:true,source:'env',hint:'1111'});
  assert.equal(store.tokenFor(),'envtoken-0000-1111');
  await store.clear();// removing twice is fine
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('what cannot be a token is refused, and a damaged file is ignored',async()=>{
 const {dir,file,store}=await tempStore();
 try{
  for(const bad of ['','short','has a space in it','https://start.gg/admin/profile/developer']) assert.equal(validStartggToken(bad),false,bad);
  await assert.rejects(()=>store.save('not a token'),/does not look like/);
  assert.equal(store.view().tokenSet,false,'a refused token changes nothing');
  await store.save(TOKEN);
  await writeFile(file,'{broken');
  assert.equal((await new StartggTokenStore(file,{}).load()).view().tokenSet,false);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('the token file is kept out of git',()=>{
 assert.match(readFileSync(new URL('../.gitignore',import.meta.url),'utf8'),/^config\/startgg\.json$/m);
});
