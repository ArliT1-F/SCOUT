import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

export interface SupabaseConfiguration {
 url:string;
 serviceRoleKey:string;
}

type Row = Record<string,unknown>;

interface KeyedTableSpec {
 name:string;
 conflictKey:string;
 columns:readonly string[];
 keyOf:(row:Row)=>string;
 deleteFilter:(row:Row)=>string;
}

const KEYED_TABLES:readonly KeyedTableSpec[]=[
 {
  name:'accounts',
  conflictKey:'id',
  columns:[
   'id','email','normalized_email','display_name','organisation','country','use_case','events',
   'status','password','created_at','decided_at','decided_by','invite_digest','invite_expires_at',
   'last_login_at','activated_at','revoked_reason',
  ],
  keyOf:row=>String(row.id),
  deleteFilter:row=>`id=eq.${encodeURIComponent(String(row.id))}`,
 },
 {
  name:'devices',
  conflictKey:'id',
  columns:['id','account_id','label','platform','created_at','last_seen_at','revoked_at','token_digest'],
  keyOf:row=>String(row.id),
  deleteFilter:row=>`id=eq.${encodeURIComponent(String(row.id))}`,
 },
 {
  name:'sessions',
  conflictKey:'id',
  columns:['id','account_id','created_at','last_seen_at','address','user_agent'],
  keyOf:row=>String(row.id),
  deleteFilter:row=>`id=eq.${encodeURIComponent(String(row.id))}`,
 },
 {
  name:'grants',
  conflictKey:'device_code',
  columns:[
   'device_code','user_code','label','platform','origin','created_at','expires_at',
   'status','account_id','device_id','pending_token','claimed_at',
  ],
  keyOf:row=>String(row.device_code),
  deleteFilter:row=>`device_code=eq.${encodeURIComponent(String(row.device_code))}`,
 },
 {
  name:'account_roles',
  conflictKey:'account_id,role',
  columns:['account_id','role','granted_at','granted_by'],
  keyOf:row=>`${String(row.account_id)}:${String(row.role)}`,
  deleteFilter:row=>`account_id=eq.${encodeURIComponent(String(row.account_id))}&role=eq.${encodeURIComponent(String(row.role))}`,
 },
 {
  name:'password_recovery_tokens',
  conflictKey:'token_digest',
  columns:['token_digest','account_id','created_at','expires_at','used_at'],
  keyOf:row=>String(row.token_digest),
  deleteFilter:row=>`token_digest=eq.${encodeURIComponent(String(row.token_digest))}`,
 },
 {
  name:'email_outbox',
  conflictKey:'id',
  columns:[
   'id','template','recipient_digest','payload_ciphertext','payload_iv','payload_tag',
   'created_at','next_attempt_at','attempts','sent_at','last_error_code',
   'last_error_status','last_provider_error',
  ],
  keyOf:row=>String(row.id),
  deleteFilter:row=>`id=eq.${encodeURIComponent(String(row.id))}`,
 },
];

// Hydration reads tables a page at a time (see selectAll). 1,000 matches Supabase's default
// `max_rows`; a project configured lower still works, it just reads more, shorter pages.
const PAGE_SIZE=1000;
const MAX_PAGES=10_000;
/** A stable page order for a keyed table: its conflict key, which is unique. */
function keyOrder(table:string):string{
 const spec=KEYED_TABLES.find(entry=>entry.name===table);
 if(!spec) throw new Error(`No key is known for table ${table}.`);
 return spec.conflictKey.split(',').map(column=>`${column}.asc`).join(',');
}

function inferSupabaseUrlFromDatabaseUrl(databaseUrl:string):string{
 const trimmed=databaseUrl.trim();
 if(!trimmed) return '';
 // Matches pooler URLs (postgres.<ref>@...supabase.com) or direct URLs (@db.<ref>.supabase.co)
 const poolerMatch=/\/\/postgres\.([a-z0-9]{15,30})(?:[:@])/i.exec(trimmed);
 if(poolerMatch) return `https://${poolerMatch[1].toLowerCase()}.supabase.co`;
 const directMatch=/@db\.([a-z0-9]{15,30})\.supabase\.co\b/i.exec(trimmed);
 if(directMatch) return `https://${directMatch[1].toLowerCase()}.supabase.co`;
 return '';
}

function readLinkedProjectRef(cwd=process.cwd()):string{
 try{
  const refFile=path.join(cwd,'supabase','.temp','project-ref');
  if(!existsSync(refFile)) return '';
  const ref=readFileSync(refFile,'utf8').trim();
  return /^[a-z0-9]{15,30}$/i.test(ref)?ref.toLowerCase():'';
 }catch{
  return '';
 }
}

/**
 * Read and validate Supabase REST configuration without ever logging or exposing
 * SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL credentials.
 */
export function supabaseConfiguration(env:NodeJS.ProcessEnv=process.env):SupabaseConfiguration|null{
 const serviceRoleKey=(env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
 if(!serviceRoleKey) return null;
 const explicitUrl=(env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
 const inferredFromDb=inferSupabaseUrlFromDatabaseUrl(env.DATABASE_URL||env.SCOUT_DATABASE_URL||'');
 const projectRef=(env.SUPABASE_PROJECT_REF||'').trim()||readLinkedProjectRef();
 const url=explicitUrl||inferredFromDb||(projectRef?`https://${projectRef}.supabase.co`:'');
 if(!url){
  throw new Error('SUPABASE_URL (or SUPABASE_PROJECT_REF / DATABASE_URL) is required when SUPABASE_SERVICE_ROLE_KEY is set.');
 }
 let parsed:URL;
 try{parsed=new URL(url)}catch{
  throw new Error('SUPABASE_URL must be a valid HTTPS origin (e.g. https://<project>.supabase.co).');
 }
 const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname);
 if(parsed.username||parsed.password||parsed.search||parsed.hash||(parsed.protocol!=='https:'&&!loopback)){
  throw new Error('SUPABASE_URL must use HTTPS outside local development and must not contain credentials or a query string.');
 }
 return {url:parsed.origin+parsed.pathname.replace(/\/+$/,''),serviceRoleKey};
}

function normalizeRow(columns:readonly string[],source:Row):Row{
 const out:Row={};
 for(const col of columns){
  const val=source[col];
  out[col]=val===undefined?null:val;
 }
 return out;
}

function serializeRow(columns:readonly string[],source:Row):string{
 return JSON.stringify(normalizeRow(columns,source));
}

async function supabaseFetch(
 config:SupabaseConfiguration,
 fetchImpl:typeof fetch,
 tablePath:string,
 init:RequestInit={},
):Promise<Response>{
 const headers:Record<string,string>={
  apikey:config.serviceRoleKey,
  Authorization:`Bearer ${config.serviceRoleKey}`,
  Accept:'application/json',
  ...(init.body!==undefined?{'Content-Type':'application/json'}:{}),
  ...(init.headers as Record<string,string>|undefined),
 };
 return fetchImpl(`${config.url}/rest/v1/${tablePath}`,{
  ...init,
  headers,
  signal:init.signal??AbortSignal.timeout(20_000),
 });
}

async function ensureOk(res:Response,operation:string):Promise<void>{
 if(res.ok) return;
 // Never include secret keys or raw payloads in thrown diagnostics.
 throw Object.assign(new Error(`Supabase ${operation} failed with HTTP ${res.status}.`),{status:res.status});
}

/**
 * Keeps the Node account service's SQLite database (`DatabaseSync`) synchronized with
 * Supabase PostgreSQL (`supabase/migrations/001_initial_account_schema.sql`).
 *
 * On Render's free tier, local disk is ephemeral across deploys/spin-downs. Hydrating
 * SQLite from Supabase on startup and flushing row diffs on each mutation preserves
 * every account, session, invitation, device link, audit record and setting in Supabase
 * while keeping all synchronous SQLite transactions and constraints intact.
 */
export class SupabaseAccountMirror {
 private readonly snapshots=new Map<string,Map<string,string>>();
 private remoteSettingsJson:string|null=null;
 private remoteSettingsId:number|null=null;
 private remoteExtraSettingsFields:Record<string,unknown>={};
 private syncedEventsCount=0;
 private lastSyncedAuditId=0;
 private queue:Promise<void>=Promise.resolve();

 constructor(
  readonly config:SupabaseConfiguration,
  private readonly fetchImpl:typeof fetch=fetch,
  private readonly log:(line:string)=>void=()=>{},
 ){
  for(const spec of KEYED_TABLES) this.snapshots.set(spec.name,new Map());
 }

 private async selectOne(table:string,query:string):Promise<Row[]>{
  const res=await supabaseFetch(this.config,this.fetchImpl,`${table}?${query}`,{method:'GET'});
  await ensureOk(res,`select ${table}`);
  const body=await res.json();
  return Array.isArray(body)?(body as Row[]):[];
 }

 /**
  * Every row of a table. Supabase's Data API answers one request with at most its `max_rows`
  * setting (1,000 by default) and says nothing about the rest, so one select silently drops rows
  * once a table outgrows it. Pages are read in a stable order (`order` must name a unique key, or
  * every column) until the total the server reports has been read.
  */
 private async selectAll(table:string,order:string,query='select=*'):Promise<Row[]>{
  const rows:Row[]=[];
  for(let pages=0;;pages++){
   if(pages>=MAX_PAGES) throw new Error(`Supabase select ${table} did not finish after ${MAX_PAGES} pages.`);
   const res=await supabaseFetch(this.config,this.fetchImpl,`${table}?${query}&order=${order}&limit=${PAGE_SIZE}&offset=${rows.length}`,{method:'GET',headers:{Prefer:'count=exact'}});
   await ensureOk(res,`select ${table}`);
   const body=await res.json();
   const page=Array.isArray(body)?(body as Row[]):[];
   rows.push(...page);
   // `Content-Range: 0-999/2412` with count=exact. Without a total, a short page is the last one.
   const total=Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range')||'')?.[1]);
   if(page.length===0||(Number.isFinite(total)?rows.length>=total:page.length<PAGE_SIZE)) return rows;
  }
 }

 /** Pull all account tables from Supabase into the local SQLite database at startup. */
 async hydrate(db:DatabaseSync):Promise<void>{
  const keyed=(name:string)=>this.selectAll(name,keyOrder(name));
  const [
   accounts,
   devices,
   sessions,
   grants,
   roles,
   recoveries,
   outbox,
   settingsRows,
   events,
   audits,
  ]=await Promise.all([
   keyed('accounts'),
   keyed('devices'),
   keyed('sessions'),
   keyed('grants'),
   keyed('account_roles'),
   keyed('password_recovery_tokens'),
   keyed('email_outbox'),
   this.selectOne('platform_settings','select=id,data&order=id.asc&limit=1'),
   // `events` has no key column, so the page order is every column: rows that tie on all of them
   // are identical, and which copy lands on which page cannot change what is read.
   this.selectAll('events','at.asc,kind.asc,account_id.asc.nullsfirst,detail.asc','select=at,kind,account_id,detail'),
   this.selectAll('audit_logs','id.asc','select=id,occurred_at,request_id,actor_type,actor_id,action,target_type,target_id,metadata'),
  ]);

  const remoteByTable:Record<string,Row[]>={
   accounts,
   devices,
   sessions,
   grants,
   account_roles:roles,
   password_recovery_tokens:recoveries,
   email_outbox:outbox,
  };

  const localEventsBefore=Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as {n?:number}|undefined)?.n||0);
  const localAuditsBefore=Number((db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as {n?:number}|undefined)?.n||0);

  db.exec('BEGIN IMMEDIATE');
  try{
   for(const spec of KEYED_TABLES){
    const rows=remoteByTable[spec.name]||[];
    const snap=new Map<string,string>();
    if(rows.length>0){
     const cols=spec.columns.join(', ');
     const placeholders=spec.columns.map(()=>'?').join(', ');
     const stmt=db.prepare(`INSERT OR REPLACE INTO ${spec.name} (${cols}) VALUES (${placeholders})`);
     for(const raw of rows){
      const normalized=normalizeRow(spec.columns,raw);
      stmt.run(...spec.columns.map(c=>normalized[c]) as never[]);
      snap.set(spec.keyOf(normalized),serializeRow(spec.columns,normalized));
     }
    }
    this.snapshots.set(spec.name,snap);
   }

   if(settingsRows.length>0){
    const row=settingsRows[0];
    this.remoteSettingsId=Number(row.id);
    const parsed=typeof row.data==='string'?JSON.parse(row.data):(row.data&&typeof row.data==='object'?row.data:{});
    if(parsed&&typeof parsed==='object'&&'_platformStore' in parsed){
     this.remoteExtraSettingsFields={_platformStore:(parsed as Record<string,unknown>)._platformStore};
    }
    const serialized=JSON.stringify(parsed??{});
    db.prepare('INSERT OR REPLACE INTO platform_settings (id, data) VALUES (1, ?)').run(serialized);
    this.remoteSettingsJson=serialized;
   }

   if(localEventsBefore===0&&events.length>0){
    const stmt=db.prepare('INSERT INTO events (at, kind, account_id, detail) VALUES (?, ?, ?, ?)');
    for(const ev of events){
     stmt.run(Number(ev.at),String(ev.kind),ev.account_id==null?null:String(ev.account_id),String(ev.detail??''));
    }
    this.syncedEventsCount=events.length;
   }else{
    // A persistent local database (SCOUT_ACCOUNT_DB plus Supabase) already holds its own history.
    // The flush appends local rows past this offset, so the offset has to count *local* rows: the
    // remote count would skip every new event until the local table outgrew the remote one.
    this.syncedEventsCount=localEventsBefore;
   }

   if(localAuditsBefore===0&&audits.length>0){
    const stmt=db.prepare(
     'INSERT OR REPLACE INTO audit_logs (id, occurred_at, request_id, actor_type, actor_id, action, target_type, target_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let maxId=0;
    for(const audit of audits){
     const id=Number(audit.id);
     if(id>maxId) maxId=id;
     const meta=typeof audit.metadata==='string'?audit.metadata:JSON.stringify(audit.metadata??{});
     stmt.run(
      id,
      Number(audit.occurred_at),
      audit.request_id==null?null:String(audit.request_id),
      String(audit.actor_type),
      audit.actor_id==null?null:String(audit.actor_id),
      String(audit.action),
      String(audit.target_type),
      audit.target_id==null?null:String(audit.target_id),
      meta,
     );
    }
    this.lastSyncedAuditId=maxId;
   }else{
    // Same reasoning as events: local ids come from SQLite's own sequence, not from Postgres, so
    // only rows written after this point are new.
    this.lastSyncedAuditId=Number((db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM audit_logs').get() as {n?:number}|undefined)?.n||0);
   }

   db.exec('COMMIT');
  }catch(error){
   try{db.exec('ROLLBACK')}catch{}
   throw error;
  }

  // Push any initial seed (e.g. platform_settings on a brand-new Supabase DB or pre-existing local SQLite rows).
  await this.flush(db);
  this.log(`connected to Supabase (${accounts.length} account(s) hydrated)`);
 }

 /** Flush any SQLite table changes to Supabase in foreign-key dependency order. */
 async flush(db:DatabaseSync):Promise<void>{
  const runFlush=async()=>{
   // 1. Upsert new or updated rows in forward dependency order (accounts -> devices -> grants/sessions/...).
   for(const spec of KEYED_TABLES){
    const currentRows=db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${spec.name}`).all() as Row[];
    const prevSnap=this.snapshots.get(spec.name)!;
    const nextSnap=new Map<string,string>();
    const toUpsert:Row[]=[];

    for(const raw of currentRows){
     const normalized=normalizeRow(spec.columns,raw);
     const key=spec.keyOf(normalized);
     const serialized=serializeRow(spec.columns,normalized);
     nextSnap.set(key,serialized);
     if(prevSnap.get(key)!==serialized){
      toUpsert.push(normalized);
     }
    }

    if(toUpsert.length>0){
     const res=await supabaseFetch(
      this.config,
      this.fetchImpl,
      `${spec.name}?on_conflict=${encodeURIComponent(spec.conflictKey)}`,
      {
       method:'POST',
       headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
       body:JSON.stringify(toUpsert),
      },
     );
     await ensureOk(res,`upsert ${spec.name}`);
    }
   }

   // 2. Delete removed rows in reverse dependency order (children before accounts).
   for(const spec of [...KEYED_TABLES].reverse()){
    const currentRows=db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${spec.name}`).all() as Row[];
    const prevSnap=this.snapshots.get(spec.name)!;
    const nextSnap=new Map<string,string>();
    const currentByKey=new Map<string,Row>();
    for(const raw of currentRows){
     const normalized=normalizeRow(spec.columns,raw);
     const key=spec.keyOf(normalized);
     nextSnap.set(key,serializeRow(spec.columns,normalized));
     currentByKey.set(key,normalized);
    }
    for(const [oldKey,oldSerialized] of prevSnap.entries()){
     if(!currentByKey.has(oldKey)){
      const oldRow=JSON.parse(oldSerialized) as Row;
      const res=await supabaseFetch(
       this.config,
       this.fetchImpl,
       `${spec.name}?${spec.deleteFilter(oldRow)}`,
       {method:'DELETE'},
      );
      await ensureOk(res,`delete ${spec.name}`);
     }
    }
    this.snapshots.set(spec.name,nextSnap);
   }

   // 3. Sync platform_settings (id = 1).
   const settingsRow=db.prepare('SELECT data FROM platform_settings WHERE id = 1').get() as {data?:string}|undefined;
   if(settingsRow?.data && settingsRow.data!==this.remoteSettingsJson){
    let parsed:Record<string,unknown>={};
    try{parsed=JSON.parse(String(settingsRow.data))}catch{}
    const merged={...this.remoteExtraSettingsFields,...parsed};
    if(this.remoteSettingsId!==null){
     const res=await supabaseFetch(
      this.config,
      this.fetchImpl,
      `platform_settings?id=eq.${this.remoteSettingsId}`,
      {
       method:'PATCH',
       headers:{Prefer:'return=minimal'},
       body:JSON.stringify({data:merged}),
      },
     );
     await ensureOk(res,'update platform_settings');
    }else{
     const res=await supabaseFetch(
      this.config,
      this.fetchImpl,
      'platform_settings?select=id',
      {
       method:'POST',
       headers:{Prefer:'return=representation'},
       body:JSON.stringify({data:merged}),
      },
     );
     await ensureOk(res,'insert platform_settings');
     const created=await res.json().catch(()=>[]);
     if(Array.isArray(created)&&created[0]?.id!=null){
      this.remoteSettingsId=Number(created[0].id);
     }
    }
    this.remoteSettingsJson=settingsRow.data;
   }

   // 4. Append new events rows.
   const newEvents=db.prepare('SELECT at, kind, account_id, detail FROM events LIMIT -1 OFFSET ?').all(this.syncedEventsCount) as Row[];
   if(newEvents.length>0){
    const payload=newEvents.map(ev=>({
     at:Number(ev.at),
     kind:String(ev.kind),
     account_id:ev.account_id==null?null:String(ev.account_id),
     detail:String(ev.detail??''),
    }));
    const res=await supabaseFetch(this.config,this.fetchImpl,'events',{
     method:'POST',
     headers:{Prefer:'return=minimal'},
     body:JSON.stringify(payload),
    });
    await ensureOk(res,'insert events');
    this.syncedEventsCount+=newEvents.length;
   }

   // 5. Append new audit_logs rows (omit `id` so Postgres identity generation works with both ALWAYS and BY DEFAULT).
   const newAudits=db.prepare(
    'SELECT id, occurred_at, request_id, actor_type, actor_id, action, target_type, target_id, metadata FROM audit_logs WHERE id > ? ORDER BY id ASC',
   ).all(this.lastSyncedAuditId) as Row[];
   if(newAudits.length>0){
    const payload=newAudits.map(row=>{
     let metadata:unknown={};
     try{metadata=typeof row.metadata==='string'?JSON.parse(row.metadata):(row.metadata??{})}catch{}
     return {
      occurred_at:Number(row.occurred_at),
      request_id:row.request_id==null?null:String(row.request_id),
      actor_type:String(row.actor_type),
      actor_id:row.actor_id==null?null:String(row.actor_id),
      action:String(row.action),
      target_type:String(row.target_type),
      target_id:row.target_id==null?null:String(row.target_id),
      metadata,
     };
    });
    const res=await supabaseFetch(this.config,this.fetchImpl,'audit_logs',{
     method:'POST',
     headers:{Prefer:'return=minimal'},
     body:JSON.stringify(payload),
    });
    await ensureOk(res,'insert audit_logs');
    this.lastSyncedAuditId=Math.max(...newAudits.map(r=>Number(r.id)||0));
   }
  };

  const next=this.queue.then(runFlush);
  this.queue=next.catch(()=>{});
  await next;
 }
}

/**
 * Persists `PlatformStore` (per-user tournaments, active tournament selection, match metrics
 * and config receipts) in Supabase so Render free-tier restarts never lose tournament state.
 *
 * Uses the `platform_store` table when present (migration 002), and transparently falls back
 * to `platform_settings.data._platformStore` when only migration 001 has been applied.
 */
export class SupabasePlatformMirror {
 private useSettingsFallback=false;
 private queue:Promise<void>=Promise.resolve();

 constructor(
  readonly config:SupabaseConfiguration,
  private readonly fetchImpl:typeof fetch=fetch,
 ){}

 async load():Promise<Record<string,unknown>|null>{
  if(!this.useSettingsFallback){
   const res=await supabaseFetch(this.config,this.fetchImpl,'platform_store?select=id,data&id=eq.1',{method:'GET'});
   if(res.ok){
    const rows=(await res.json().catch(()=>[])) as Row[];
    if(Array.isArray(rows)&&rows[0]?.data&&typeof rows[0].data==='object'){
     return rows[0].data as Record<string,unknown>;
    }
    return null;
   }
   if(res.status===404||res.status===400){
    this.useSettingsFallback=true;
   }else{
    await ensureOk(res,'select platform_store');
   }
  }

  const res=await supabaseFetch(this.config,this.fetchImpl,'platform_settings?select=id,data&order=id.asc&limit=1',{method:'GET'});
  await ensureOk(res,'select platform_settings fallback');
  const rows=(await res.json().catch(()=>[])) as Row[];
  const data=rows[0]?.data as Record<string,unknown>|undefined;
  if(data&&typeof data._platformStore==='object'&&data._platformStore!==null){
   return data._platformStore as Record<string,unknown>;
  }
  return null;
 }

 async save(storeData:unknown):Promise<void>{
  const runSave=async()=>{
   if(!this.useSettingsFallback){
    const res=await supabaseFetch(
     this.config,
     this.fetchImpl,
     'platform_store?on_conflict=id',
     {
      method:'POST',
      headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
      body:JSON.stringify([{id:1,data:storeData,updated_at:Date.now()}]),
     },
    );
    if(res.ok) return;
    if(res.status===404||res.status===400){
     this.useSettingsFallback=true;
    }else{
     await ensureOk(res,'upsert platform_store');
    }
   }

   const getRes=await supabaseFetch(this.config,this.fetchImpl,'platform_settings?select=id,data&order=id.asc&limit=1',{method:'GET'});
   await ensureOk(getRes,'select platform_settings for store');
   const rows=(await getRes.json().catch(()=>[])) as Row[];
   if(rows.length>0&&rows[0]?.id!=null){
    const existing=(rows[0].data&&typeof rows[0].data==='object'?rows[0].data:{}) as Record<string,unknown>;
    const patchRes=await supabaseFetch(
     this.config,
     this.fetchImpl,
     `platform_settings?id=eq.${Number(rows[0].id)}`,
     {
      method:'PATCH',
      headers:{Prefer:'return=minimal'},
      body:JSON.stringify({data:{...existing,_platformStore:storeData}}),
     },
    );
    await ensureOk(patchRes,'patch platform_settings store fallback');
   }else{
    const postRes=await supabaseFetch(
     this.config,
     this.fetchImpl,
     'platform_settings',
     {
      method:'POST',
      headers:{Prefer:'return=minimal'},
      body:JSON.stringify({data:{_platformStore:storeData}}),
     },
    );
    await ensureOk(postRes,'insert platform_settings store fallback');
   }
  };

  const next=this.queue.then(runSave);
  this.queue=next.catch(()=>{});
  await next;
 }
}
