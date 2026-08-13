/**
 * The `x-relay-*` response headers, parsed into a typed object.
 *
 * This is the reason the SDK exists. With a stock OpenAI client these values are reachable only via
 * `withResponse()` and arrive as untyped strings; here they are `res.relay.costUsd: number | null`.
 *
 * Every field degrades to `null` when the header is absent or unparseable. A newer SDK talking to an
 * older gateway must report "unknown", never throw and never invent a zero — a fabricated
 * `costUsd: 0` would quietly corrupt whatever the caller is accumulating.
 */
export interface RelayMetadata {
  /** Upstream provider that actually served the request, or `'cache'` on a hit. */
  provider: string | null;
  /** `true` when the response came from Relay's exact-match cache. */
  cached: boolean;
  /** `true` when the request failed over to a lower-priority target. */
  failover: boolean;
  /** Settled cost in USD. `null` when the gateway did not report one. */
  costUsd: number | null;
  /** Correlation id — the key the console's traffic view and the audit trail use. */
  traceId: string | null;
  /** e.g. `['text']` or `['text', 'image']`. */
  modalities: string[];
  /** Plan the enforced ceilings came from. `null` when the deployment has no plan layer. */
  plan: string | null;
  /** Rate-limit budget remaining, as reported by the gateway. */
  rateLimit: {
    limitRequests: number | null;
    remainingRequests: number | null;
    limitTokens: number | null;
    remainingTokens: number | null;
  };
}

export function parseMetadata(headers: Headers): RelayMetadata {
  return {
    provider: headers.get('x-relay-provider'),
    cached: headers.get('x-relay-cache') === 'hit-exact',
    failover: headers.get('x-relay-failover') === 'true',
    costUsd: num(headers.get('x-relay-cost-usd')),
    traceId: headers.get('x-relay-trace-id'),
    modalities: list(headers.get('x-relay-modalities')),
    plan: headers.get('x-relay-plan'),
    rateLimit: {
      limitRequests: num(headers.get('x-ratelimit-limit-requests')),
      remainingRequests: num(headers.get('x-ratelimit-remaining-requests')),
      limitTokens: num(headers.get('x-ratelimit-limit-tokens')),
      remainingTokens: num(headers.get('x-ratelimit-remaining-tokens')),
    },
  };
}

function num(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function list(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
