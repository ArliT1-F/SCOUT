// The platform desk (per-user tournaments, owner settings, public stats) is served by the
// central SCOUT host (`server/index.ts`, `SCOUT_SURFACE=site` or `host`), not by this static
// website deployment. Those routes intentionally 503 here; the SPA degrades gracefully
// (host-only cards stay hidden, public stats stay disabled). The central host is unchanged by
// this migration — see docs/CLOUDFLARE.md and docs/ARCHITECTURE.md.

export const onRequest = async () => {
  return Response.json(
    {
      error: 'Platform features are served by the central SCOUT host, not this website deployment.',
      code: 'unavailable',
    },
    {status: 503},
  );
};
