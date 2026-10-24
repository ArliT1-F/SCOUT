// Explicit public deployment entrypoint. The desktop launcher always runs index.js in host mode.
// On Render (or any single-service deployment), starting the website embeds the account service
// in-process on loopback unless an external SCOUT_BETA_API_URL was explicitly provided.
process.env.SCOUT_SURFACE='site';
if(!process.env.SCOUT_BETA_API_URL&&process.env.SCOUT_EMBED_ACCOUNT_SERVICE===undefined){
 process.env.SCOUT_EMBED_ACCOUNT_SERVICE='1';
}
await import('./index.js');
export {};
