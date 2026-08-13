/**
 * Cache-key derivation (Week 3 Day 11) — PURE, so it is exhaustively unit-testable. The key must be:
 *   1. tenant-isolated  — the org id is the first segment, so org A can never read org B's entry;
 *   2. app-isolated     — see below;
 *   3. semantic         — identical meaning ⇒ identical key; only fields that change the answer count;
 *   4. format-agnostic  — `stream` is excluded so a stream and non-stream ask share one entry.
 *
 * The application segment is not about privacy — both apps belong to one tenant and the org segment
 * already contains them. It is about CORRECTNESS: since routes can be scoped per application, the
 * same model name may resolve to a different provider and model for each app. A key of (org, prompt)
 * would let app A's completion answer app B's identical prompt, silently returning output from a
 * model B never routes to. Partitioning per app costs hit rate and buys a cache that cannot lie.
 */
import { createHash } from 'node:crypto';
import type { CanonicalRequest } from '../../proxy/index.js';
import type { ContentPart } from '../../proxy/index.js';

/** `c:{org}:{app}:{sha256}` — org first so the key space is partitioned per tenant, then per app. */
export function cacheKeyFor(orgId: string, appId: string | null, req: CanonicalRequest): string {
  const hash = createHash('sha256').update(canonicalRequest(req)).digest('hex');
  return `c:${orgId}:${appId ?? '-'}:${hash}`;
}

/**
 * Stable JSON of only the semantic fields. `stream`, trace ids, and any non-semantic top-level field
 * are deliberately excluded (they do not change the completion). `max_tokens` IS included — it caps
 * the output, so two requests differing only in `max_tokens` are genuinely different answers.
 */
function canonicalRequest(req: CanonicalRequest): string {
  return JSON.stringify({
    model: req.model,
    messages: req.messages.map((m) => ({ role: m.role, content: normalizeContent(m.content) })),
    temperature: bucketTemperature(req.temperature),
    max_tokens: req.max_tokens ?? null,
  });
}

/** Multimodal parts collapse to a compact, stable shape; image URLs are the attachment identity. */
function normalizeContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text' ? { t: part.text } : { i: part.image_url.url },
  );
}

/** Bucket temperature so trivially-close values share a cache slot; undefined ⇒ provider default. */
function bucketTemperature(temperature: number | undefined): number | null {
  if (temperature === undefined) return null;
  return Math.round(temperature * 10) / 10;
}
