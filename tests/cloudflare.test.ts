import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import worker, {type Env} from '../functions/worker';

const repository = fileURLToPath(new URL('..', import.meta.url));

async function read(relative: string) {
  return readFile(path.join(repository, relative), 'utf8');
}

// A fake deployment: no account service configured, static assets answer with a marker body.
const envWith = (vars: Partial<Env> = {}): Env => ({
  ASSETS: {fetch: async () => new Response('asset', {status: 200})},
  ...vars,
});

test('wrangler.toml deploys the Vite site and the /api worker to Cloudflare', async () => {
  const wrangler = await read('wrangler.toml');
  assert.match(wrangler, /name\s*=\s*"scout"/);
  assert.match(wrangler, /compatibility_date/);
  assert.match(wrangler, /main\s*=\s*"functions\/worker\.ts"/);
  assert.match(wrangler, /\[build\]/);
  assert.match(wrangler, /command\s*=\s*"npm run build"/);
  assert.match(wrangler, /\[assets\]/);
  assert.match(wrangler, /directory\s*=\s*"\.\/dist"/);
  assert.match(wrangler, /binding\s*=\s*"ASSETS"/);
  // SPA fallback lives in wrangler.toml now: the Pages-style _redirects rule is an infinite
  // loop on Workers and is rejected there.
  assert.match(wrangler, /not_found_handling\s*=\s*"single-page-application"/);
  assert.match(wrangler, /run_worker_first\s*=\s*true/);
  // No real credentials in version control.
  assert.ok(!/[re_]_[A-Za-z0-9]{20,}/.test(wrangler));
});

test('public/_headers sets security headers and no secrets', async () => {
  const headers = await read('public/_headers');
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Referrer-Policy/);
  assert.match(headers, /Strict-Transport-Security/);
  assert.match(headers, /Content-Security-Policy/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /frame-ancestors 'none'/);
  // Vite emits hashed assets at /assets/*, not /dist/*.
  assert.match(headers, /\/assets\/\*/);
  assert.match(headers, /max-age=31536000, immutable/);
  assert.ok(!/(sk_live|re_)_[A-Za-z0-9]{20,}/.test(headers));
});

test('the shared api handlers stay in functions/api', async () => {
  await read('functions/api/beta/[[path]].ts');
  await read('functions/api/platform/[[path]].ts');
  await read('functions/api/surface.ts');
  await read('functions/api/healthz.ts');
});

test('the worker answers the site health probes', async () => {
  const healthz = await worker.fetch(new Request('https://scout.test/api/healthz'), envWith());
  assert.equal(healthz.status, 200);
  assert.deepEqual(await healthz.json(), {ok: true, surface: 'site', service: 'website'});

  const surface = await worker.fetch(new Request('https://scout.test/api/surface'), envWith());
  assert.equal(surface.status, 200);
  assert.deepEqual(await surface.json(), {surface: 'site', service: 'website'});

  const head = await worker.fetch(
    new Request('https://scout.test/api/healthz', {method: 'HEAD'}),
    envWith(),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('the worker refuses mutations on probes and 404s unknown API routes as JSON', async () => {
  const post = await worker.fetch(
    new Request('https://scout.test/api/healthz', {method: 'POST'}),
    envWith(),
  );
  assert.equal(post.status, 405);

  const unknown = await worker.fetch(new Request('https://scout.test/api/nope'), envWith());
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as {code: string}).code, 'not-found');
});

test('the worker proxies /api/beta to the account service and never leaks the service key', async () => {
  // Without the service URL the proxy fails visibly.
  const unavailable = await worker.fetch(new Request('https://scout.test/api/beta/status'), envWith());
  assert.equal(unavailable.status, 503);
  assert.equal(((await unavailable.json()) as {code: string}).code, 'service-unavailable');

  // Unknown account routes are refused before any forwarding.
  const unknown = await worker.fetch(
    new Request('https://scout.test/api/beta/not-a-route'),
    envWith({SCOUT_ACCOUNT_SERVICE_URL: 'http://127.0.0.1:8790'}),
  );
  assert.equal(unknown.status, 404);

  // With the service configured: forwards, injects the owner key only on the application desk,
  // and strips the plaintext invitation token from owner decisions.
  const seen: {url: string; authorization: string | null; cookie: string | null; body: string}[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      cookie: new Headers(init?.headers).get('cookie'),
      body,
    });
    return new Response(JSON.stringify({status: 'approved', invite: 'SECRET-TOKEN'}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }) as typeof fetch;
  try {
    const status = await worker.fetch(
      new Request('https://scout.test/api/beta/status', {
        headers: {cookie: 'scout_account=session'},
      }),
      envWith({SCOUT_ACCOUNT_SERVICE_URL: 'http://127.0.0.1:8790', SCOUT_BETA_API_KEY: 'svc-key'}),
    );
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {status: 'approved', invite: 'SECRET-TOKEN'});
    assert.equal(seen[0]?.url, 'http://127.0.0.1:8790/status');
    assert.equal(seen[0]?.authorization, null, 'browser-safe routes carry no service key');
    assert.equal(seen[0]?.cookie, 'scout_account=session');

    const decision = await worker.fetch(
      new Request('https://scout.test/api/beta/applications/1/approve', {method: 'POST', body: '{}'}),
      envWith({SCOUT_ACCOUNT_SERVICE_URL: 'http://127.0.0.1:8790', SCOUT_BETA_API_KEY: 'svc-key'}),
    );
    assert.equal(decision.status, 200);
    assert.equal(seen[1]?.url, 'http://127.0.0.1:8790/applications/1/approve');
    assert.equal(seen[1]?.authorization, 'Bearer svc-key', 'the desk gets the key server-side');
    const body = (await decision.json()) as Record<string, unknown>;
    assert.equal('invite' in body, false, 'invitation tokens are delivered by email only');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the worker keeps the platform stub and serves static assets for everything else', async () => {
  const platform = await worker.fetch(new Request('https://scout.test/api/platform/stats'), envWith());
  assert.equal(platform.status, 503);
  assert.equal(((await platform.json()) as {code: string}).code, 'unavailable');

  const page = await worker.fetch(new Request('https://scout.test/apply'), envWith());
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset');
});
