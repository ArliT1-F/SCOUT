import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {forwardAsyncErrors} from '../server/async-routes';

// Express 4 ignores the promise an async handler returns. Without the wrapper a rejection is an
// unhandled rejection, which ends the Node process — the host and every overlay with it.
// A regression shows up as a request that never answers, so every call carries a deadline.
const call=(url:string,init:RequestInit={})=>fetch(url,{...init,signal:AbortSignal.timeout(5000)});
async function serve(app:express.Express){
 const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 return {url,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

test('a rejected async route reaches the error handler instead of the process',async()=>{
 const app=forwardAsyncErrors(express());
 const seen:string[]=[];
 app.post('/write',async()=>{await Promise.resolve();throw new Error('EPERM: rename config/teams.json')});
 app.get('/silent',async()=>{await Promise.reject(undefined)});
 app.get(['/a','/b'],async(_req,res)=>{res.json({ok:true})});
 app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{seen.push(String(err?.message));res.status(500).json({error:'Request failed'})});
 const {url,close}=await serve(app);
 try{
  const failed=await call(url+'/write',{method:'POST'});
  assert.equal(failed.status,500);
  assert.deepEqual(await failed.json(),{error:'Request failed'});
  assert.equal((await call(url+'/silent')).status,500,'a reason-less rejection is still an error, not a fall-through');
  assert.equal((await call(url+'/b')).status,200,'path arrays and successful async routes are unaffected');
  assert.deepEqual(seen,['EPERM: rename config/teams.json','Route handler rejected without a reason']);
 }finally{await close()}
});

test('settings, error handlers and mounted sub-apps keep their Express meaning',async()=>{
 const app=forwardAsyncErrors(express());
 app.set('case sensitive routing',true);
 assert.equal(app.get('case sensitive routing'),true,'app.get(name) is still the settings getter');
 const sub=express();sub.get('/ping',(_req,res)=>{res.json({mount:sub.mountpath})});
 app.use('/sub',sub);
 app.get('/sync',()=>{throw new Error('sync failure')});
 app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(500).json({error:err.message})});
 const {url,close}=await serve(app);
 try{
  assert.deepEqual(await (await call(url+'/sub/ping')).json(),{mount:'/sub'});
  const sync=await call(url+'/sync');
  assert.equal(sync.status,500);
  assert.deepEqual(await sync.json(),{error:'sync failure'},'a four-argument error handler is still registered as one');
 }finally{await close()}
});
