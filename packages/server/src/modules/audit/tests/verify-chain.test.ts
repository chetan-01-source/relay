import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  computeAuditHash,
  verifyChain,
  type AuditChainEntry,
} from '../lib/hash-chain.js';

/** Build a valid chain the same way the repository does: hash over the canonicalized payload, each
 * row chaining from the previous row's hash. Returns the entries as verify reads them back (the
 * payload is the PARSED object, mirroring pg's jsonb round-trip). */
function buildChain(payloads: Record<string, unknown>[]): AuditChainEntry[] {
  const entries: AuditChainEntry[] = [];
  let prev: Buffer | null = null;
  payloads.forEach((payload, i) => {
    const seq = i + 1;
    const withSeq = { seq, ...payload };
    const hash = computeAuditHash(prev, canonicalize(withSeq));
    entries.push({ seq, canonicalJson: withSeq, hash });
    prev = hash;
  });
  return entries;
}

describe('verifyChain', () => {
  it('accepts an intact chain', () => {
    const chain = buildChain([
      { action: 'org.create' },
      { action: 'org.suspend' },
      { action: 'key.rotate' },
    ]);
    expect(verifyChain(chain)).toEqual({ valid: true, count: 3 });
  });

  it('accepts an empty chain and a single-row chain', () => {
    expect(verifyChain([])).toEqual({ valid: true, count: 0 });
    expect(verifyChain(buildChain([{ action: 'org.create' }]))).toEqual({ valid: true, count: 1 });
  });

  it('is order-independent of key insertion (canonicalize sorts keys) — jsonb round-trip safe', () => {
    // Simulate pg returning the payload object with a different key order than it was written.
    const chain = buildChain([{ action: 'org.create', target: 't1' }]);
    const reordered: AuditChainEntry = {
      seq: 1,
      canonicalJson: { target: 't1', action: 'org.create', seq: 1 },
      hash: chain[0]!.hash,
    };
    expect(verifyChain([reordered])).toEqual({ valid: true, count: 1 });
  });

  it('detects a tampered payload at that row', () => {
    const chain = buildChain([{ action: 'org.create' }, { action: 'org.suspend' }]);
    chain[1] = { ...chain[1]!, canonicalJson: { seq: 2, action: 'org.UNSUSPEND' } };
    expect(verifyChain(chain)).toEqual({ valid: false, count: 2, brokenAtSeq: 2 });
  });

  it('detects a tampered hash at the NEXT row (its prev no longer matches)', () => {
    const chain = buildChain([{ action: 'a' }, { action: 'b' }, { action: 'c' }]);
    // Corrupt row 1's stored hash. Row 1 itself still hashes from null→its payload? No: its stored
    // hash was replaced, so row 1 fails first.
    chain[0] = { ...chain[0]!, hash: Buffer.alloc(32, 9) };
    expect(verifyChain(chain)).toEqual({ valid: false, count: 3, brokenAtSeq: 1 });
  });

  it('detects a break in the middle even when the row itself is internally consistent', () => {
    // Rebuild row 2 as a self-consistent row but chained from the WRONG prev (genesis instead of row1).
    const chain = buildChain([{ action: 'a' }, { action: 'b' }, { action: 'c' }]);
    const forgedPayload = { seq: 2, action: 'b' };
    chain[1] = {
      seq: 2,
      canonicalJson: forgedPayload,
      hash: computeAuditHash(null, canonicalize(forgedPayload)), // wrong prev → chain broken at row 2
    };
    expect(verifyChain(chain)).toEqual({ valid: false, count: 3, brokenAtSeq: 2 });
  });
});
