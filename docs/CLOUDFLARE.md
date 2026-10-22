# Cloudflare — public website and API edge for SCOUT

The SCOUT public website (`/welcome`, `/apply`, `/login`, `/download`, `/profile`, `/privacy`,
`/admin`) is a static Vite SPA hosted on **Cloudflare Pages** on the free tier:

- Build: `npm run build` (`tsc --noEmit && vite build`) → `dist/`
- HTTPS, custom domains and certificate management are handled by Pages
- Security headers: `public/_headers` (copied into `dist/`)
- SPA fallback: `public/_redirects` → `index.html` for client-side routes
- Account API routes (`/api/beta/*`) are proxied by Pages functions (`functions/`) to the Node.js
  account service server-to-server; secrets never reach the browser

## Why the backend is not on Cloudflare Workers

The broadcast host (`server/index.ts`) and the account service (`server/account-service.ts`) use
`node:sqlite`, `node:fs/promises` and a `ws` WebSocket server, and the host serves the local
broadcast UI (`/app`, `/panel`, `/obs`, `/gsi`, `/ws`). None of that runs on Workers, and none of
it belongs on the public edge: match state, GSI and OBS never leave the venue machine. Per the
migration plan, that backend is **preserved on Node** and documented here rather than rewritten.
The website's account calls reach it through the functions proxy.

## Project layout

- `wrangler.toml` — Pages build configuration (`npm run build` → `dist/`)
- `functions/api/beta/[[path]].ts` — proxies `/api/beta/*` to `SCOUT_ACCOUNT_SERVICE_URL`
- `functions/api/platform/[[path]].ts` — 503 stub (platform features live on the central host)
- `functions/api/surface.ts` — `{surface: "site"}` capability probe
- `functions/api/healthz.ts` — `{ok: true}` liveness check
- `public/_headers` — security headers
- `public/_redirects` — SPA fallback

## Local development (no production credentials)

```sh
# 1. Build the site
npm run build

# 2. Start the account service locally (defaults work; mail can be unconfigured)
PORT=8790 HOST=127.0.0.1 SCOUT_ACCOUNT_BASE_URL=http://127.0.0.1:8790 \
  npx tsx server/account-service.ts

# 3. Run Pages locally with the local account service bound to functions
npx wrangler pages dev \
  -b SCOUT_ACCOUNT_SERVICE_URL=http://127.0.0.1:8790 \
  -b SCOUT_BETA_API_KEY=dev-key-only \
  --ip 0.0.0.0 --port 3000
```

No Cloudflare login, real Resend key or production database is required for local development.
Invitation flows fail visibly (`email-not-configured`) until mail is configured, which is the
correct local behavior.

## Deployment

Connect the GitHub repository to Cloudflare Pages (or deploy with `wrangler pages deploy dist`).
Production and preview environment variables are set in the Cloudflare dashboard (or via
`wrangler secret put`) and are **not** in the repository:

| Secret | Meaning |
|---|---|
| `SCOUT_ACCOUNT_SERVICE_URL` | Origin of the Node.js account service (https) |
| `SCOUT_BETA_API_KEY` | Service key for owner-only `/api/beta/applications*` routes |

Build variables (`VITE_*`) are deliberately unused: nothing server-side is inlined into the client
bundle.

## Health checks

- `GET /api/healthz` — `{ok: true, surface: "site", service: "website"}` for uptime checks
- `GET /api/surface` — `{surface: "site"}` so the SPA knows it is on the website

The Node host and account service expose their own `/healthz` routes with service-specific detail.

## Rollback

Cloudflare Pages keeps every deployment. To roll back:

1. Cloudflare dashboard → the Pages project → Deployments → select the previous deployment →
   "Retry deployment" (instant rollback, no build).
2. Or redeploy a known build: `wrangler pages deploy dist --project-name scout --branch main`
   from the commit you want to restore (`git checkout <previous-commit> && npm run build`).

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
