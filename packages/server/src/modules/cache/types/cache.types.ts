/**
 * Cache module contracts (Week 3 Day 11). An exact-match response cache backed by Valkey. The key is
 * derived from the org + the semantic request fields, so a cached entry is tenant-isolated by
 * construction and a stream vs non-stream ask for identical content share one entry.
 */
import type { CanonicalRequest } from '../../proxy/index.js';

/** What we store per cache entry: enough to serve BOTH a non-stream (body) and a stream (content) hit. */
export interface CachedCompletion {
  /** OpenAI chat.completion JSON — sent verbatim on a non-streaming hit. */
  body: unknown;
  /** Assistant text — replayed as a single SSE content chunk on a streaming hit. */
  content: string;
  /** Token usage captured at settle, so a hit can still be metered (at zero cost). */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CacheService {
  /** Deterministic key for (org, semantic request). Org is embedded → no cross-tenant hit is possible. */
  keyFor(orgId: string, req: CanonicalRequest): string;
  get(key: string): Promise<CachedCompletion | null>;
  set(key: string, value: CachedCompletion): Promise<void>;
}
