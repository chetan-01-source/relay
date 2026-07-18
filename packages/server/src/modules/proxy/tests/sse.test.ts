import { describe, it, expect } from 'vitest';
import { parseSse } from '../lib/sse.js';
import type { SseEvent } from '../types/proxy.types.js';

async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}

async function collect(stream: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('parseSse', () => {
  it('parses data-only events split across arbitrary chunk boundaries', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\n', '\ndata: [DO', 'NE]\n\n')));
    expect(events).toEqual([{ data: '{"a":1}' }, { data: '[DONE]' }]);
  });

  it('captures the event: field for typed (Anthropic) streams', async () => {
    const events = await collect(
      parseSse(bytes('event: message_start\ndata: {"type":"message_start"}\n\n')),
    );
    expect(events[0]).toEqual({ event: 'message_start', data: '{"type":"message_start"}' });
  });

  it('flushes a trailing event with no terminating blank line', async () => {
    const events = await collect(parseSse(bytes('data: tail')));
    expect(events).toEqual([{ data: 'tail' }]);
  });
});
