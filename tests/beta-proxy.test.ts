import test from 'node:test';
import assert from 'node:assert/strict';

import {onRequest as betaProxy} from '../functions/api/beta/[[path]]';

const TUNNEL = 'https://ata-honolulu-pumps-honey.trycloudflare.com';

type FetchCall = {url: string; init?: RequestInit};

async function captureRuntime(
  fetchImpl: typeof fetch,
  run: () => Promise<Response>,
): Promise<{response: Response; logs: string[]; events: Record<string, unknown>[]}> {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  globalThis.fetch = fetchImpl;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    const response = await run();
    return {
      response,
      logs,
      events: logs
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.event === 'scout-beta-proxy'),
    };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
}

const unusedFetch = async (): Promise<Response> => {
  throw new Error('fetch must not be called');
};

const request = (path: string, init?: RequestInit) =>
  new Request(`https://scout.test${path}`, init);

test('missing or malformed SCOUT_ACCOUNT_SERVICE_URL fails safely before any upstream fetch', async () => {
  const missing = await captureRuntime(unusedFetch as typeof fetch, () =>
    betaProxy({env: {}, request: request('/api/beta/status')}),
  );
  assert.equal(missing.response.status, 503);
  assert.equal(((await missing.response.json()) as {code: string}).code, 'service-unavailable');
  assert.equal(missing.events[0]?.upstreamFetchAttempted, false);
  assert.equal(missing.events[0]?.proxyStatus, 503);
  assert.ok(missing.response.headers.get('x-scout-request-id'));

  const malformed = await captureRuntime(unusedFetch as typeof fetch, () =>
    betaProxy({
      env: {SCOUT_ACCOUNT_SERVICE_URL: 'not a URL'},
      request: request('/api/beta/status'),
    }),
  );
  assert.equal(malformed.response.status, 503);
  assert.equal(((await malformed.response.json()) as {code: string}).code, 'service-unavailable');
  assert.equal(malformed.events[0]?.upstreamFetchAttempted, false);
  assert.equal(malformed.events[0]?.errorName, 'TypeError');
});

test('status maps to the tunnel /status route, preserves its JSON and forwards session cookies', async () => {
  const calls: FetchCall[] = [];
  const status = {
    mode: 'hosted',
    applicationsOpen: true,
    signedIn: false,
    account: null,
    download: null,
    host: 'SCOUT account service',
    reviewNote: '',
  };
  const result = await captureRuntime(
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({url: String(input), init});
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': '999',
          'set-cookie': 'scout_account=fresh; Path=/; HttpOnly',
          'x-request-id': 'account-request-1',
        },
      });
    }) as typeof fetch,
    () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: `${TUNNEL}///`, SCOUT_BETA_API_KEY: 'owner-secret'},
        request: request('/api/beta/status?source=probe', {
          headers: {cookie: 'scout_account=session', accept: 'application/json'},
        }),
      }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${TUNNEL}/status?source=probe`);
  assert.equal(new Headers(calls[0]?.init?.headers).get('cookie'), 'scout_account=session');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), null);
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), status);
  assert.equal(
    result.response.headers.get('set-cookie'),
    'scout_account=fresh; Path=/; HttpOnly',
  );
  assert.equal(result.response.headers.get('content-length'), null);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.events[0]?.upstreamHostname, 'ata-honolulu-pumps-honey.trycloudflare.com');
  assert.equal(result.events[0]?.upstreamPathname, '/status');
  assert.equal(result.events[0]?.upstreamFetchAttempted, true);
  assert.equal(result.events[0]?.upstreamStatus, 200);
  assert.equal(result.events[0]?.proxyStatus, 200);
  assert.equal(result.events[0]?.upstreamRequestId, 'account-request-1');
  assert.equal(
    result.events[0]?.requestId,
    result.response.headers.get('x-scout-request-id'),
    'the client can correlate the response with the server-side diagnostic',
  );
  assert.ok(!result.logs.join('\n').includes('scout_account=session'));
  assert.ok(!result.logs.join('\n').includes('owner-secret'));
});

test('valid account-service HTTP errors retain their status and JSON contract', async () => {
  const result = await captureRuntime(
    (async () =>
      Response.json(
        {error: 'The closed beta is not taking new applications right now.', code: 'applications-closed'},
        {status: 403},
      )) as typeof fetch,
    () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL},
        request: request('/api/beta/apply', {method: 'POST', body: '{}'}),
      }),
  );

  assert.equal(result.response.status, 403);
  assert.deepEqual(await result.response.json(), {
    error: 'The closed beta is not taking new applications right now.',
    code: 'applications-closed',
  });
  assert.equal(result.events[0]?.upstreamStatus, 403);
  assert.equal(result.events[0]?.proxyStatus, 403);
  assert.match(String(result.events[0]?.upstreamBody), /applications-closed/);
});

test('network exceptions produce safe JSON and sanitized, correlated server logs', async () => {
  const ownerKey = 'owner-secret-that-must-not-be-logged';
  const result = await captureRuntime(
    (async () => {
      throw new TypeError(
        `fetch failed for ${TUNNEL}/status with Bearer ${ownerKey}; applicant@example.com at 192.0.2.44`,
      );
    }) as typeof fetch,
    () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL, SCOUT_BETA_API_KEY: ownerKey},
        request: request('/api/beta/status'),
      }),
  );

  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), {
    error: 'The account service could not be reached.',
    code: 'upstream-unreachable',
  });
  assert.equal(result.events[0]?.upstreamFetchAttempted, true);
  assert.equal(result.events[0]?.upstreamStatus, undefined);
  assert.equal(result.events[0]?.errorName, 'TypeError');
  assert.equal(result.events[0]?.proxyStatus, 502);
  const logs = result.logs.join('\n');
  assert.ok(!logs.includes(ownerKey));
  assert.ok(!logs.includes('applicant@example.com'));
  assert.ok(!logs.includes('192.0.2.44'));
  assert.ok(!logs.includes(`${TUNNEL}/status`));
  assert.match(String(result.events[0]?.errorMessage), /\[redacted/);
});

test('upstream error diagnostics redact personal data and credential-like fields', async () => {
  const result = await captureRuntime(
    (async () =>
      Response.json(
        {
          error: 'Retry from 2001:db8::1 or contact applicant@example.com',
          code: 'throttled',
          details: {email: 'applicant@example.com', password: 'do-not-log-this'},
        },
        {status: 429},
      )) as typeof fetch,
    () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL},
        request: request('/api/beta/login', {method: 'POST', body: '{}'}),
      }),
  );

  assert.equal(result.response.status, 429);
  const logs = result.logs.join('\n');
  assert.ok(!logs.includes('2001:db8::1'));
  assert.ok(!logs.includes('applicant@example.com'));
  assert.ok(!logs.includes('do-not-log-this'));
  assert.match(String(result.events[0]?.upstreamBody), /\[redacted/);
});

test('a Cloudflare 1003 response is diagnosed as an edge response, not relayed as a beta 403', async () => {
  const result = await captureRuntime(
    (async () =>
      new Response('error code: 1003', {
        status: 403,
        headers: {'content-type': 'text/plain; charset=UTF-8', server: 'cloudflare'},
      })) as typeof fetch,
    () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL},
        request: request('/api/beta/status'),
      }),
  );

  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), {
    error: 'The account service returned an invalid response.',
    code: 'upstream-invalid-response',
  });
  assert.equal(result.response.headers.get('server'), null);
  assert.equal(result.events[0]?.upstreamFetchAttempted, true);
  assert.equal(result.events[0]?.upstreamStatus, 403);
  assert.equal(result.events[0]?.proxyStatus, 502);
  assert.equal(result.events[0]?.cloudflareErrorCode, '1003');
  assert.equal(result.events[0]?.upstreamHostname, 'ata-honolulu-pumps-honey.trycloudflare.com');
  assert.equal(result.events[0]?.upstreamPathname, '/status');
});

test('non-JSON success and non-contract JSON errors are invalid upstream responses', async () => {
  for (const upstream of [
    new Response(`<html>${'not the account service'.repeat(500)}</html>`, {
      status: 200,
      headers: {'content-type': 'text/html'},
    }),
    Response.json({success: false, errors: [{message: 'gateway refused'}]}, {status: 403}),
  ]) {
    const result = await captureRuntime((async () => upstream) as typeof fetch, () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL},
        request: request('/api/beta/status'),
      }),
    );
    assert.equal(result.response.status, 502);
    assert.equal(
      ((await result.response.json()) as {code: string}).code,
      'upstream-invalid-response',
    );
    assert.equal(result.events[0]?.upstreamFetchAttempted, true);
    assert.ok(String(result.events[0]?.upstreamBody).length <= 769, 'error bodies are bounded');
  }
});

test('owner decisions inject only the server key, strip invites and never log request bodies', async () => {
  const calls: FetchCall[] = [];
  const ownerKey = 'server-owner-key';
  const result = await captureRuntime(
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({url: String(input), init});
      if (String(input).endsWith('/status'))
        return Response.json({reviewer: true, account: {id: 'owner-1'}}, {status: 200});
      return Response.json(
        {
          account: {id: 'account-1', email: 'applicant@example.com'},
          invite: 'plaintext-invite-token',
          invitationDelivery: {status: 'sent'},
        },
        {status: 200},
      );
    }) as typeof fetch,
    () =>
      betaProxy({
        env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL, SCOUT_BETA_API_KEY: ownerKey},
        request: request('/api/beta/applications/account-1', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer browser-supplied-key',
            cookie: 'scout_account=reviewer-session',
          },
          body: JSON.stringify({decision: 'approve', decidedBy: 'owner@example.com'}),
        }),
      }),
  );

  // The desk route first verifies the browser's session against the service's reviewer flag —
  // the check carries the browser cookie, never the service key.
  assert.equal(calls[0]?.url, `${TUNNEL}/status`);
  const checkHeaders = new Headers(calls[0]?.init?.headers);
  assert.equal(checkHeaders.get('authorization'), null);
  assert.equal(checkHeaders.get('cookie'), 'scout_account=reviewer-session');
  const headers = new Headers(calls[1]?.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${ownerKey}`);
  assert.equal(calls[1]?.url, `${TUNNEL}/applications/account-1`);
  assert.equal(calls[1]?.init?.body, JSON.stringify({decision: 'approve', decidedBy: 'owner@example.com'}));
  const body = (await result.response.json()) as Record<string, unknown>;
  assert.equal('invite' in body, false);
  const logs = result.logs.join('\n');
  assert.ok(!logs.includes(ownerKey));
  assert.ok(!logs.includes('browser-supplied-key'));
  assert.ok(!logs.includes('plaintext-invite-token'));
  assert.ok(!logs.includes('owner@example.com'));
  assert.ok(!logs.includes('applicant@example.com'));
});

test('desk routes verify the reviewer session before the service key is injected', async () => {
  const desk = (statusBody: unknown, headers?: Record<string, string>) => {
    const calls: FetchCall[] = [];
    const run = captureRuntime(
      (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({url: String(input), init});
        return Response.json(statusBody, {status: 200});
      }) as typeof fetch,
      () =>
        betaProxy({
          env: {SCOUT_ACCOUNT_SERVICE_URL: TUNNEL, SCOUT_BETA_API_KEY: 'server-owner-key'},
          request: request('/api/beta/applications', {headers}),
        }),
    );
    return {calls, run};
  };

  // Anonymous: no session at all, so /status has no account — 401, and the desk route is never
  // forwarded, so the service key never leaves the Worker.
  const anonymous = desk({reviewer: false, account: null});
  const anonymousResult = await anonymous.run;
  assert.equal(anonymousResult.response.status, 401);
  assert.equal(((await anonymousResult.response.json()) as {code: string}).code, 'no-account');
  assert.deepEqual(
    anonymous.calls.map((call) => call.url),
    [`${TUNNEL}/status`],
  );

  // Signed in but not a reviewer (an ordinary approved account) — 403, still never forwarded.
  const ordinary = desk({reviewer: false, account: {id: 'account-9'}}, {cookie: 'scout_account=user-session'});
  const ordinaryResult = await ordinary.run;
  assert.equal(ordinaryResult.response.status, 403);
  assert.equal(((await ordinaryResult.response.json()) as {code: string}).code, 'not-beta-reviewer');
  assert.deepEqual(
    ordinary.calls.map((call) => call.url),
    [`${TUNNEL}/status`],
  );

  // A reviewer session is forwarded with the key injected server-side.
  const reviewer = desk({reviewer: true, account: {id: 'owner-1'}}, {cookie: 'scout_account=reviewer-session'});
  const reviewerResult = await reviewer.run;
  assert.equal(reviewerResult.response.status, 200);
  assert.deepEqual(
    reviewer.calls.map((call) => call.url),
    [`${TUNNEL}/status`, `${TUNNEL}/applications`],
  );
  assert.equal(new Headers(reviewer.calls[0]?.init?.headers).get('authorization'), null);
  assert.equal(
    new Headers(reviewer.calls[1]?.init?.headers).get('authorization'),
    'Bearer server-owner-key',
  );
});
