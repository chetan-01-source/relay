/**
 * Cache-key derivation (Week 3 Day 11) — PURE, so it is exhaustively unit-testable. The key must be:
 *   1. tenant-isolated  — the org id is the first segment, so org A can never read org B's entry;
 *   2. semantic         — identical meaning ⇒ identical key; only fields that change the answer count;
 *   3. format-agnostic  — `stream` is excluded so a stream and non-stream ask share one entry.
 */
import { createHash } from 'node:crypto';
import type { CanonicalRequest } from '../../proxy/index.js';
import type { ContentPart } from '../../proxy/index.js';

/** `c:{org}:{sha256}` — org first so the key space is partitioned per tenant. */
export function cacheKeyFor(orgId: string, req: CanonicalRequest): string {
  const hash = createHash('sha256').update(canonicalRequest(req)).digest('hex');
  return `c:${orgId}:${hash}`;
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
