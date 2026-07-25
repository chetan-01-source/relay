import type { LogtoNextConfig } from '@logto/next';

// The Relay API resource + the scopes the gateway's requireScope() enforces. These MUST be requested
// at sign-in, or the refresh token can't mint an access token for the resource and getAccessToken()
// fails with "token could not be resolved" — even when the user holds the scopes via a role. Logto
// only grants the subset the user actually has, so requesting the full set is safe for any user.
const RELAY_API_RESOURCE = process.env.RELAY_API_RESOURCE ?? 'https://relay.gateway/api';
const RELAY_SCOPES = [
  'relay:read',
  'relay:write',
  'apps:read',
  'apps:write',
  'providers:read',
  'providers:write',
  'analytics:read',
  'audit:read',
  'platform:admin',
];

/**
 * Logto config for the console (Traditional web app). The redirect URI is `${baseUrl}/callback`,
 * which must match the app's redirect URI in Logto. Values come from packages/console/.env.local
 * (gitignored) — see .env.example. `logtoConfigured` lets the UI render without Logto configured.
 */
export const logtoConfig: LogtoNextConfig = {
  endpoint: process.env.LOGTO_ENDPOINT ?? 'http://localhost:3001',
  appId: process.env.LOGTO_APP_ID ?? '',
  appSecret: process.env.LOGTO_APP_SECRET ?? '',
  baseUrl: process.env.LOGTO_BASE_URL ?? 'http://localhost:3100',
  cookieSecret: process.env.LOGTO_COOKIE_SECRET ?? 'dev-only-cookie-secret-change-me!!',
  cookieSecure: process.env.NODE_ENV === 'production',
  // Request the Relay API resource + its scopes at sign-in so getAccessToken() can mint a scoped token.
  resources: [RELAY_API_RESOURCE],
  scopes: RELAY_SCOPES,
};

export const logtoConfigured = Boolean(process.env.LOGTO_APP_ID && process.env.LOGTO_APP_SECRET);
