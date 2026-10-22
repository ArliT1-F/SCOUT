export const onRequestGet = async () => {
  // Health/capability probe for the website deployment. Answers `site` so the SPA knows it is
  // talking to the public website (not a broadcast host) and hides host-only cards.
  return Response.json({surface: 'site', service: 'website'});
};
