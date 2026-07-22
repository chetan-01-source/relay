/**
 * Bounded ring queue (Week 3 Day 11) — PURE, unit-tested. The metering write path must NEVER block or
 * grow unbounded on the hot path (non-negotiable: no synchronous Postgres on the request). Producers
 * `enqueue` and return immediately; a background worker `drain`s in batches. When the queue is full we
 * drop the OLDEST item and count the drop — losing the least-recent metering row is preferable to
 * back-pressuring a live request or exhausting memory under a burst.
 */
export class RingQueue<T> {
  private readonly items: T[] = [];
  private droppedCount = 0;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingQueue capacity must be positive');
  }

  /** Append an item. Returns false (and increments `dropped`) if the oldest item had to be evicted. */
  enqueue(item: T): boolean {
    if (this.items.length >= this.capacity) {
      this.items.shift(); // evict oldest
      this.droppedCount += 1;
      this.items.push(item);
      return false;
    }
    this.items.push(item);
    return true;
  }

  /** Remove and return everything currently queued (the worker flushes these as one batch). */
  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
