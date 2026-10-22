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

## Health checks

- `GET /api/healthz` — `{ok: true, surface: "site", service: "website"}` for uptime checks
- `GET /api/surface` — `{surface: "site"}` so the SPA knows it is on the website

The Node host and account service expose their own `/healthz` routes with service-specific detail.

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
