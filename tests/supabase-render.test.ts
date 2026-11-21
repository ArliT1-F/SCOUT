import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAccountService,LAST_SEEN_RESOLUTION_MS} from '../server/account-service.js';
import {migrateAccountDatabase} from '../server/account-migrations.js';
import {PlatformStore} from '../server/platform.js';
import {SupabaseAccountMirror,supabaseConfiguration} from '../server/supabase-store.js';
import {platformHost} from './helpers/platform-host.js';

const TEST_EMAIL_ENV = {
 SCOUT_EMAIL_API_KEY: 're_test_key',
 SCOUT_EMAIL_FROM: 'SCOUT Test <no-reply@example.test>',
 SCOUT_EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
 SCOUT_ACCOUNT_BASE_URL: 'https://accounts.example.test',
};

/**
 * In-memory PostgREST server emulating Supabase `/rest/v1/<table>` endpoints, including the parts
 * that bite in production: a response holds at most `maxRows` rows (Supabase's default is 1,000),
 * `limit`/`offset` page through the rest, `Prefer: count=exact` reports the total in Content-Range,
 * `events` has no key column, and `audit_logs.id` is generated. `control.failWrites` makes every
 * write answer 503, the way a Supabase outage looks to the mirror.
 */
async function startMockSupabaseServer(t: {after: (fn: () => Promise<void>) => void}, options: {maxRows?: number} = {}) {
 const maxRows = options.maxRows ?? 1000;
 const control = {failWrites: false, writes: [] as {method: string; table: string; rows: number}[]};
 const tables = new Map<string, Record<string, unknown>[]>([
  ['accounts', []],
  ['sessions', []],
  ['devices', []],
  ['grants', []],
  ['platform_settings', []],
  ['events', []],
  ['audit_logs', []],
  ['account_roles', []],
  ['password_recovery_tokens', []],
  ['email_outbox', []],
  ['platform_store', []],
 ]);
 const primaryKeys: Record<string, string[]> = {
  accounts: ['id'],
  sessions: ['id'],
  devices: ['id'],
  grants: ['code'],
  platform_settings: ['id'],
  events: [],
  audit_logs: ['id'],
  account_roles: ['account_id', 'role'],
  password_recovery_tokens: ['id'],
  email_outbox: ['id'],
  platform_store: ['id'],
 };

 const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const match = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
  if (!match) {
   res.writeHead(404, {'Content-Type': 'application/json'});
   res.end(JSON.stringify({message: 'Not found'}));
   return;
  }
  const table = match[1];
  const rows = tables.get(table);
  if (!rows) {
   res.writeHead(404, {'Content-Type': 'application/json'});
   res.end(JSON.stringify({message: `Relation ${table} does not exist`}));
   return;
  }
  if (req.method === 'GET') {
   let result = [...rows];
   for (const [k, v] of url.searchParams.entries()) {
    if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue;
    if (v.startsWith('eq.')) {
     const expected = v.slice(3);
     result = result.filter(r => String(r[k]) === expected);
    }
   }
   const offset = Number(url.searchParams.get('offset') || 0);
   const limit = Math.min(Number(url.searchParams.get('limit') || Infinity), maxRows);
   const page = result.slice(offset, offset + limit);
   const total = String(req.headers.prefer || '').includes('count=exact') ? String(result.length) : '*';
   res.writeHead(200, {'Content-Type': 'application/json', 'Content-Range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${total}`});
   res.end(JSON.stringify(page));
   return;
  }
  if (req.method !== 'GET' && control.failWrites) {
   res.writeHead(503, {'Content-Type': 'application/json'});
   res.end(JSON.stringify({message: 'Service Unavailable'}));
   return;
  }
  if (req.method === 'POST') {
   let raw = '';
   for await (const chunk of req) raw += chunk;
   const parsed = raw ? JSON.parse(raw) : [];
   const incoming: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
   const pk = primaryKeys[table] || ['id'];
   control.writes.push({method: 'POST', table, rows: incoming.length});
   for (const item of incoming) {
    if (table === 'audit_logs' && item.id == null) item.id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
    if (!pk.length) {
     rows.push({...item});
     continue;
    }
    const idx = rows.findIndex(existing => pk.every(k => String(existing[k]) === String(item[k])));
    if (idx >= 0) rows[idx] = {...rows[idx], ...item};
    else rows.push({...item});
   }
   res.writeHead(201, {'Content-Type': 'application/json'});
   res.end(JSON.stringify(incoming));
   return;
  }
  if (req.method === 'DELETE') {
   for (const [k, v] of url.searchParams.entries()) {
    if (v.startsWith('in.(') && v.endsWith(')')) {
     const inner = v.slice(4, -1);
     const values = inner
      .split(',')
      .map(s => s.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"'));
     const valueSet = new Set(values);
     const kept = rows.filter(r => !valueSet.has(String(r[k])));
     tables.set(table, kept);
    }
   }
   res.writeHead(204);
   res.end();
   return;
  }
  res.writeHead(405);
  res.end();
 });

 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
 t.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
 });
 const address = server.address();
 const port = typeof address === 'object' && address ? address.port : 0;
 return {
  url: `http://127.0.0.1:${port}`,
  serviceRoleKey: 'test-supabase-service-role-key',
  tables,
  control,
 };
}

test('supabaseConfiguration resolves SUPABASE_URL or derives it from DATABASE_URL', () => {
 assert.equal(supabaseConfiguration({}), null);
 const direct = supabaseConfiguration({
  SUPABASE_URL: 'https://qtfbtfkthtvfpjvghyop.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'srv_key',
 });
 assert.deepEqual(direct, {
  url: 'https://qtfbtfkthtvfpjvghyop.supabase.co',
  serviceRoleKey: 'srv_key',
 });

 const fromDbUrl = supabaseConfiguration({
  DATABASE_URL: 'postgresql://postgres:secret@db.qtfbtfkthtvfpjvghyop.supabase.co:6543/postgres',
  SUPABASE_SERVICE_ROLE_KEY: 'srv_key_2',
 });
 assert.deepEqual(fromDbUrl, {
  url: 'https://qtfbtfkthtvfpjvghyop.supabase.co',
  serviceRoleKey: 'srv_key_2',
 });
});

test('Supabase migrations use BIGINT for epoch-ms timestamps and define platform_store with RLS', async () => {
 const m001 = await readFile('supabase/migrations/001_initial_account_schema.sql', 'utf8');
 const m002 = await readFile('supabase/migrations/002_render_supabase_cutover.sql', 'utf8');
 const m003 = await readFile('supabase/migrations/003_revocation_and_delivery_diagnostics.sql', 'utf8');
 assert.match(m001, /created_at\s+BIGINT\s+NOT NULL/);
 assert.match(m001, /CREATE TABLE IF NOT EXISTS platform_store/);
 assert.match(m001, /ENABLE ROW LEVEL SECURITY/);
 assert.match(m002, /ALTER COLUMN created_at TYPE BIGINT/);
 assert.match(m002, /CREATE TABLE IF NOT EXISTS platform_store/);
 assert.match(m003, /'revoked'/, 'the status constraint admits revoked accounts');
 assert.match(m003, /ADD COLUMN IF NOT EXISTS revoked_reason/);
 assert.match(m003, /ADD COLUMN IF NOT EXISTS last_error_status/);
 assert.match(m003, /ADD COLUMN IF NOT EXISTS last_provider_error/);
});

test('Account service and PlatformStore persist across simulated Render Free Tier restarts via Supabase', async t => {
 const supa = await startMockSupabaseServer(t);
 const supabaseCfg = {url: supa.url, serviceRoleKey: supa.serviceRoleKey};
 const sentEmails: {to: string; subject: string; text: string; html: string}[] = [];

 // 1. Start first container instance with in-memory SQLite + Supabase mirror
 const service1 = await createAccountService({
  file: ':memory:',
  port: 0,
  host: '127.0.0.1',
  apiKey: 'render-service-key',
  ownerEmail: 'owner@example.com',
  emailBaseUrl: 'https://scout.example.test',
  emailEncryptionKey: Buffer.alloc(32, 7),
  emailTransport: async msg => {
   sentEmails.push(msg);
  },
  supabase: supabaseCfg,
 });
 t.after(async () => {
  await service1.close().catch(() => {});
 });

 const call = async (baseUrl: string, route: string, body?: unknown, opts: {method?: string; cookie?: string; auth?: string} = {}) => {
  const res = await fetch(baseUrl + route, {
   method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
   headers: {
    'Content-Type': 'application/json',
    ...(opts.cookie ? {Cookie: opts.cookie} : {}),
    ...(opts.auth ? {Authorization: `Bearer ${opts.auth}`} : {}),
   },
   body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json();
  const cookie = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  return {status: res.status, body: json, cookie};
 };

 // Apply, approve, activate, and sign in on instance 1
 const applied = await call(service1.url, '/apply', {
  name: 'Render Owner',
  email: 'owner@example.com',
  organisation: 'SCOUT Studio',
  country: 'AL',
  useCase: 'Weekly cups',
  events: '2 per month',
 });
 assert.equal(applied.status, 200);
 const accountId = applied.body.account.id;

 const approved = await call(
  service1.url,
  `/applications/${accountId}`,
  {decision: 'approve', decidedBy: 'Render Owner'},
  {auth: 'render-service-key'},
 );
 assert.equal(approved.status, 200);
 assert.equal(sentEmails.length, 1);
 assert.ok(approved.body.invite);

 const activated = await call(service1.url, '/activate', {
  invite: approved.body.invite,
  password: 'RenderSupabasePassword!123',
 });
 assert.equal(activated.status, 200);
 assert.ok(activated.cookie.includes('scout_account='));

 // Update platform settings on instance 1
 const updatedSettings = await call(
  service1.url,
  '/settings',
  {applicationsOpen: false, reviewNote: 'Closed for tournament weekend'},
  {method: 'PUT', cookie: activated.cookie},
 );
 assert.equal(updatedSettings.status, 200);
 assert.equal(updatedSettings.body.settings.applicationsOpen, false);

 // Link a launcher device on instance 1
 const deviceStarted = await call(service1.url, '/device/start', {
  label: 'Render Studio Rig',
  platform: 'win32',
 });
 assert.equal(deviceStarted.status, 200);

 const deviceApproved = await call(
  service1.url,
  '/device/approve',
  {userCode: deviceStarted.body.userCode},
  {cookie: activated.cookie},
 );
 assert.equal(deviceApproved.status, 200);

 const devicePolled = await call(service1.url, '/device/poll', {
  deviceCode: deviceStarted.body.deviceCode,
 });
 assert.equal(devicePolled.status, 200);
 assert.equal(devicePolled.body.status, 'approved');
 const deviceId = devicePolled.body.deviceId;
 const deviceToken = devicePolled.body.installationToken;

 // Shut down instance 1 (simulating Render Free Tier spin-down)
 await service1.close();

 // 2. Boot a fresh instance 2 with a brand-new `:memory:` SQLite DB connected to the same Supabase store
 const service2 = await createAccountService({
  file: ':memory:',
  port: 0,
  host: '127.0.0.1',
  apiKey: 'render-service-key',
  ownerEmail: 'owner@example.com',
  emailBaseUrl: 'https://scout.example.test',
  emailEncryptionKey: Buffer.alloc(32, 7),
  emailTransport: async msg => {
   sentEmails.push(msg);
  },
  supabase: supabaseCfg,
 });
 t.after(async () => {
  await service2.close().catch(() => {});
 });

 // Session cookie from instance 1 is still valid on instance 2!
 const statusAfterRestart = await call(service2.url, '/status', undefined, {cookie: activated.cookie});
 assert.equal(statusAfterRestart.status, 200);
 assert.equal(statusAfterRestart.body.applicationsOpen, false);
 assert.equal(statusAfterRestart.body.reviewNote, 'Closed for tournament weekend');
 assert.equal(statusAfterRestart.body.account?.email, 'owner@example.com');
 assert.equal(statusAfterRestart.body.account?.devices?.length, 1);

 // Device licence check from instance 1 still succeeds on instance 2!
 const licenceCheck = await call(
  service2.url,
  '/license/check',
  {deviceId, installationId: 'inst_render_123456', token: deviceToken},
  {auth: 'render-service-key'},
 );
 assert.equal(licenceCheck.status, 200);
 assert.equal(licenceCheck.body.status, 'active');
 assert.equal(licenceCheck.body.email, 'owner@example.com');

 // 3. Verify PlatformStore (tournaments + settings) also survives a restart via Supabase
 const tempDir = await mkdtemp(path.join(tmpdir(), 'scout-supa-platform-'));
 t.after(async () => {
  await rm(tempDir, {recursive: true, force: true});
 });
 const store1 = await new PlatformStore(path.join(tempDir, 'instance1', 'store.json'), Date.now, {
  supabase: supabaseCfg,
 }).load();
 await store1.setSettings({...store1.settings, applicationsOpen: false, reviewNote: 'Persisted via Supabase'});
 const createdTournament = await store1.create(accountId, 'owner@example.com', 'Tirana Major', null);
 assert.equal(createdTournament.ok, true);

 // Load store2 from a completely different empty path using Supabase
 const store2 = await new PlatformStore(path.join(tempDir, 'instance2', 'store.json'), Date.now, {
  supabase: supabaseCfg,
 }).load();
 assert.equal(store2.settings.applicationsOpen, false);
 assert.equal(store2.settings.reviewNote, 'Persisted via Supabase');
 assert.equal(store2.data.tournaments.length, 1);
 assert.equal(store2.data.tournaments[0].name, 'Tirana Major');
});

test('Website surface with embedded account service + Supabase serves /api/beta/status, /api/healthz, and bare /status on one Render port', async t => {
 const supa = await startMockSupabaseServer(t);
 const site = await platformHost(t, {
  SCOUT_SURFACE: 'site',
  SCOUT_EMBED_ACCOUNT_SERVICE: '1',
  SCOUT_BETA_API_KEY: 'shared-render-key',
  SUPABASE_URL: supa.url,
  SUPABASE_SERVICE_ROLE_KEY: supa.serviceRoleKey,
 });

 const healthz = await site.request('/api/healthz');
 assert.equal(healthz.status, 200);
 assert.equal(healthz.body.ok, true);

 const betaStatus = await site.request('/api/beta/status');
 assert.equal(betaStatus.status, 200);
 assert.equal(betaStatus.body.mode, 'hosted');
 assert.equal(betaStatus.body.applicationsOpen, true);

 // Bare /status and /settings work for external callers (venue hosts and operator tooling)
 const bareStatus = await site.request('/status');
 assert.equal(bareStatus.status, 200);
 assert.equal(bareStatus.body.mode, 'hosted');

 const unauthorizedSettings = await site.request('/settings');
 assert.equal(unauthorizedSettings.status, 401);

 const authorizedSettings = await site.request('/settings', undefined, {
  headers: {Authorization: 'Bearer shared-render-key'},
 });
 assert.equal(authorizedSettings.status, 200);
 assert.equal(authorizedSettings.body.settings.applicationsOpen, true);
});

// ---------------------------------------------------------------------------------------------
// Durability of the Supabase mirror: an in-memory database on Render is only as safe as its copy.

const applicant = (email: string) => ({name: 'Late Applicant', email, organisation: 'SCOUT Studio', country: 'AL', useCase: 'Weekly cups', events: '2 per month'});
const countRows = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n);
async function waitFor(check: () => boolean, ms: number, what: string) {
 const deadline = Date.now() + ms;
 while (!check()) {
  if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
  await new Promise(resolve => setTimeout(resolve, 50));
 }
}
function serviceOptions(supa: {url: string; serviceRoleKey: string}, extra: Record<string, unknown> = {}) {
 return {
  file: ':memory:', port: 0, host: '127.0.0.1', apiKey: 'render-service-key', ownerEmail: 'owner@example.com',
  emailBaseUrl: 'https://scout.example.test', emailEncryptionKey: Buffer.alloc(32, 7), emailTransport: async () => {},
  supabase: {url: supa.url, serviceRoleKey: supa.serviceRoleKey}, ...extra,
 };
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
 fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)});

test('startup reads every row, not just the first page Supabase answers with', async t => {
 const supa = await startMockSupabaseServer(t);
 const now = Date.now();
 // Three events share each timestamp: ties are where a careless page order loses rows.
 for (let i = 0; i < 2345; i++) supa.tables.get('events')!.push({at: now + Math.floor(i / 3), kind: 'apply', account_id: null, detail: ''});
 for (let i = 0; i < 1203; i++) supa.tables.get('sessions')!.push({id: `s${String(i).padStart(5, '0')}`, account_id: 'a1', created_at: now, last_seen_at: now, address: '', user_agent: ''});
 for (let i = 1; i <= 1500; i++) supa.tables.get('audit_logs')!.push({id: i, occurred_at: i, request_id: null, actor_type: 'service', actor_id: null, action: 'test', target_type: 'account', target_id: null, metadata: {}});
 const db = new DatabaseSync(':memory:');
 migrateAccountDatabase(db);
 await new SupabaseAccountMirror({url: supa.url, serviceRoleKey: supa.serviceRoleKey}).hydrate(db);
 assert.equal(countRows(db, 'events'), 2345);
 assert.equal(countRows(db, 'sessions'), 1203);
 assert.equal(countRows(db, 'audit_logs'), 1500);
 assert.equal(supa.tables.get('events')!.length, 2345, 'hydrating pushes nothing back');
 db.close();
});

test('a write Supabase refused is retried on its own and survives a restart', async t => {
 const supa = await startMockSupabaseServer(t);
 const service = await createAccountService(serviceOptions(supa));
 t.after(async () => {await service.close().catch(() => {})});
 supa.control.failWrites = true;
 const refused = await post(service.url + '/apply', applicant('late@example.com'));
 assert.equal(refused.status, 500, 'the applicant is told the save failed');
 supa.control.failWrites = false;
 // No further request arrives: only the service's own retry can carry the row to Supabase.
 await waitFor(() => supa.tables.get('accounts')!.some(row => row.normalized_email === 'late@example.com'), 5000, 'the background retry');
 await service.close();
 const restarted = await createAccountService(serviceOptions(supa));
 t.after(async () => {await restarted.close().catch(() => {})});
 assert.ok(restarted.db.list().some(account => account.email === 'late@example.com'), 'the application outlived the instance');
});

test('signed-in page views do not write to the database each time', async t => {
 const supa = await startMockSupabaseServer(t);
 let clock = Date.now();
 const service = await createAccountService(serviceOptions(supa, {now: () => clock}));
 t.after(async () => {await service.close().catch(() => {})});
 const applied = await (await post(service.url + '/apply', applicant('owner@example.com'))).json();
 const approved = await (await post(service.url + `/applications/${applied.account.id}`, {decision: 'approve', decidedBy: 'Owner'}, {Authorization: 'Bearer render-service-key'})).json();
 const activated = await post(service.url + '/activate', {invite: approved.invite, password: 'RenderSupabasePassword!123'});
 const cookie = (activated.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
 const status = () => fetch(service.url + '/status', {headers: {Cookie: cookie}, signal: AbortSignal.timeout(10_000)});
 supa.control.writes.length = 0;
 for (let i = 0; i < 5; i++) {
  clock += 1000;
  const res = await status();
  assert.equal((await res.json()).account?.email, 'owner@example.com');
 }
 assert.deepEqual(supa.control.writes.filter(write => write.table === 'sessions'), [], 'five page views inside the window write nothing');
 clock += LAST_SEEN_RESOLUTION_MS + 1;
 await status();
 assert.equal(supa.control.writes.filter(write => write.table === 'sessions').length, 1, 'the session is still kept alive');
});

test('a persistent local database keeps mirroring the events and audit rows it writes after startup', async t => {
 const supa = await startMockSupabaseServer(t);
 for (let i = 0; i < 5; i++) supa.tables.get('events')!.push({at: i, kind: 'remote-history', account_id: null, detail: ''});
 for (let i = 1; i <= 300; i++) supa.tables.get('audit_logs')!.push({id: i, occurred_at: i, request_id: null, actor_type: 'service', actor_id: null, action: 'remote-history', target_type: 'account', target_id: null, metadata: {}});
 const db = new DatabaseSync(':memory:');
 migrateAccountDatabase(db);
 const addEvent = (kind: string) => db.prepare('INSERT INTO events (at, kind, account_id, detail) VALUES (?, ?, NULL, ?)').run(Date.now(), kind, '');
 const addAudit = (action: string) => db.prepare("INSERT INTO audit_logs (occurred_at, actor_type, action, target_type) VALUES (?, 'service', ?, 'account')").run(Date.now(), action);
 addEvent('local-history');addEvent('local-history');addAudit('local-history');addAudit('local-history');
 const mirror = new SupabaseAccountMirror({url: supa.url, serviceRoleKey: supa.serviceRoleKey});
 await mirror.hydrate(db);
 addEvent('after-startup');addAudit('after-startup');
 await mirror.flush(db);
 assert.equal(supa.tables.get('events')!.filter(row => row.kind === 'after-startup').length, 1, 'a new local event reaches Supabase');
 assert.equal(supa.tables.get('audit_logs')!.filter(row => row.action === 'after-startup').length, 1, 'a new local audit row reaches Supabase');
 db.close();
});

test('stopping the website pushes changes Supabase has not acknowledged yet', async t => {
 const supa = await startMockSupabaseServer(t);
 const site = await platformHost(t, {SCOUT_SURFACE: 'site', SCOUT_EMBED_ACCOUNT_SERVICE: '1', SCOUT_BETA_API_KEY: 'shared-render-key', SUPABASE_URL: supa.url, SUPABASE_SERVICE_ROLE_KEY: supa.serviceRoleKey});
 supa.control.failWrites = true;
 const refused = await site.request('/api/beta/apply', applicant('spin-down@example.com'));
 assert.notEqual(refused.status, 200);
 supa.control.failWrites = false;
 // Render's spin-down, straight away: the shutdown path has to do the saving.
 const exited = new Promise<number | null>(resolve => site.child.once('exit', code => resolve(code)));
 site.child.kill('SIGTERM');
 assert.equal(await exited, 0, 'a clean exit on SIGTERM');
 assert.ok(supa.tables.get('accounts')!.some(row => row.normalized_email === 'spin-down@example.com'), 'the application was saved before the process ended');
});
