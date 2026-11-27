import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The Windows installer compiles the host with tsconfig.build.json: Node's types only, no DOM lib.
// Code that type-checks under the panel's tsconfig.json (which includes the DOM) can still fail
// there (a fetch Response's json() is `any` with the DOM lib and `unknown` without it), and that
// failure only showed up when someone ran the installer build. Compiling it here keeps it in the suite.
test('the host compiles with the installer\'s own tsconfig',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json','--noEmit'],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,`tsc -p tsconfig.build.json failed:\n${result.stdout}${result.stderr}`);
});
