import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MatchArchiveStore} from '../server/recordings';
import {normalizeConfig} from '../server/config';
import type {KillEvent} from '../server/events';

const kill=(id:number):KillEvent=>({id,at:1_750_000_000_000+id,round:3,map:'de_mirage',killer:'a',killerName:'arvo',victim:'b',victimName:'veko',headshot:id%2===0});
const saved=async(file:string)=>JSON.parse(await readFile(file,'utf8')).archives[0].events.length as number;

// Saves are coalesced (one rewrite covers every change queued before it starts), so what has to hold
// is that no change is lost: a burst of kills and a kill after the burst all reach the file.
test('a burst of kills is saved in full, and so is the next change',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'scout-archives-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'matches.json');
 const store=new MatchArchiveStore(file);
 store.start('Grand final',normalizeConfig({event:{name:'Cup'},teams:[{id:'a',name:'Alpha'},{id:'b',name:'Bravo'}],maps:[{name:'de_mirage'}]}));
 for(let id=1;id<=50;id++) store.addKill(kill(id));
 await store.flush();
 assert.equal(await saved(file),50);
 store.addKill(kill(51));
 store.finish();
 await store.flush();
 assert.equal(await saved(file),51);
 const reloaded=new MatchArchiveStore(file);await reloaded.load();
 assert.equal(reloaded.active,null,'the finish was saved too');
});
