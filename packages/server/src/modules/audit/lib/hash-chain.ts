/**
 * Audit hash-chain primitives (Week 2 Day 7 · schema 0008). The audit log is append-only and
 * tamper-evident: each row's hash = sha256(prev_hash || canonical_json), so altering any past row
 * breaks every hash after it. `relay audit verify` (Day 12) walks the chain per org.
 *
 * Pure functions only — no IO. The repository composes them inside the append transaction.
 */
import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys are emitted in sorted order at every level, so the
 * same logical event always yields the same string (and therefore the same hash) regardless of
 * insertion order. Arrays keep their order; primitives serialize as normal JSON.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/** sha256(prev_hash || canonical_json). prevHash is null only for the first row in an org's chain. */
export function computeAuditHash(prevHash: Buffer | null, canonicalJson: string): Buffer {
  const hash = createHash('sha256');
  if (prevHash) hash.update(prevHash);
  hash.update(canonicalJson, 'utf8');
  return hash.digest();
}

/** One row as read back for verification. `canonicalJson` is the PARSED jsonb payload (pg returns
 * jsonb as an object, not the original string) — `verifyChain` re-canonicalizes it, which reproduces
 * the exact string that was hashed because `canonicalize` is idempotent. Rows must be seq-ordered. */
export interface AuditChainEntry {
  seq: number;
  canonicalJson: unknown;
  hash: Buffer;
}

/** Result of walking one org's chain: whether it holds, how many rows, and where it first broke. */
export interface ChainVerification {
  valid: boolean;
  count: number;
  brokenAtSeq?: number;
}

/**
 * Re-walk a hash chain and prove it is intact. Each row's hash must equal sha256(previous row's
 * stored hash || canonicalize(this row's payload)); the first row chains from null. Any tampered
 * payload fails at that row, and any tampered hash fails at the NEXT row (its prev no longer matches)
 * — so a single altered row is always caught. `relay audit verify` runs this per org.
 */
export function verifyChain(entries: readonly AuditChainEntry[]): ChainVerification {
  let prevHash: Buffer | null = null;
  for (const entry of entries) {
    const recomputed = computeAuditHash(prevHash, canonicalize(entry.canonicalJson));
    if (!entry.hash.equals(recomputed)) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq };
    }
    prevHash = entry.hash;
  }
  return { valid: true, count: entries.length };
}
