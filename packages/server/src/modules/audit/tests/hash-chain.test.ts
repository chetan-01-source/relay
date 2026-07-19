import { describe, it, expect } from 'vitest';
import { canonicalize, computeAuditHash } from '../lib/hash-chain.js';

describe('canonicalize', () => {
  it('sorts object keys at every level so equal events hash equally', () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order (order is meaningful in arrays)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('computeAuditHash', () => {
  it('is a 32-byte sha256 and is deterministic', () => {
    const h1 = computeAuditHash(null, '{"seq":1}');
    const h2 = computeAuditHash(null, '{"seq":1}');
    expect(h1).toHaveLength(32);
    expect(h1.equals(h2)).toBe(true);
  });

  it('chains: changing the previous hash or the payload changes the result', () => {
    const genesis = computeAuditHash(null, '{"seq":1}');
    const next = computeAuditHash(genesis, '{"seq":2}');
    const nextFromTamperedPrev = computeAuditHash(Buffer.alloc(32, 1), '{"seq":2}');
    const nextFromTamperedBody = computeAuditHash(genesis, '{"seq":2,"x":1}');
    expect(next.equals(nextFromTamperedPrev)).toBe(false);
    expect(next.equals(nextFromTamperedBody)).toBe(false);
  });
});
