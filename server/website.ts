// Explicit public deployment entrypoint. The desktop launcher always runs index.js in host mode.
process.env.SCOUT_SURFACE='site';
await import('./index.js');
export {};
