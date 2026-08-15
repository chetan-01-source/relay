/**
 * Machine-to-machine control-plane credentials — how a headless service authenticates against the
 * control plane when there is no browser to sign in with.
 *
 * The control plane takes a Logto access token (ADR-0002's second auth plane), and a token is a
 * short-lived thing: Logto issues it with an hour of life. A human gets one by signing in; a cron
 * job, a Terraform provider or a provisioning script has no human, so it holds a long-lived client
 * id/secret and exchanges it for a fresh token whenever the old one is about to expire. That
 * exchange is the OAuth 2.0 client-credentials grant, and this module is the whole of it.
 *
 * The token must be ORGANIZATION-SCOPED. The gateway derives the tenant from the `organization_id`
 * claim (server: modules/identity/services/jwt.ts), and Logto sets that claim only when the grant
 * names an organization the client is a member of. Ask for the API resource alone and you get a
 * perfectly valid token that names no tenant, and every org-scoped route answers 401 — the single
 * most confusing way this can be misconfigured, which is why `organizationId` is required here
 * rather than optional.
 */
import { RelayConnectionError } from './errors.js';
import { stripTrailingSlashes, type TokenSource } from './http.js';

export interface MachineTokenOptions {
  /** Logto's base URL, e.g. `https://auth.example.com` — no trailing `/oidc`. */
  endpoint: string;
  /** The machine-to-machine application's client id. */
  clientId: string;
  /** Its secret. Load from your secret manager; never commit it. */
  clientSecret: string;
  /**
   * The Logto organization id to act as — REQUIRED. Without it the minted token carries no
   * `organization_id` claim and the gateway cannot tell which tenant the caller means.
   */
  organizationId: string;
  /** The Relay API resource indicator. Matches the gateway's `RELAY_LOGTO_JWT_AUDIENCE`. */
  resource?: string;
  /** Scopes to request. Logto grants the subset the client actually holds, so asking wide is safe. */
  scopes?: readonly string[];
  /** Injectable for tests and runtimes with a custom fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_RESOURCE = 'https://relay.gateway/api';

/**
 * The scopes the gateway's `requireScope()` gates check. Requesting the full set is deliberate: an
 * OAuth server only grants what the client has been assigned, so a narrowly-privileged service
 * account asking for everything still receives exactly its own narrow set. Asking for less would
 * mean every caller has to know its own grants in advance.
 */
const DEFAULT_SCOPES = [
  'relay:read',
  'relay:write',
  'apps:read',
  'apps:write',
  'providers:read',
  'providers:write',
  'routes:read',
  'routes:write',
  'budgets:read',
  'budgets:write',
  'notifications:read',
  'notifications:write',
  'analytics:read',
  'audit:read',
] as const;

/**
 * Refresh this many seconds BEFORE the token actually expires. A token that is valid when the
 * request leaves can still be rejected when it arrives — clock skew between your host and Logto,
 * plus flight time. Sixty seconds is the same tolerance the gateway's verifier allows.
 */
const REFRESH_SKEW_SECONDS = 60;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Standard in Node 16+, Bun, Deno, Workers and browsers — looked up off `globalThis` so the type
 * does not depend on a DOM or Node lib being in the consumer's tsconfig. */
function base64(input: string): string {
  const encode = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (typeof encode !== 'function') {
    throw new Error('No global btoa is available to encode the client credentials.');
  }
  return encode(input);
}

/** Thrown when Logto refuses to mint a token. Distinct from a gateway rejection. */
export class RelayTokenError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Logto refused the client-credentials grant: ${status} ${body}`);
    this.name = 'RelayTokenError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A caching client-credentials token source, ready to hand to `relay.admin(...)`.
 *
 * The cache is what makes this usable: without it every control-plane call would pay a round trip
 * to Logto first, doubling the latency of the whole client. Concurrent callers share one in-flight
 * request rather than stampeding Logto with N identical grants — the classic cache-stampede shape,
 * and a provisioning script that fans out over a hundred applications hits it immediately.
 *
 * ```ts
 * const admin = relay.admin(
 *   machineTokenSource({
 *     endpoint: process.env.LOGTO_ENDPOINT!,
 *     clientId: process.env.RELAY_MACHINE_CLIENT_ID!,
 *     clientSecret: process.env.RELAY_MACHINE_CLIENT_SECRET!,
 *     organizationId: process.env.RELAY_ORG_ID!,
 *   }),
 * );
 * await admin.apps.list(); // mints on the first call, reuses it for the next hour
 * ```
 */
export function machineTokenSource(options: MachineTokenOptions): TokenSource {
  // Shared with the transport rather than a local `replace(/\/+$/, '')`: that regex backtracks
  // quadratically on a run of slashes, and `endpoint` is caller-supplied. See http.ts.
  const endpoint = stripTrailingSlashes(options.endpoint);
  const resource = options.resource ?? DEFAULT_RESOURCE;
  const scope = (options.scopes ?? DEFAULT_SCOPES).join(' ');
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error(
      'No global fetch is available. Use Node 18+, or pass a fetch implementation via `fetch`.',
    );
  }

  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    // HTTP Basic, per RFC 6749 §2.3.1 — the secret goes in the header, never the body, so it stays
    // out of any proxy's request-body logging. `btoa` rather than `Buffer`: this package uses no
    // Node built-ins, so it keeps working on Deno, Bun, Workers and the browser.
    const basic = base64(`${options.clientId}:${options.clientSecret}`);

    let response: Response;
    try {
      response = await doFetch(`${endpoint}/oidc/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          organization_id: options.organizationId,
          resource,
          scope,
        }),
      });
    } catch (err) {
      throw new RelayConnectionError(`Could not reach Logto at ${endpoint}.`, err);
    }

    if (!response.ok) throw new RelayTokenError(response.status, await response.text());

    const body = (await response.json()) as TokenResponse;
    const ttlMs = Math.max(0, (body.expires_in - REFRESH_SKEW_SECONDS) * 1000);
    cached = { token: body.access_token, expiresAtMs: Date.now() + ttlMs };
    return body.access_token;
  }

  return async function token(): Promise<string> {
    if (cached && Date.now() < cached.expiresAtMs) return cached.token;
    // A failed mint must not be cached as an in-flight promise forever, or one blip from Logto would
    // wedge the client permanently. Clearing in `finally` lets the next caller try again.
    inFlight ??= mint().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
