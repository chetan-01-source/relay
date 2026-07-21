/**
 * Proxy controller (playbook §5) — HTTP boundary ONLY. Parses/validates the request, applies the
 * response-header contract, drives the service, and serializes canonical deltas to OpenAI SSE.
 * Errors are THROWN as RelayError and formatted centrally by the app's errorHandler (app.ts) — the
 * controller never builds an error envelope itself. No business logic, no upstream calls, no DB.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import { getContext } from '../../../platform/als.js';
import { gatewayOverhead, requestsTotal } from '../../../platform/metrics.js';
import {
  type CanonicalRequest,
  type ProxyPolicyDecision,
  type ProxyPolicyService,
  type ProxyService,
  type ProxyRoutingService,
  type RequestTiming,
} from '../types/proxy.types.js';

export interface ProxyControllerDeps {
  service: ProxyService;
  routing: ProxyRoutingService;
  policy: ProxyPolicyService;
}

export interface ProxyController {
  chatCompletions(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createProxyController(deps: ProxyControllerDeps): ProxyController {
  return {
    async chatCompletions(request, reply) {
      const start = process.hrtime.bigint();
      // Identity + trace are resolved by the authVirtualKey preHandler and bound to the ALS context.
      const ctx = getContext();
      const traceId = ctx?.traceId ?? randomUUID();
      const orgLabel = request.identity?.orgId ?? '-';

      const parsed = parseBody(request.body); // body already schema-validated by the route
      const identity = request.identity;
      if (!identity) throw new RelayError('invalid_api_key');
      const targets = await deps.routing.selectTargets(identity.orgId, parsed);
      const decision = await deps.policy.authorize(identity, parsed, targets);

      reply.header('x-relay-trace-id', traceId);
      reply.header('x-relay-provider', targets[0]?.provider ?? 'unknown');
      reply.header('x-relay-cache', 'none');
      for (const [name, value] of Object.entries(decision.headers)) reply.header(name, value);

      // accumulates time spent BLOCKED on the provider; subtracted so overhead = gateway-only
      const timing: RequestTiming = { upstreamMs: 0 };
      const labels = {
        org: orgLabel,
        route: parsed.model,
        provider: targets[0]?.provider ?? 'none',
      };
      try {
        if (parsed.stream) {
          await streamOut(reply, deps.service, parsed, targets, decision, traceId, start, timing);
        } else {
          const json = await deps.service.complete(parsed, targets, timing);
          setResolvedHeaders(reply, timing);
          await reply.send(json); // observe AFTER the response is fully written (gateway-out counts)
          observeOverhead(start, timing);
        }
        await deps.policy.settle(decision, timing.selectedTarget, timing.usage);
        requestsTotal.inc({ ...labels, status: 'ok' });
      } catch (err) {
        await deps.policy.settle(decision, undefined, undefined);
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
  targets: Parameters<ProxyService['stream']>[1],
  decision: ProxyPolicyDecision,
  traceId: string,
  start: bigint,
  timing: RequestTiming,
): Promise<void> {
  const iterator = service.stream(req, targets, timing)[Symbol.asyncIterator]();
  let step = await iterator.next(); // upstream errors surface here, pre-header

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-relay-trace-id': traceId,
    'x-relay-provider': timing.selectedProvider ?? targets[0]?.provider ?? 'unknown',
    ...(timing.failover ? { 'x-relay-failover': 'true' } : {}),
    ...decision.headers,
  });

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
  observeOverhead(start, timing); // whole stream sent — gateway time excludes the per-chunk provider waits
}

function setResolvedHeaders(reply: FastifyReply, timing: RequestTiming): void {
  if (timing.selectedProvider) reply.header('x-relay-provider', timing.selectedProvider);
  if (timing.failover) reply.header('x-relay-failover', 'true');
}

/** Record gateway-only overhead: full in-gateway wall-clock minus time blocked on the provider. */
function observeOverhead(start: bigint, timing: RequestTiming): void {
  const overheadSeconds = elapsed(start) - timing.upstreamMs / 1000;
  gatewayOverhead.observe(Math.max(0, overheadSeconds)); // guard tiny negative from clock granularity
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
