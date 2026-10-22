// Proxy for the closed-beta account API. The browser calls /api/beta/* on this origin and this
// function forwards them, server-to-server, to the Node.js account service
// (`server/account-service.ts`), which keeps running on Node because it uses node:sqlite,
// node:fs and password hashing that do not run on Cloudflare Workers (see docs/CLOUDFLARE.md).
//
// This mirrors the host's own account routing: the /api/beta prefix is stripped, the browser-
// safe routes are forwarded, and the owner service key is injected server-side so browsers
// never see it. Cookies flow both ways so `scout_account` sessions work exactly as on a
// self-hosted deployment.
//
// The account-service URL and the service key are Pages secrets; they never reach the browser.
// The plaintext invitation token is stripped from decision/resend responses: invites are
// delivered by email only, never returned to a browser (docs/BETA.md).
//
// Upstream errors return the upstream's status and `{error, code}` body, so the pages' contract
// (docs/BETA.md) is unchanged whether the website runs on a Node host or on Cloudflare Pages.

type Env = {
  SCOUT_ACCOUNT_SERVICE_URL?: string;
  SCOUT_BETA_API_KEY?: string;
};

// Browser-safe account routes, mirroring server/index.ts, plus the owner application desk
// (/applications*), which this proxy serves by injecting SCOUT_BETA_API_KEY server-side.
const PREFIX_ROUTES = [
  '/status',
  '/apply',
  '/login',
  '/logout',
  '/activate',
  '/password-recovery',
  '/password-recovery/complete',
  '/device/start',
  '/device/poll',
  '/device/approve',
  '/device/deny',
  '/devices/revoke',
  '/applications',
];

const FORWARD_HEADERS = ['cookie', 'content-type', 'accept', 'user-agent'];

const allowed = (route: string) =>
  PREFIX_ROUTES.some((p) => route === p || route.startsWith(p + '/'));

// Responses to owner decisions carry the plaintext invite token — remove it before the browser
// sees the body. Invitations are delivered by email only.
const stripInvite = (text: string): string => {
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      delete (body as {invite?: unknown}).invite;
    }
    return JSON.stringify(body);
  } catch {
    return text;
  }
};

export const onRequest = async (context: {env: Env; request: Request}) => {
  const base = context.env.SCOUT_ACCOUNT_SERVICE_URL;
  if (!base) {
    return Response.json(
      {error: 'The account service is not configured on this deployment.', code: 'service-unavailable'},
      {status: 503},
    );
  }

  const {request} = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/beta/, '');
  if (!allowed(route)) {
    return Response.json({error: 'Unknown account route.', code: 'not-found'}, {status: 404});
  }

  const target = new URL(`${base.replace(/\/+$/, '')}${route}${url.search}`);

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Owner-only application routes carry the service key server-side.
  if (route === '/applications' || route.startsWith('/applications/')) {
    const key = context.env.SCOUT_BETA_API_KEY;
    if (key) headers.set('authorization', `Bearer ${key}`);
  }

  let body: BodyInit | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      {error: 'The account service could not be reached.', code: 'upstream-unreachable'},
      {status: 502},
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('server');
  responseHeaders.set('cache-control', 'no-store');
  let bodyText = await upstream.text();
  if (route.startsWith('/applications/') && request.method === 'POST') {
    bodyText = stripInvite(bodyText);
  }
  return new Response(bodyText, {status: upstream.status, headers: responseHeaders});
};
