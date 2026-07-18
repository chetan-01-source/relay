/**
 * Proxy controller (playbook §5) — HTTP boundary ONLY. Parses/validates the request, applies the
 * response-header contract, drives the service, and serializes canonical deltas to OpenAI SSE.
 * Errors are THROWN as RelayError and formatted centrally by the app's errorHandler (app.ts) — the
 * controller never builds an error envelope itself. No business logic, no upstream calls, no DB.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import { gatewayOverhead, requestsTotal } from '../../../platform/metrics.js';
import { type CanonicalRequest, type ProxyService, type Target } from '../types/proxy.types.js';

export interface ProxyControllerDeps {
  service: ProxyService;
  upstreamUrl: string;
}

export interface ProxyController {
  chatCompletions(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

const VIRTUAL_KEY_RE = /^Bearer\s+rk_(live|test)_/;

export function createProxyController(deps: ProxyControllerDeps): ProxyController {
  return {
    async chatCompletions(request, reply) {
      const start = process.hrtime.bigint();
      const traceId = randomUUID();

      const auth = request.headers.authorization;
      if (!auth || !VIRTUAL_KEY_RE.test(auth)) {
        throw new RelayError('invalid_api_key', { message: 'Missing or malformed virtual key.' });
      }

      const parsed = parseBody(request.body); // body already schema-validated by the route
      const target: Target = {
        provider: 'openai',
        model: parsed.model,
        baseUrl: deps.upstreamUrl,
        apiKey: 'sk-mock-skeleton', // real credential decrypt lands Day 8
      };

      reply.header('x-relay-trace-id', traceId);
      reply.header('x-relay-provider', target.provider);
      reply.header('x-relay-cache', 'none');

      const labels = { org: '-', route: parsed.model, provider: target.provider };
      try {
        if (parsed.stream) {
          await streamOut(reply, deps.service, parsed, target, traceId, start);
        } else {
          const json = await deps.service.complete(parsed, target);
          gatewayOverhead.observe(elapsed(start));
          await reply.send(json);
        }
        requestsTotal.inc({ ...labels, status: 'ok' });
      } catch (err) {
        requestsTotal.inc({ ...labels, status: 'error' });
        throw err; // central errorHandler formats the envelope
      }
      return reply;
    },
  };
}

/**
 * Stream OpenAI SSE. The upstream fetch happens on the first iterator step, so we await it BEFORE
 * writing headers — a pre-first-token failure therefore throws while headers are still unsent and the
 * central handler can return a proper error status (mid-stream failures just end the stream cleanly).
 */
async function streamOut(
  reply: FastifyReply,
  service: ProxyService,
  req: CanonicalRequest,
  target: Target,
  traceId: string,
  start: bigint,
): Promise<void> {
  const iterator = service.stream(req, target)[Symbol.asyncIterator]();
  let step = await iterator.next(); // upstream errors surface here, pre-header

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-relay-trace-id': traceId,
    'x-relay-provider': target.provider,
  });
  gatewayOverhead.observe(elapsed(start)); // time-to-first-byte

  const id = `chatcmpl-${traceId}`;
  const created = Math.floor(Date.now() / 1000);

  while (!step.done) {
    const delta = step.value;
    if (delta.text !== undefined) {
      await writeChunk(reply, {
        id,
        object: 'chat.completion.chunk',
        created,
        model: req.model,
        choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
      });
    }
    if (delta.done) break;
    step = await iterator.next();
  }

  await writeChunk(reply, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: req.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

function parseBody(raw: unknown): CanonicalRequest {
  const body = raw as Partial<CanonicalRequest> | undefined;
  if (!body?.model || !Array.isArray(body.messages)) {
    throw new RelayError('invalid_request', { message: 'model and messages are required.' });
  }
  return {
    model: body.model,
    messages: body.messages,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  };
}

function writeChunk(reply: FastifyReply, obj: unknown): Promise<void> {
  return new Promise((resolve) => {
    const ok = reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (ok) resolve();
    else reply.raw.once('drain', resolve); // backpressure: never buffer unbounded
  });
}

function elapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
