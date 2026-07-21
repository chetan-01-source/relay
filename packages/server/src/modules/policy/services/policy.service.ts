/**
 * Policy service — Valkey-backed hot-path enforcement. Atomic Lua scripts keep all workers aligned
 * for token buckets and budget reserve/settle; if Valkey is absent in offline OpenAPI mode, policy
 * allows the request and emits no headers.
 */
import { RelayError } from '@relay/shared';
import type { Redis } from 'ioredis';
import type { EventBus } from '../../../platform/eventbus.js';
import { budgetSettles, budgetRejections, rateLimitRejections } from '../../../platform/metrics.js';
import type {
  PolicyDecision,
  PolicyRequest,
  PolicyService,
  PolicySnapshot,
  PolicyTarget,
  UsageTokens,
} from '../types/policy.types.js';

const WINDOW_MS = 60_000;
const MICRO_USD = 1_000_000;

const RATE_LIMIT_SCRIPT = `
local tokens_key = KEYS[1]
local ts_key = KEYS[2]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local ttl = math.ceil(window / 1000) * 2
local tokens = tonumber(redis.call('GET', tokens_key))
if tokens == nil then tokens = capacity end
local ts = tonumber(redis.call('GET', ts_key)) or now
local refill = math.max(0, now - ts) * (capacity / window)
tokens = math.min(capacity, tokens + refill)
if tokens < cost then
  local retry = math.ceil((cost - tokens) / (capacity / window))
  return {0, math.floor(tokens), retry}
end
tokens = tokens - cost
redis.call('SET', tokens_key, tokens, 'EX', ttl)
redis.call('SET', ts_key, now, 'EX', ttl)
return {1, math.floor(tokens), 0}
`;

const BUDGET_RESERVE_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local reserve = tonumber(ARGV[2])
local hard = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local current = tonumber(redis.call('GET', key)) or 0
local next = current + reserve
if hard == 1 and next > limit then
  return {0, current}
end
redis.call('SET', key, next, 'EX', ttl)
return {1, next}
`;

const BUDGET_SETTLE_SCRIPT = `
local key = KEYS[1]
local delta = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', key)) or 0
local next = current + delta
if next < 0 then next = 0 end
redis.call('SET', key, next, 'EX', ttl)
return next
`;

export interface PolicyServiceDeps {
  bus?: EventBus;
}

interface LoadedScripts {
  rateLimit?: string;
  budgetReserve?: string;
  budgetSettle?: string;
}

export function createPolicyService(deps: PolicyServiceDeps = {}): PolicyService {
  const client = deps.bus?.client;
  const scripts: LoadedScripts = {};

  async function authorize(
    identity: PolicySnapshot,
    req: PolicyRequest,
    targets: PolicyTarget[],
  ): Promise<PolicyDecision> {
    if (!client) return { headers: {} };

    const headers: Record<string, string> = {};
    const estimate = estimateTokens(req);
    const rateLimit = identity.policy.rateLimit;
    if (rateLimit?.rpm) {
      const rpm = await takeBucket(client, scripts, {
        key: `b:${identity.orgId}:rpm:${identity.keyId}`,
        capacity: rateLimit.rpm,
        cost: 1,
      });
      headers['x-ratelimit-limit-requests'] = String(rateLimit.rpm);
      headers['x-ratelimit-remaining-requests'] = String(rpm.remaining);
      if (!rpm.allowed) {
        headers['retry-after'] = String(Math.ceil(rpm.retryAfterMs / 1000));
        rateLimitRejections.inc({ org: identity.orgId, dimension: 'rpm' });
        throw new RelayError('rate_limited', { message: 'Request rate limit exceeded.' });
      }
    }
    if (rateLimit?.tpm) {
      const tpm = await takeBucket(client, scripts, {
        key: `b:${identity.orgId}:tpm:${identity.keyId}`,
        capacity: rateLimit.tpm,
        cost: estimate.total,
      });
      headers['x-ratelimit-limit-tokens'] = String(rateLimit.tpm);
      headers['x-ratelimit-remaining-tokens'] = String(tpm.remaining);
      if (!tpm.allowed) {
        headers['retry-after'] = String(Math.ceil(tpm.retryAfterMs / 1000));
        rateLimitRejections.inc({ org: identity.orgId, dimension: 'tpm' });
        throw new RelayError('rate_limited', { message: 'Token rate limit exceeded.' });
      }
    }

    const budget = identity.policy.budget;
    if (!budget) return { headers };

    const reservedMicroUsd = estimateCostMicroUsd(estimate, targets);
    if (reservedMicroUsd <= 0) return { headers };

    const key = `budget:${identity.orgId}:${budget.period}`;
    const reserve = await reserveBudget(client, scripts, {
      key,
      limitMicroUsd: Math.floor(budget.limitUsd * MICRO_USD),
      reservedMicroUsd,
      hardCutoff: budget.hardCutoff,
      ttlSeconds: ttlForPeriod(budget.period),
    });
    if (!reserve.allowed) {
      budgetRejections.inc({ org: identity.orgId });
      throw new RelayError('budget_exceeded', { message: 'Organization budget limit reached.' });
    }

    return {
      headers,
      reservation: { orgId: identity.orgId, period: budget.period, key, reservedMicroUsd },
    };
  }

  async function settle(
    decision: PolicyDecision,
    target: PolicyTarget | undefined,
    usage: UsageTokens | undefined,
  ): Promise<void> {
    if (!client || !decision.reservation) return;
    const actual = target && usage ? actualCostMicroUsd(usage, target) : 0;
    const delta = actual - decision.reservation.reservedMicroUsd;
    await settleBudget(client, scripts, {
      key: decision.reservation.key,
      deltaMicroUsd: delta,
      ttlSeconds: ttlForPeriod(decision.reservation.period),
    });
    budgetSettles.inc({ org: decision.reservation.orgId });
  }

  return { authorize, settle };
}

async function takeBucket(
  client: Redis,
  scripts: LoadedScripts,
  input: { key: string; capacity: number; cost: number },
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  scripts.rateLimit ??= String(await client.script('LOAD', RATE_LIMIT_SCRIPT));
  const script = scripts.rateLimit;
  const out = (await client.evalsha(
    script,
    2,
    `${input.key}:tokens`,
    `${input.key}:ts`,
    Date.now(),
    input.capacity,
    Math.max(1, input.cost),
    WINDOW_MS,
  )) as [number, number, number];
  return { allowed: out[0] === 1, remaining: out[1], retryAfterMs: out[2] };
}

async function reserveBudget(
  client: Redis,
  scripts: LoadedScripts,
  input: {
    key: string;
    limitMicroUsd: number;
    reservedMicroUsd: number;
    hardCutoff: boolean;
    ttlSeconds: number;
  },
): Promise<{ allowed: boolean }> {
  scripts.budgetReserve ??= String(await client.script('LOAD', BUDGET_RESERVE_SCRIPT));
  const script = scripts.budgetReserve;
  const out = (await client.evalsha(
    script,
    1,
    input.key,
    input.limitMicroUsd,
    input.reservedMicroUsd,
    input.hardCutoff ? 1 : 0,
    input.ttlSeconds,
  )) as [number, number];
  return { allowed: out[0] === 1 };
}

async function settleBudget(
  client: Redis,
  scripts: LoadedScripts,
  input: { key: string; deltaMicroUsd: number; ttlSeconds: number },
): Promise<void> {
  scripts.budgetSettle ??= String(await client.script('LOAD', BUDGET_SETTLE_SCRIPT));
  const script = scripts.budgetSettle;
  await client.evalsha(script, 1, input.key, input.deltaMicroUsd, input.ttlSeconds);
}

function estimateTokens(req: PolicyRequest): UsageTokens & { total: number } {
  const inputTokens = Math.ceil(
    req.messages.reduce((sum, message) => sum + contentChars(message.content), 0) / 4,
  );
  const outputTokens = req.max_tokens ?? 0;
  return { inputTokens, outputTokens, total: inputTokens + outputTokens };
}

function contentChars(content: PolicyRequest['messages'][number]['content']): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
}

function estimateCostMicroUsd(usage: UsageTokens, targets: PolicyTarget[]): number {
  return Math.max(0, ...targets.map((target) => actualCostMicroUsd(usage, target)));
}

function actualCostMicroUsd(usage: UsageTokens, target: PolicyTarget): number {
  const input = ((target.inputUsdPer1k ?? 0) * usage.inputTokens * MICRO_USD) / 1000;
  const output = ((target.outputUsdPer1k ?? 0) * usage.outputTokens * MICRO_USD) / 1000;
  return Math.ceil(input + output);
}

function ttlForPeriod(period: 'daily' | 'monthly'): number {
  return period === 'daily' ? 36 * 60 * 60 : 45 * 24 * 60 * 60;
}
