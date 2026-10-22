export const onRequestGet = async () => {
  // Machine-readable liveness for a supervisor or uptime check: no session, no match data,
  // no secrets. The Node host and account service expose their own /healthz routes.
  return Response.json({ok: true, surface: 'site', service: 'website'});
};
