import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const repository = fileURLToPath(new URL('..', import.meta.url));

async function read(relative: string) {
  return readFile(path.join(repository, relative), 'utf8');
}

test('wrangler.toml configures Pages to build the Vite site', async () => {
  const wrangler = await read('wrangler.toml');
  assert.match(wrangler, /name\s*=\s*"scout-website"/);
  assert.match(wrangler, /\[build\]/);
  assert.match(wrangler, /command\s*=\s*"npm run build"/);
  assert.match(wrangler, /\[assets\]/);
  assert.match(wrangler, /directory\s*=\s*"\.\/dist"/);
  assert.match(wrangler, /compatibility_date/);
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
  assert.ok(!/(sk_live|re_)_[A-Za-z0-9]{20,}/.test(headers));
});

test('public/_redirects falls back to the SPA shell', async () => {
  const redirects = await read('public/_redirects');
  assert.match(redirects, /\/\*\s*\/index\.html\s*200/);
});

test('pages functions exist for the account API proxy and platform stub', async () => {
  await read('functions/api/beta/[[path]].ts');
  await read('functions/api/platform/[[path]].ts');
  await read('functions/api/surface.ts');
  await read('functions/api/healthz.ts');
});
