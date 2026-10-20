// Deployment boundary, not a UI-only switch. A public website never exposes the local host API.
export type Surface='host'|'site';
export function surfaceFromEnv(env:NodeJS.ProcessEnv=process.env):Surface {
 const value=env.SCOUT_SURFACE||'host';
 if(value!=='host'&&value!=='site')throw Error('SCOUT_SURFACE must be host or site');
 return value;
}
export function websitePathAllowed(path:string){
 if(path==='/healthz'||path==='/api/surface')return true;
 if(path.startsWith('/api/beta/'))return !/^\/api\/beta\/(link|license)(\/|$)/.test(path);
 if(path.startsWith('/api/platform/'))return /^\/api\/platform\/(admin|status|stats|device)(\/|$)/.test(path);
 return !path.startsWith('/api/')&&!['/ws','/gsi','/app','/panel','/obs','/game','/remote'].includes(path.replace(/\/+$/,'').toLowerCase());
}
