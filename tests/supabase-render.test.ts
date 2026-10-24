import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAccountService} from '../server/account-service.js';
import {PlatformStore} from '../server/platform.js';
import {supabaseConfiguration} from '../server/supabase-store.js';
import {platformHost} from './helpers/platform-host.js';

const TEST_EMAIL_ENV = {
 SCOUT_EMAIL_API_KEY: 're_test_key',
 SCOUT_EMAIL_FROM: 'SCOUT Test <no-reply@example.test>',
 SCOUT_EMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
 SCOUT_ACCOUNT_BASE_URL: 'https://accounts.example.test',
};

/** In-memory PostgREST server emulating Supabase `/rest/v1/<table>` endpoints. */
async function startMockSupabaseServer(t: {after: (fn: () => Promise<void>) => void}) {
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
  events: ['id'],
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
    if (k === 'select' || k === 'order') continue;
    if (v.startsWith('eq.')) {
     const expected = v.slice(3);
     result = result.filter(r => String(r[k]) === expected);
    }
   }
   res.writeHead(200, {'Content-Type': 'application/json'});
   res.end(JSON.stringify(result));
   return;
  }
  if (req.method === 'POST') {
   let raw = '';
   for await (const chunk of req) raw += chunk;
   const parsed = raw ? JSON.parse(raw) : [];
   const incoming: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
   const pk = primaryKeys[table] || ['id'];
   for (const item of incoming) {
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

 // Bare /status and /settings work for external callers (Cloudflare Worker proxy or venue hosts)
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
