import { describe, it, expect } from 'vitest';
import { createLruCache } from '../lib/snapshot-cache.js';

describe('snapshot LRU cache', () => {
  it('stores and retrieves by key; misses return undefined', () => {
    const cache = createLruCache<number>();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('delete and clear drop entries', () => {
    const cache = createLruCache<number>();
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.get('a')).toBeUndefined();
    cache.clear();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least-recently-used entry past the bound', () => {
    const cache = createLruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch 'a' — now 'b' is least-recently-used
    cache.set('c', 3); // overflow → evict 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('re-setting an existing key refreshes its recency', () => {
    const cache = createLruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // 'a' becomes most-recent
    cache.set('c', 3); // evict 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
  });
});
