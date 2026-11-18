// Reference backend proxy for the EchoNova API (Express).
//
// Apps (browsers, Flutter, mobile) call this proxy with their own user credentials. The proxy
// checks the user, applies a quota, adds the EchoNova API key and relays the call. The key stays
// on your server.

export { createProxy } from './app.js';
export { ConfigError, makeSettings, settingsFromEnv } from './config.js';
export { InMemoryJobOwners, InMemoryQuota, demoAuthenticate, parseCookies } from './hooks.js';
export { createLogger } from './log.js';
export { REST_ROUTES, STREAM_ROUTES } from './routes.js';
export { mintStreamToken, verifyStreamToken } from './tokens.js';
