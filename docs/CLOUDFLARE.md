# Cloudflare — public website and API edge for SCOUT

The SCOUT public website (`/welcome`, `/apply`, `/login`, `/download`, `/profile`, `/privacy`,
`/admin`) is a static Vite SPA hosted on **Cloudflare Workers** (static assets) on the free tier:

- Build: `npm run build` (`tsc --noEmit && vite build`) → `dist/`
- Deploy: `npx wrangler deploy` → Worker `scout` (`wrangler.toml`), serving `dist/` as static
  assets with HTTPS, custom domains and certificate management handled by Cloudflare
- Security headers: `public/_headers` (copied into `dist/` by Vite; applied by the asset router)
- SPA fallback: `not_found_handling = "single-page-application"` in `wrangler.toml`, so
  client-side routes (`/apply`, `/login`, …) work after a reload
- API routes (`/api/*`) run through the Worker (`functions/worker.ts`): account API routes
  (`/api/beta/*`) are proxied to the Node.js account service server-to-server; secrets never
  reach the browser

## Why the backend is not on the edge

The broadcast host (`server/index.ts`) and the account service (`server/account-service.ts`) use
`node:sqlite`, `node:fs/promises` and a `ws` WebSocket server, and the host serves the local
broadcast UI (`/app`, `/panel`, `/obs`, `/gsi`, `/ws`). None of that runs on Workers, and none of
it belongs on the public edge: match state, GSI and OBS never leave the venue machine. Per the
migration plan, that backend is **preserved on Node** and documented here rather than rewritten.
The website's account calls reach it through the worker's proxy.

## Project layout

- `wrangler.toml` — Worker `scout`: `npm run build` → `dist/` served as static assets, SPA
  fallback, `/api/*` routed to the worker first
- `functions/worker.ts` — request router: `/api/*` to the handlers below, everything else to
  the static assets
- `functions/api/beta/[[path]].ts` — proxies `/api/beta/*` to `SCOUT_ACCOUNT_SERVICE_URL`
- `functions/api/platform/[[path]].ts` — 503 stub (platform features live on the central host)
- `functions/api/surface.ts` — `{surface: "site"}` capability probe
- `functions/api/healthz.ts` — `{ok: true}` liveness check
- `public/_headers` — security headers
- `wrangler.toml` `not_found_handling` — SPA fallback (replaces the Pages-style `_redirects`
  rule, which Workers reject as an infinite redirect loop)

## Local development (no production credentials)

```sh
# 1. Build the site
npm run build

# 2. Start the account service locally (defaults work; mail can be unconfigured)
PORT=8790 HOST=127.0.0.1 SCOUT_ACCOUNT_BASE_URL=http://127.0.0.1:8790 \
  npx tsx server/account-service.ts

# 3. Put the dev secrets in .dev.vars (gitignored)
cat > .dev.vars <<'EOF'
SCOUT_ACCOUNT_SERVICE_URL=http://127.0.0.1:8790
SCOUT_BETA_API_KEY=dev-key-only
EOF

# 4. Run the Worker and the site locally
npx wrangler dev --ip 0.0.0.0 --port 3000
```

No Cloudflare login, real Resend key or production database is required for local development.
Invitation flows fail visibly (`email-not-configured`) until mail is configured, which is the
correct local behavior.

## Deployment

The build pipeline runs `npm run build` and deploys with `npx wrangler deploy` (see
`wrangler.toml`: Worker `scout`, `main = "functions/worker.ts"`, assets from `dist/`). You can
also deploy from a checkout: `npm run build && npx wrangler deploy`. Production secrets are set
once per environment and are **not** in the repository:

| Secret | Meaning |
|---|---|
| `SCOUT_ACCOUNT_SERVICE_URL` | Origin of the Node.js account service (https) |
| `SCOUT_BETA_API_KEY` | Service key for owner-only `/api/beta/applications*` routes |

Set them with `npx wrangler secret put SCOUT_ACCOUNT_SERVICE_URL` (and
`npx wrangler secret put SCOUT_BETA_API_KEY`) against worker `scout`, or in the Cloudflare
dashboard under Workers & Pages → scout → Settings → Variables and Secrets.

Build variables (`VITE_*`) are deliberately unused: nothing server-side is inlined into the client
bundle.

### What the site can do before the account service exists

The Worker deploys fine without `SCOUT_ACCOUNT_SERVICE_URL`, and everything that is not an account
action works: `/welcome`, `/privacy`, the scenes and maps, the download page's release notes. Only
the account plane is missing, because the accounts live in the Node service — the website has no
database of its own:

| Route | Without `SCOUT_ACCOUNT_SERVICE_URL` |
|---|---|
| `/apply` | 503 `service-unavailable`; the form says applications are not connected yet |
| `/login`, password recovery, launcher linking | 503 `service-unavailable`; sign-in says it is not connected yet |
| `/profile` | 503 `service-unavailable` |
| `/download` | page renders; the account-holder parts stay hidden |

So an applicant cannot submit anything until the account service runs somewhere reachable over
HTTPS and its origin is on the Worker. `server/account-service.ts` needs Node (it uses
`node:sqlite`, which Workers does not provide), so the smallest viable shapes are a container/VM
(Fly.io, Railway, Render, a VPS) or the machine that also runs the broadcast host; put TLS in front
of it and keep the SQLite file on a persistent volume. Then set both secrets above and reload
`/apply` — the banner disappears the moment `/api/beta/status` answers 200.

Verifying the wiring locally, without touching production: run the account service on `:8790`, put
the two variables in `.dev.vars`, `npx wrangler dev`, then

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"Test Applicant","email":"tester@example.com","events":"Monthly"}' \
  http://127.0.0.1:8787/api/beta/apply   # → 200 with the application, stored in the service's SQLite
```

## Health checks

- `GET /api/healthz` — `{ok: true, surface: "site", service: "website"}` for uptime checks
- `GET /api/surface` — `{surface: "site"}` so the SPA knows it is on the website

The Node host and account service expose their own `/healthz` routes with service-specific detail.

## Troubleshooting what the logs show

Every 5xx is logged by Cloudflare as `"level": "error"` with `"outcome": "ok"` (the Worker did
answer; the status was a 5xx). Three symptoms account for almost all of the log noise:

| Log line | Cause | Fix |
|---|---|---|
| `TypeError: Cannot read properties of undefined (reading 'fetch')` and a 500 on `/` or any page route | The **deployed version has no static-assets binding**. `functions/worker.ts` hands everything that is not `/api/*` to `env.ASSETS`, which comes from `[assets] binding = "ASSETS"` in `wrangler.toml`. A Worker created or edited outside it — dashboard *Quick edit*, a drag-drop upload, `wrangler deploy` run against a config without `[assets]`, or a Worker that predates the assets block — has no such binding, so `env.ASSETS` is `undefined`. | Deploy from a checkout with `npm ci && npm run build && npx wrangler deploy`. The deploy output must mention the assets upload; afterwards Workers & Pages → scout → Settings → Bindings lists `ASSETS` (Static Assets). The Worker now answers `{"code": "assets-unavailable"}` with an operator hint instead of throwing, so this is unambiguous in the logs. |
| `GET /api/beta/status` → 503 `{"code": "service-unavailable"}` | `SCOUT_ACCOUNT_SERVICE_URL` is not set on the Worker, so the account proxy has nothing to forward to. This is expected until the Node.js account service is deployed; the SPA stays readable and reports "host could not be reached". | Deploy the account service, then `npx wrangler secret put SCOUT_ACCOUNT_SERVICE_URL` (and `SCOUT_BETA_API_KEY` for the owner desk). |
| `GET /api/platform/status` (or any `/api/platform/*`) → 503 `{"code": "unavailable"}` | The platform desk deliberately lives on the central SCOUT host, not this deployment (`functions/api/platform/[[path]].ts`). The SPA polls it once per page load. | Nothing to fix on the website; it is the documented stub. It only disappears when the SPA stops probing for host-only features. |

`wrangler`'s pinned major (`^3.114`) understands everything `wrangler.toml` uses here —
`[assets]` with `binding`, `not_found_handling`, `run_worker_first` and `[observability.logs]` —
so an outdated CLI is not a cause; a version uploaded without the assets config is.

## Rollback

Cloudflare Workers keeps every deployment. To roll back:

1. Cloudflare dashboard → Workers & Pages → scout → Deployments → select the previous deployment
   → Rollback.
2. Or from a checkout: `npx wrangler rollback` (previous deployment) or redeploy a known build:
   `git checkout <previous-commit> && npm run build && npx wrangler deploy`.

Because database writes go to the account service (Node/SQLite or Supabase) and the website is
stateless, rolling back the website never requires a database migration.

## Optional: Cloudflare R2 for desktop release artifacts

SCOUT desktop releases (`SCOUT-Setup-<version>.exe`) are published to GitHub releases by default
(`SCOUT_DOWNLOAD_URL`). R2 is an **optional** alternative for hosting the installer files:

- Create an R2 bucket (e.g. `scout-releases`), public access **off**.
- Upload release artifacts with their `SHA256SUMS.txt`; serve via signed URLs or a Cloudflare
  domain with authentication, never unsigned public artifacts.
- Point `SCOUT_DOWNLOAD_URL` at the R2-hosted file.
- Release metadata (versions, notes, checksums) stays in the release registry
  (`server/operations.ts`, `public/download/`) and the GitHub release — separate from file hosting.

Do not enable automatic production updates or distribute unsigned artifacts as part of this
migration; signing (if desired) happens on the build machine before upload
(`docs/RELEASE.md`, "Trust, signing and SmartScreen").
