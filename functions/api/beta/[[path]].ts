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
// The account-service URL and the service key are Worker secrets; they never reach the browser.
// The plaintext invitation token is stripped from decision/resend responses: invites are
// delivered by email only, never returned to a browser (docs/BETA.md).
//
// Valid upstream JSON errors retain the upstream's status and `{error, code}` body. A proxy,
// tunnel or Cloudflare edge error is not an account-service response: it is logged server-side
// and returned to the browser as a safe 502 instead of leaking an HTML/plain-text edge page.

type Env = {
  SCOUT_ACCOUNT_SERVICE_URL?: string;
  SCOUT_BETA_API_KEY?: string;
};

type DiagnosticValue = string | number | boolean | null;
type Diagnostics = Record<string, DiagnosticValue | undefined>;

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
const MAX_LOG_TEXT = 768;
const SENSITIVE_BODY_KEY =
  /password|token|secret|cookie|authorization|api[-_]?key|email|address|invite|account|application|device|session|display[-_]?name|^name$|organisation|country|events|decided[-_]?by|requested[-_]?by|use[-_]?case/i;

const allowed = (route: string) =>
  PREFIX_ROUTES.some((p) => route === p || route.startsWith(p + '/'));

// Keep diagnostics useful without copying credentials, request data or personal data into logs.
// URL credentials and query strings are never logged separately; this also scrubs them if a
// runtime exception or an upstream error happens to include them.
const sanitizeText = (value: unknown, redactions: string[] = [], limit = MAX_LOG_TEXT): string => {
  let text = String(value ?? '');
  for (const secret of redactions) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  text = text
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(password|token|secret|api[-_]?key|authorization|cookie|scout_account|session)=([^\s,;&]+)/gi, '$1=[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, '[redacted-ip]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

// Error responses can contain account details from a non-SCOUT gateway. Preserve safe fields and
// structure for diagnosis, but redact values whose keys commonly carry credentials or personal data.
const sanitizeBody = (text: string, redactions: string[]): string => {
  const sanitizeValue = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return sanitizeText(value, redactions);
    if (depth >= 4) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 10).map((entry) => sanitizeValue(entry, depth + 1));
    if (typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
        output[sanitizeText(key, redactions, 80)] = SENSITIVE_BODY_KEY.test(key)
          ? '[redacted]'
          : sanitizeValue(entry, depth + 1);
      }
      return output;
    }
    return '[redacted]';
  };

  try {
    return sanitizeText(JSON.stringify(sanitizeValue(JSON.parse(text), 0)), redactions);
  } catch {
    return sanitizeText(text, redactions);
  }
};

const errorName = (error: unknown): string => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? name : 'UnknownError';
};

const targetFor = (base: string, route: string, search: string): URL => {
  const target = new URL(base.trim());
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('The account service URL must use HTTP or HTTPS.');
  }
  if (target.username || target.password) {
    throw new Error('The account service URL must not contain credentials.');
  }

  // SCOUT_ACCOUNT_SERVICE_URL is an origin (an optional reverse-proxy path remains supported).
  // Replace, rather than append to, any configured query/hash, and append exactly one route slash.
  const prefix = target.pathname.replace(/\/+$/, '');
  target.pathname = `${prefix}${route}`;
  target.search = search;
  target.hash = '';
  return target;
};

const jsonContentType = (value: string | null): boolean =>
  Boolean(value && /^\s*application\/(?:json|[^;]+\+json)\b/i.test(value));

const cloudflareErrorCode = (body: string): string | null =>
  body.match(/\berror code:\s*(1\d{3})\b/i)?.[1] ??
  body.match(/\bCloudflare\s+Error\s+(1\d{3})\b/i)?.[1] ??
  null;

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
  const {request} = context;
  const requestId = crypto.randomUUID();
  const incomingUrl = new URL(request.url);
  const route = incomingUrl.pathname.replace(/^\/api\/beta/, '');
  const base = context.env.SCOUT_ACCOUNT_SERVICE_URL?.trim();
  const redactions = [base ?? '', context.env.SCOUT_BETA_API_KEY ?? ''].filter(Boolean);
  let target: URL | undefined;
  let upstreamFetchAttempted = false;

  const log = (proxyStatus: number, fields: Diagnostics = {}, level: 'log' | 'error' = 'log') => {
    const line = JSON.stringify({
      event: 'scout-beta-proxy',
      requestId,
      incomingRoute: incomingUrl.pathname,
      upstreamHostname: target?.hostname ?? null,
      upstreamPathname: target?.pathname ?? null,
      upstreamFetchAttempted,
      proxyStatus,
      ...fields,
    });
    console[level](line);
  };

  const jsonResponse = (
    status: number,
    body: {error: string; code: string},
    fields: Diagnostics = {},
    level: 'log' | 'error' = 'log',
  ) => {
    log(status, fields, level);
    const response = Response.json(body, {status, headers: {'cache-control': 'no-store'}});
    response.headers.set('x-scout-request-id', requestId);
    return response;
  };

  if (!base) {
    return jsonResponse(
      503,
      {error: 'The account service is not configured on this deployment.', code: 'service-unavailable'},
      {},
      'error',
    );
  }

  if (!allowed(route)) {
    return jsonResponse(404, {error: 'Unknown account route.', code: 'not-found'});
  }

  try {
    target = targetFor(base, route, incomingUrl.search);
    redactions.push(target.toString());
  } catch (error) {
    return jsonResponse(
      503,
      {error: 'The account service is not configured correctly on this deployment.', code: 'service-unavailable'},
      {errorName: errorName(error), errorMessage: sanitizeText(error instanceof Error ? error.message : error, redactions)},
      'error',
    );
  }

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
    upstreamFetchAttempted = true;
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return jsonResponse(
      502,
      {error: 'The account service could not be reached.', code: 'upstream-unreachable'},
      {
        errorName: errorName(error),
        errorMessage: sanitizeText(error instanceof Error ? error.message : error, redactions),
      },
      'error',
    );
  }

  let bodyText: string;
  try {
    bodyText = await upstream.text();
  } catch (error) {
    return jsonResponse(
      502,
      {error: 'The account service response could not be read.', code: 'upstream-unreachable'},
      {
        upstreamStatus: upstream.status,
        errorName: errorName(error),
        errorMessage: sanitizeText(error instanceof Error ? error.message : error, redactions),
      },
      'error',
    );
  }

  const contentType = upstream.headers.get('content-type');
  let parsedBody: unknown;
  let validJson = false;
  try {
    parsedBody = JSON.parse(bodyText);
    validJson = jsonContentType(contentType);
  } catch {
    validJson = false;
  }
  const validError =
    upstream.ok ||
    Boolean(
      parsedBody &&
        typeof parsedBody === 'object' &&
        !Array.isArray(parsedBody) &&
        typeof (parsedBody as {error?: unknown}).error === 'string' &&
        typeof (parsedBody as {code?: unknown}).code === 'string',
    );
  const edgeError = cloudflareErrorCode(bodyText);

  // Every route in docs/BETA.md answers JSON. In particular, do not pass a Cloudflare 1xxx page
  // through with an upstream 403: it did not come from the account service and is not a beta refusal.
  if (!validJson || !validError) {
    return jsonResponse(
      502,
      {error: 'The account service returned an invalid response.', code: 'upstream-invalid-response'},
      {
        upstreamStatus: upstream.status,
        upstreamContentType: sanitizeText(contentType ?? '', redactions, 120),
        upstreamBody: sanitizeBody(bodyText, redactions),
        ...(edgeError ? {cloudflareErrorCode: edgeError} : {}),
      },
      'error',
    );
  }

  const diagnostics: Diagnostics = {
    upstreamStatus: upstream.status,
    ...(upstream.headers.get('x-request-id')
      ? {upstreamRequestId: sanitizeText(upstream.headers.get('x-request-id'), redactions, 100)}
      : {}),
    ...(!upstream.ok ? {upstreamBody: sanitizeBody(bodyText, redactions)} : {}),
  };

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('server');
  // The body was decoded and may be changed by stripInvite; an upstream byte length is not valid.
  responseHeaders.delete('content-length');
  responseHeaders.set('cache-control', 'no-store');
  responseHeaders.set('x-scout-request-id', requestId);
  if (route.startsWith('/applications/') && request.method === 'POST') {
    bodyText = stripInvite(bodyText);
  }
  log(upstream.status, diagnostics, upstream.status >= 500 ? 'error' : 'log');
  return new Response(bodyText, {status: upstream.status, headers: responseHeaders});
};
