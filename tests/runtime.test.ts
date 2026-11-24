import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readInstalledEnv} from '../server/runtime';

const repository=fileURLToPath(new URL('..',import.meta.url));

test('installer-written setting files are read when the variable is unset',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'scout-runtime-'));
 const cwd=process.cwd(),saved=process.env.SCOUT_REQUIRE_LICENCE;
 delete process.env.SCOUT_REQUIRE_LICENCE;
 try{
  await writeFile(path.join(directory,'require_licence.txt'),'1\r\n');
  process.chdir(directory);
  assert.equal(readInstalledEnv('SCOUT_REQUIRE_LICENCE'),'1','the value the installer wrote, trimmed');
  process.env.SCOUT_REQUIRE_LICENCE='0';
  assert.equal(readInstalledEnv('SCOUT_REQUIRE_LICENCE'),'0','a real environment variable still wins');
 }finally{
  process.chdir(cwd);
  if(saved===undefined)delete process.env.SCOUT_REQUIRE_LICENCE;else process.env.SCOUT_REQUIRE_LICENCE=saved;
  await rm(directory,{recursive:true,force:true});
 }
});

// The packaged host is the compiled ES-module output of tsconfig.build.json and runs on plain Node,
// where `require` is not defined. The test runner provides one, so a require() call passes here and
// fails silently in an install (runtime.ts used to read every installer setting file that way and
// always got "not set"). Guard the compiled sources instead.
test('the modules compiled into the packaged host never call require()',async()=>{
 const build=JSON.parse(await readFile(path.join(repository,'tsconfig.build.json'),'utf8'));
 const files:string[]=[];
 for(const entry of build.include as string[]){
  if(entry.endsWith('.ts')){files.push(entry);continue}
  for(const name of await readdir(path.join(repository,entry))) if(name.endsWith('.ts')) files.push(path.join(entry,name));
 }
 assert.ok(files.length>10,'the build includes the server');
 for(const file of files){
  const source=(await readFile(path.join(repository,file),'utf8')).split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source,/(^|[^\w.])require\s*\(/,`${file} calls require(), which does not exist in the packaged ES-module host`);
 }
});
