// Cloudflare Worker entry for the SCOUT public website (`main` in wrangler.toml).
//
// The site is a static Vite SPA served from `dist/` as Cloudflare static assets. This worker
// runs first for every request (`run_worker_first`): it answers the site's `/api/*` routes by
// dispatching to the same handler modules the Pages functions used (`functions/api/*`), and
// hands everything else to the asset binding, which serves the static files, applies the
// security headers from `public/_headers` and falls back to the SPA shell for client-side
// routes (`not_found_handling = "single-page-application"` in wrangler.toml).
//
// The account API proxy (`/api/beta/*`) forwards to the Node.js account service
// (`server/account-service.ts`) server-to-server; the service URL and owner key are Worker
// secrets and never reach the browser (see docs/CLOUDFLARE.md).

import {onRequestGet as healthz} from './api/healthz';
import {onRequestGet as surface} from './api/surface';
import {onRequest as beta} from './api/beta/[[path]]';
import {onRequest as platform} from './api/platform/[[path]]';

export type Env = {
  SCOUT_ACCOUNT_SERVICE_URL?: string;
  SCOUT_BETA_API_KEY?: string;
  ASSETS: {fetch(request: Request): Promise<Response>};
};

const json = (body: unknown, status: number, headers?: HeadersInit) =>
  Response.json(body, {status, headers});

const head = (response: Response) =>
  new Response(null, {status: response.status, headers: response.headers});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const {pathname} = new URL(request.url);

    // Health/capability probes: GET only (HEAD mirrors GET for uptime checks).
    if (pathname === '/api/healthz' || pathname === '/api/surface') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({error: 'Method not allowed.', code: 'method-not-allowed'}, 405, {
          allow: 'GET, HEAD',
        });
      }
      const response = await (pathname === '/api/healthz' ? healthz() : surface());
      return request.method === 'HEAD' ? head(response) : response;
    }

    // Closed-beta account API, proxied to the Node.js account service.
    if (pathname === '/api/beta' || pathname.startsWith('/api/beta/')) {
      return beta({env, request});
    }

    // Platform desk is served by the central SCOUT host, not this deployment: 503 stub.
    if (pathname === '/api/platform' || pathname.startsWith('/api/platform/')) {
      return platform();
    }

    // Unknown API routes answer JSON, never the SPA shell.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return json({error: 'Not found.', code: 'not-found'}, 404);
    }

    // Static assets and the SPA fallback, with public/_headers applied by the asset router.
    return env.ASSETS.fetch(request);
  },
};
