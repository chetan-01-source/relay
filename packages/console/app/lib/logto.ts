import type { LogtoNextConfig } from '@logto/next';

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
};

export const logtoConfigured = Boolean(process.env.LOGTO_APP_ID && process.env.LOGTO_APP_SECRET);
