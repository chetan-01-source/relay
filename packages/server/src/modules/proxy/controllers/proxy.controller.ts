/**
 * Proxy controller (playbook §5) — HTTP boundary ONLY. Parses/validates the request, applies the
 * response-header contract, drives the service, and serializes canonical deltas to OpenAI SSE.
 * Errors are THROWN as RelayError and formatted centrally by the app's errorHandler (app.ts) — the
 * controller never builds an error envelope itself. No business logic, no upstream calls, no DB.
 *
 * Day 11 adds the value layer: an exact-match cache is checked before routing (a hit skips the
 * upstream entirely; rate limits still apply, budget does not), and every request is metered via a
 * non-blocking enqueue AFTER the response is sent, so neither adds hot-path latency.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError, isRelayError } from '@relay/shared';
import { getContext } from '../../../platform/als.js';
import { cacheHits, gatewayOverhead, requestsTotal } from '../../../platform/metrics.js';
import { manifestImages } from '../lib/image-manifest.js';
import {
  type CanonicalRequest,
  type ProxyCacheService,
  type ProxyCachedCompletion,
  type ProxyMeteringService,
  type ProxyPolicyDecision,
  type ProxyPolicyService,
  type ProxyService,
  type ProxyRoutingService,
  type ProxyUsageEvent,
  type RequestTiming,
  type Target,
} from '../types/proxy.types.js';

export interface ProxyControllerDeps {
  service: ProxyService;
  routing: ProxyRoutingService;
  policy: ProxyPolicyService;
  cache: ProxyCacheService;
  metering: ProxyMeteringService;
}

export interface ProxyController {
  chatCompletions(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

/** Minimal identity shape needed to attribute a usage event (satisfied by the virtual-key snapshot). */
interface UsageIdentity {
  orgId: string;
  appId: string;
  virtualKeyId: string;
}

export function createProxyController(deps: ProxyControllerDeps): ProxyController {
  return {
    async chatCompletions(request, reply) {
      const start = process.hrtime.bigint();
      const ctx = getContext();
      const traceId = ctx?.traceId ?? randomUUID();

      const parsed = parseBody(request.body); // body already schema-validated by the route
      const identity = request.identity;
      if (!identity) throw new RelayError('invalid_api_key');

      // Validate + manifest inline images at ingress (Day 12d): reject spoofed/oversized attachments
      // before routing or the upstream. Text-only requests short-circuit with no decode work.
      const manifest = manifestImages(parsed);
      if (!manifest.ok) throw new RelayError('invalid_request', { message: manifest.reason });

      const cacheKey = deps.cache.keyFor(identity.orgId, parsed);
      const labels = { org: identity.orgId, route: parsed.model };
      let decision: ProxyPolicyDecision | undefined;

      try {
        // ── cache hit ── serve without touching a provider; rate limits still apply (empty targets
        // ⇒ no budget reservation), so a cache hit can't be used to bypass rpm/tpm.
        const cached = await deps.cache.get(cacheKey);
        if (cached) {
          const hitDecision = await deps.policy.authorize(identity, parsed, []);
          cacheHits.inc({ result: 'hit-exact' });
          await sendCached(reply, cached, parsed, hitDecision, traceId);
          observeOverhead(start, { upstreamMs: 0 });
          deps.metering.recordUsage(
            usageEvent(identity, parsed, traceId, null, cached.usage, 'ok', latencyMs(start)),
          );
          requestsTotal.inc({ ...labels, provider: 'cache', status: 'ok' });
          return reply;
        }
        cacheHits.inc({ result: 'miss' });

        // ── cache miss ── resolve a real route, enforce policy, call upstream.
        const targets = await deps.routing.selectTargets(identity.orgId, parsed);
        decision = await deps.policy.authorize(identity, parsed, targets);

        reply.header('x-relay-trace-id', traceId);
        reply.header('x-relay-provider', targets[0]?.provider ?? 'unknown');
        reply.header('x-relay-cache', 'miss');
        reply.header('x-relay-modalities', modalitiesOf(parsed));
        for (const [name, value] of Object.entries(decision.headers)) reply.header(name, value);

        const timing: RequestTiming = { upstreamMs: 0 };
        let toCache: ProxyCachedCompletion | undefined;
        if (parsed.stream) {
          toCache = await streamOut(
            reply,
            deps.service,
            parsed,
            targets,
            decision,
            traceId,
            start,
            timing,
          );
        } else {
          const json = await deps.service.complete(parsed, targets, timing);
          setResolvedHeaders(reply, timing);
          await reply.send(json); // observe AFTER the response is fully written (gateway-out counts)
          observeOverhead(start, timing);
          toCache = {
            body: json,
            content: extractContent(json),
            ...(timing.usage ? { usage: timing.usage } : {}),
          };
        }

        await deps.policy.settle(decision, timing.selectedTarget, timing.usage);
        if (toCache) await deps.cache.set(cacheKey, toCache);
        deps.metering.recordUsage(
          usageEvent(
            identity,
            parsed,
            traceId,
            timing.selectedTarget ?? null,
            timing.usage,
            'ok',
            latencyMs(start),
          ),
        );
        requestsTotal.inc({ ...labels, provider: timing.selectedProvider ?? 'none', status: 'ok' });
      } catch (err) {
        if (decision) await deps.policy.settle(decision, undefined, undefined);
        deps.metering.recordUsage(
          usageEvent(
            identity,
            parsed,
            traceId,
            null,
            undefined,
            statusForError(err),
            latencyMs(start),
          ),
        );
        requestsTotal.inc({ ...labels, provider: 'none', status: 'error' });
        throw err; // central errorHandler formats the envelope
      }
      return reply;
    },
  };
}

/** Serve a cached completion — a plain JSON body, or a single-chunk SSE replay when stream=true. */
async function sendCached(
  reply: FastifyReply,
  cached: ProxyCachedCompletion,
  req: CanonicalRequest,
  decision: ProxyPolicyDecision,
  traceId: string,
): Promise<void> {
  if (!req.stream) {
    reply.header('x-relay-trace-id', traceId);
    reply.header('x-relay-provider', 'cache');
    reply.header('x-relay-cache', 'hit-exact');
    reply.header('x-relay-failover', 'false');
    reply.header('x-relay-cost-usd', formatCostUsd(0)); // a cache hit skips the upstream → no cost
    reply.header('x-relay-modalities', modalitiesOf(req));
    for (const [name, value] of Object.entries(decision.headers)) reply.header(name, value);
    await reply.send(cached.body);
    return;
  }
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-relay-trace-id': traceId,
    'x-relay-provider': 'cache',
    'x-relay-cache': 'hit-exact',
    'x-relay-failover': 'false',
    'x-relay-cost-usd': formatCostUsd(0),
    'x-relay-modalities': modalitiesOf(req),
    ...decision.headers,
  });
  const id = `chatcmpl-${traceId}`;
  const created = Math.floor(Date.now() / 1000);
  if (cached.content) {
    await writeChunk(reply, chunk(id, created, req.model, { content: cached.content }, null));
  }
  await writeChunk(reply, chunk(id, created, req.model, {}, 'stop'));
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

/**
 * Stream OpenAI SSE. The upstream fetch happens on the first iterator step, so we await it BEFORE
 * writing headers — a pre-first-token failure therefore throws while headers are still unsent and the
 * central handler can return a proper error status (mid-stream failures just end the stream cleanly).
 * Returns the assembled completion so the caller can cache it (tee-within-cap on the way out).
 */
async function streamOut(
  reply: FastifyReply,
  service: ProxyService,
  req: CanonicalRequest,
  targets: Target[],
  decision: ProxyPolicyDecision,
  traceId: string,
  start: bigint,
  timing: RequestTiming,
): Promise<ProxyCachedCompletion> {
  const iterator = service.stream(req, targets, timing)[Symbol.asyncIterator]();
  let step = await iterator.next(); // upstream errors surface here, pre-header

  // Streaming writes headers atomically here (they cannot be set after the first byte), so the full
  // response-header contract (§4.2) must be assembled in this object — reply.header() does not apply.
  // Note: usage typically arrives in the final SSE chunk, i.e. AFTER these headers are sent, so the
  // streaming x-relay-cost-usd reflects only what is known at header time (often 0.000000); the exact
  // settled cost always lands on the metered usage event and the analytics rollups, not this header.
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-relay-trace-id': traceId,
    'x-relay-provider': timing.selectedProvider ?? targets[0]?.provider ?? 'unknown',
    'x-relay-cache': 'miss',
    'x-relay-failover': timing.failover ? 'true' : 'false',
    'x-relay-cost-usd': formatCostUsd(costForTiming(timing)),
    'x-relay-modalities': modalitiesOf(req),
    ...decision.headers,
  });

  const id = `chatcmpl-${traceId}`;
  const created = Math.floor(Date.now() / 1000);
  let content = ''; // accumulate for the tee → cache

  while (!step.done) {
    const delta = step.value;
    if (delta.text !== undefined) {
      content += delta.text;
      await writeChunk(reply, chunk(id, created, req.model, { content: delta.text }, null));
    }
    if (delta.done) break;
    step = await iterator.next();
  }

  await writeChunk(reply, chunk(id, created, req.model, {}, 'stop'));
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
  observeOverhead(start, timing); // whole stream sent — gateway time excludes the per-chunk provider waits

  const body = assembleBody(id, created, req.model, content, timing.usage);
  return { body, content, ...(timing.usage ? { usage: timing.usage } : {}) };
}

/** One OpenAI chat.completion.chunk envelope. */
function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): unknown {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Reconstruct a non-stream OpenAI chat.completion from an accumulated stream — used to cache it. */
function assembleBody(
  id: string,
  created: number,
  model: string,
  content: string,
  usage: { inputTokens: number; outputTokens: number } | undefined,
): unknown {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        }
      : {}),
  };
}

/** Pull the assistant text out of an OpenAI chat.completion body (for the stream-replay cache field). */
function extractContent(body: unknown): string {
  const b = body as { choices?: { message?: { content?: string } }[] };
  return b.choices?.[0]?.message?.content ?? '';
}

/** Build the usage event. A cache hit has no target → provider "cache", zero cost. */
function usageEvent(
  identity: UsageIdentity,
  req: CanonicalRequest,
  traceId: string,
  target: Target | null,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  status: ProxyUsageEvent['status'],
  latency: number,
): ProxyUsageEvent {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    orgId: identity.orgId,
    appId: identity.appId,
    keyId: identity.virtualKeyId,
    routeId: target?.routeId ?? null,
    requestId: traceId,
    provider: target?.provider ?? 'cache',
    model: target?.model ?? req.model,
    inputTokens,
    outputTokens,
    costUsd: target ? costUsd(target, inputTokens, outputTokens) : 0,
    status,
    latencyMs: latency,
  };
}

/** USD cost from the target's rate-card pricing (already resolved by routing). */
function costUsd(target: Target, inputTokens: number, outputTokens: number): number {
  const input = ((target.inputUsdPer1k ?? 0) * inputTokens) / 1000;
  const output = ((target.outputUsdPer1k ?? 0) * outputTokens) / 1000;
  return input + output;
}

/** Map a thrown error to the usage-event status vocabulary. */
function statusForError(err: unknown): ProxyUsageEvent['status'] {
  if (isRelayError(err)) {
    if (err.code === 'rate_limited') return 'rate_limited';
    if (err.code === 'budget_exceeded') return 'budget_exceeded';
  }
  return 'error';
}

/**
 * Apply the resolved half of the response-header contract (§4.2) for a non-stream response — the
 * fields only known after the upstream call settles: the provider actually used, whether a failover
 * happened, and the metered USD cost. `x-relay-trace-id` / `x-relay-cache` / `x-relay-modalities`
 * were already set pre-call; `x-ratelimit-*` come from the policy decision.
 */
function setResolvedHeaders(reply: FastifyReply, timing: RequestTiming): void {
  if (timing.selectedProvider) reply.header('x-relay-provider', timing.selectedProvider);
  reply.header('x-relay-failover', timing.failover ? 'true' : 'false');
  reply.header('x-relay-cost-usd', formatCostUsd(costForTiming(timing)));
}

/** The settled USD cost of a request — the same rate-card math the usage event records; 0 when no
 * target resolved or usage is unknown (e.g. an error before the upstream returned). */
function costForTiming(timing: RequestTiming): number {
  if (!timing.selectedTarget || !timing.usage) return 0;
  return costUsd(timing.selectedTarget, timing.usage.inputTokens, timing.usage.outputTokens);
}

/** Fixed 6-dp string, matching the `cost_usd numeric(_,6)` column precision. */
function formatCostUsd(cost: number): string {
  return cost.toFixed(6);
}

/** The `x-relay-modalities` value: 'text' is always present; 'image' is added when any message carries
 * an image content part. Recomputed from the request here — routing derives the same set from the
 * model-catalog capabilities but does not surface it back onto the timing. */
function modalitiesOf(req: CanonicalRequest): string {
  const modalities = ['text'];
  const hasImage = req.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'),
  );
  if (hasImage) modalities.push('image');
  return modalities.join(',');
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

function latencyMs(start: bigint): number {
  return Math.round(elapsed(start) * 1000);
}
