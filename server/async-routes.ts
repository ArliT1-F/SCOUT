import type {Express,NextFunction,Request,Response} from 'express';
// Express 4 calls a route handler and ignores what it returns, so a rejected promise from an
// `async (req,res)=>{}` handler never reaches the error middleware. Node treats it as an unhandled
// rejection and, since Node 15, exits — one failed disk write (a file locked by antivirus, a full
// disk) would take every overlay off air. Patching the registration methods once, before any route
// is added, forwards every handler's rejection to `next(error)` without touching the 50-odd routes.
const METHODS=['use','all','get','post','put','patch','delete','head','options'] as const;
type Handler=((...args:any[])=>unknown)&{handle?:unknown;set?:unknown};
function wrap(value:unknown):unknown {
 if(Array.isArray(value)) return value.map(wrap);
 if(typeof value!=='function') return value;
 const fn=value as Handler;
 // Four-argument functions are error handlers, which Express recognises by arity, and Express
 // sub-apps are mounted by identity (mountpath, parent settings): both pass through untouched.
 if(fn.length>=4||(fn.handle&&fn.set)) return fn;
 // Exactly three parameters, so Express keeps treating the wrapper as an ordinary handler.
 return function(this:unknown,req:Request,res:Response,next:NextFunction){
  const result=fn.call(this,req,res,next) as {then?:unknown}|undefined;
  // A synchronous throw is already caught by Express itself; only the promise needs forwarding.
  if(result&&typeof result.then==='function') (result as Promise<unknown>).then(undefined,error=>next(error??new Error('Route handler rejected without a reason')));
 };
}
export function forwardAsyncErrors<T extends Express>(app:T):T {
 for(const method of METHODS){
  const original=(app as any)[method] as (...args:unknown[])=>unknown;
  (app as any)[method]=function(this:unknown,...args:unknown[]){
   // `app.get('name')` with a single argument is Express's settings getter, not a route.
   if(method==='get'&&args.length===1) return original.apply(this,args);
   return original.apply(this,args.map(wrap));
  };
 }
 return app;
}
