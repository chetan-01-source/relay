/** Minimal SSE parser: turns a byte stream into {event,data} records, backpressure-friendly. */
import type { SseEvent } from '../types/proxy.types.js';

export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    // events are separated by a blank line
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseBlock(raw);
      if (ev) yield ev;
    }
  }
  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

function parseBlock(raw: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return event !== undefined
    ? { event, data: dataLines.join('\n') }
    : { data: dataLines.join('\n') };
}
