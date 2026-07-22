/**
 * Proxy module interfaces (playbook §4 · §5). All contracts live here so implementations
 * (adapter.ts, proxy.service.ts, proxy.controller.ts) depend on abstractions, not each other.
 * The canonical shape is OpenAI Chat Completions — the gateway's Layer-2 domain type.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

/** An async Fastify preHandler (matches the identity module's authVirtualKey). Lives here — not in
 * index.ts — so routes/ can reference it without a routes ↔ index import cycle. */
export type ProxyPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** OpenAI-style multimodal content parts. Text-only messages stay a plain string. */
export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = TextPart | ImagePart;

export interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export type ProviderName = 'openai' | 'anthropic' | 'openai_compat';

export interface Target {
  provider: ProviderName;
  model: string; // provider-native model id
  baseUrl: string;
  apiKey: string; // plaintext, decrypted in worker memory (skeleton: dummy)
  routeId?: string; // the route that resolved this target — carried onto the usage event
  routeTargetId?: string;
  credentialId?: string;
  breakerKey?: string;
  inputUsdPer1k?: number;
  outputUsdPer1k?: number;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A normalized streaming delta — provider-agnostic (Layer 2). */
export interface CanonicalDelta {
  text?: string;
  done?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** A normalized non-streaming response: the OpenAI-canonical body plus extracted usage (Layer 2). */
export interface CanonicalResponse {
  body: unknown; // OpenAI ChatCompletion object, ready to send to the client
  usage?: { inputTokens: number; outputTokens: number };
}

/** Layer-1 boundary: the ONLY place a provider's native wire format lives. */
export interface ProviderAdapter {
  readonly name: ProviderName;
  translate(req: CanonicalRequest, target: Target): ProviderRequest;
  toDelta(event: SseEvent): CanonicalDelta | null;
  /** Normalize a provider's non-streaming JSON body into an OpenAI-canonical response + usage. */
  toResponse(json: unknown, req: CanonicalRequest): CanonicalResponse;
  countTokens(req: CanonicalRequest): number;
}

/**
 * Mutable per-request accumulator for the total time spent BLOCKED on the external provider
 * (fetch + each upstream body/chunk read). The controller subtracts this from the full in-gateway
 * wall-clock so `relay_gateway_overhead_seconds` measures gateway-only latency (in + out), never the
 * provider call. See the overhead measurement in proxy.controller.ts.
 */
export interface RequestTiming {
  upstreamMs: number;
  failover?: boolean;
  selectedProvider?: ProviderName;
  selectedTarget?: Target;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Business logic surface (no HTTP, no DB). The controller depends on this interface only.
 * `stream` yields canonical deltas; serializing them to OpenAI SSE is the controller's job.
 * Both methods throw `RelayError` (code `upstream_error` / `upstream_unreachable`) on failure and
 * accumulate provider-wait time into `timing.upstreamMs`.
 */
export interface ProxyService {
  complete(req: CanonicalRequest, targets: Target[], timing: RequestTiming): Promise<unknown>;
  stream(
    req: CanonicalRequest,
    targets: Target[],
    timing: RequestTiming,
  ): AsyncIterable<CanonicalDelta>;
}

/** Public routing contract consumed by the proxy module. Implemented by modules/routing. */
export interface ProxyRoutingService {
  selectTargets(orgId: string, req: CanonicalRequest): Promise<Target[]>;
}

/** A cached completion (structural mirror of modules/cache CachedCompletion). */
export interface ProxyCachedCompletion {
  body: unknown; // OpenAI chat.completion JSON — served verbatim on a non-stream hit
  content: string; // assistant text — replayed as one SSE chunk on a stream hit
  usage?: { inputTokens: number; outputTokens: number };
}

/** Public cache contract consumed by the proxy. Implemented by modules/cache (Valkey-backed). */
export interface ProxyCacheService {
  keyFor(orgId: string, req: CanonicalRequest): string;
  get(key: string): Promise<ProxyCachedCompletion | null>;
  set(key: string, value: ProxyCachedCompletion): Promise<void>;
}

/** A metered request (structural mirror of modules/metering UsageEvent). */
export interface ProxyUsageEvent {
  orgId: string;
  appId: string;
  keyId: string | null;
  routeId: string | null;
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: 'ok' | 'error' | 'rate_limited' | 'budget_exceeded';
  latencyMs: number | null;
}

/** Public metering contract consumed by the proxy. `recordUsage` is a non-blocking enqueue. */
export interface ProxyMeteringService {
  recordUsage(event: ProxyUsageEvent): void;
}

export interface ProxyRateLimitSnapshot {
  rpm: number | null;
  tpm: number | null;
}

export interface ProxyBudgetSnapshot {
  period: 'daily' | 'monthly';
  limitUsd: number;
  hardCutoff: boolean;
}

export interface ProxyIdentitySnapshot {
  orgId: string;
  keyId: string;
  policy: {
    rateLimit: ProxyRateLimitSnapshot | null;
    budget: ProxyBudgetSnapshot | null;
  };
}

export interface ProxyPolicyDecision {
  headers: Record<string, string>;
}

/** Public policy contract consumed by the proxy module. Implemented by modules/policy. */
export interface ProxyPolicyService {
  authorize(
    identity: ProxyIdentitySnapshot,
    req: CanonicalRequest,
    targets: Target[],
  ): Promise<ProxyPolicyDecision>;
  settle(
    decision: ProxyPolicyDecision,
    target: Target | undefined,
    usage: { inputTokens: number; outputTokens: number } | undefined,
  ): Promise<void>;
}
