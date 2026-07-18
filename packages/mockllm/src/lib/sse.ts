/** SSE writers — send the raw event-stream bytes providers use. */
import type { FastifyReply } from 'fastify';

export function sseHead(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

/** OpenAI-style: `data: {json}\n\n`. */
export function sse(reply: FastifyReply, obj: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** Anthropic-style: `event: <name>\ndata: {json}\n\n`. */
export function sseEvent(reply: FastifyReply, event: string, obj: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}
