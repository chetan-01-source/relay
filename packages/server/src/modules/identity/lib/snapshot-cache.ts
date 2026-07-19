/**
 * Tiny dependency-free LRU (Week 2 Day 6 · ADR snapshot). Holds resolved virtual-key snapshots by
 * key_id so a hit is an in-memory Map lookup (≤1µs) and never touches Postgres. A JS Map preserves
 * insertion order, so "least-recently-used" is just: on read, re-insert to move to the back; on
 * overflow, evict the front (oldest). Bounded size caps memory; correctness never depends on a hit.
 */
export interface SnapshotCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

export function createLruCache<V>(max = 10_000): SnapshotCache<V> {
  const map = new Map<string, V>();
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key); // move to most-recently-used position
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > max) {
        const oldest = map.keys().next().value; // front = least-recently-used
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}
