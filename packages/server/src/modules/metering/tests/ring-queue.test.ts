import { describe, it, expect } from 'vitest';
import { RingQueue } from '../lib/ring-queue.js';

describe('RingQueue', () => {
  it('enqueues up to capacity and drains everything in order', () => {
    const q = new RingQueue<number>(3);
    expect(q.enqueue(1)).toBe(true);
    expect(q.enqueue(2)).toBe(true);
    expect(q.size).toBe(2);
    expect(q.drain()).toEqual([1, 2]);
    expect(q.size).toBe(0); // drain empties
    expect(q.drain()).toEqual([]);
  });

  it('drops the oldest item and counts the drop when full', () => {
    const q = new RingQueue<number>(2);
    q.enqueue(1);
    q.enqueue(2);
    expect(q.enqueue(3)).toBe(false); // full → evict oldest (1)
    expect(q.dropped).toBe(1);
    expect(q.drain()).toEqual([2, 3]); // newest retained
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingQueue<number>(0)).toThrow();
  });
});
