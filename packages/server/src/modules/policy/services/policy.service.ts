/**
 * Policy service — Valkey-backed hot-path enforcement. Atomic Lua scripts keep all workers aligned
 * for token buckets and budget reserve/settle; if Valkey is absent in offline OpenAPI mode, policy
 * allows the request and emits no headers.
 */
import { RelayError } from '@relay-ai/shared';
import type { Redis } from 'ioredis';
import type { EventBus } from '../../../platform/eventbus.js';
import { budgetSettles, budgetRejections, rateLimitRejections } from '../../../platform/metrics.js';
import { budgetWindow, budgetKey } from '../lib/window.js';
import type {
  BudgetAlertSink,
  BudgetReservation,
  SpendReader,
  PolicyDecision,
  PolicyRequest,
  PolicyService,
  PolicySnapshot,
  PolicyTarget,
  UsageTokens,
} from '../types/policy.types.js';

const WINDOW_MS = 60_000;
const MICRO_USD = 1_000_000;

/**
 * Fraction of a ceiling at which a warning is worth sending. Matches the console's amber threshold
 * (lib/budget.ts) on purpose: the bar turning amber and the email arriving should mean the same
 * thing, or one of them is lying.
 */
const WARN_AT = 0.8;

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

// `seed` is used ONLY when the counter does not exist yet. A cold key must not start at zero: the
// period may already have been spent against (the budget was created mid-period, or Valkey was
// restarted), and starting from zero silently re-grants that whole allowance. EXISTS distinguishes
// "absent" from "legitimately 0", which a plain GET cannot.
const BUDGET_RESERVE_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local reserve = tonumber(ARGV[2])
local hard = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local seed = tonumber(ARGV[5]) or 0
local current
if redis.call('EXISTS', key) == 1 then
  current = tonumber(redis.call('GET', key)) or 0
else
  current = seed
end
local next = current + reserve
if hard == 1 and next > limit then
  -- Persist the seed even on rejection, so the next request does not re-read the database.
  redis.call('SET', key, current, 'EX', ttl)
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
  /** Seeds a cold counter from durable spend. Absent → counters start at zero (tests, offline). */
  spendReader?: SpendReader;
  /** Notified when a ceiling rejects. Absent ⇒ no alert is produced. */
  alerts?: BudgetAlertSink;
}

interface LoadedScripts {
  rateLimit?: string;
  budgetReserve?: string;
  budgetSettle?: string;
}

export function createPolicyService(deps: PolicyServiceDeps = {}): PolicyService {
  const client = deps.bus?.client;
  const spendReader = deps.spendReader;
  const alerts = deps.alerts;
  const scripts: LoadedScripts = {};

  /**
   * What this period has already cost, for a counter that does not exist yet.
   *
   * Only consulted on a cold key — once per scope per period per worker — so the database read stays
   * off the steady-state path. A failure seeds 0 rather than rejecting the request: a budget is a
   * spend control, not an availability control, and failing closed here would take the data plane
   * down whenever Postgres hiccuped.
   */
  async function seedFor(
    orgId: string,
    appId: string | null,
    key: string,
    periodStart: string,
  ): Promise<number> {
    if (!spendReader || !client) return 0;
    try {
      if ((await client.exists(key)) === 1) return 0; // warm — the script ignores the seed anyway
      return await spendReader.periodSpendMicroUsd(orgId, appId, periodStart);
    } catch {
      return 0;
    }
  }

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

    const budgets = identity.policy.budgets;
    if (budgets.length === 0) return { headers };

    const reservedMicroUsd = estimateCostMicroUsd(estimate, targets);
    if (reservedMicroUsd <= 0) return { headers };

    // A request has to fit inside EVERY ceiling that binds it — its application's and its org's, for
    // each configured period. Reserving is not atomic across keys, so a rejection part-way has to
    // hand back what the earlier keys already took; otherwise a blocked request would permanently
    // consume budget it never spent.
    const now = new Date();
    const reservations: BudgetReservation[] = [];

    for (const budget of budgets) {
      const { stamp, ttlSeconds, startsAt } = budgetWindow(budget.period, now);
      const key = budgetKey(identity.orgId, budget.appId, budget.period, stamp);
      const reserve = await reserveBudget(client, scripts, {
        key,
        limitMicroUsd: Math.floor(budget.limitUsd * MICRO_USD),
        reservedMicroUsd,
        hardCutoff: budget.hardCutoff,
        ttlSeconds,
        seedMicroUsd: await seedFor(identity.orgId, budget.appId, key, startsAt),
      });

      if (!reserve.allowed) {
        await release(reservations);
        budgetRejections.inc({ org: identity.orgId });
        // Fire-and-forget. Dedupe lives downstream (one notification per ceiling per period), which
        // is essential here: a tripped budget rejects EVERY request, so this fires constantly.
        alerts?.budgetExceeded({
          orgId: identity.orgId,
          scope: budget.scope,
          appId: budget.appId,
          period: budget.period,
          window: stamp,
          limitUsd: budget.limitUsd,
          spentMicroUsd: reserve.current ?? 0,
        });
        throw new RelayError('budget_exceeded', {
          message:
            budget.scope === 'app'
              ? 'Application budget limit reached.'
              : 'Organization budget limit reached.',
        });
      }

      // Warn on the way up, while requests are still being served. The reserve returns the new
      // running total, so this is measured against the estimate rather than the settled cost —
      // deliberately eager, because a warning that arrives late is worth much less than one that
      // arrives slightly early. Dedupe downstream collapses this to one per ceiling per period.
      if (budget.limitUsd > 0) {
        const limitMicroUsd = Math.floor(budget.limitUsd * MICRO_USD);
        const ratio = limitMicroUsd > 0 ? reserve.current / limitMicroUsd : 0;
        if (ratio >= WARN_AT && ratio < 1) {
          alerts?.budgetThreshold({
            orgId: identity.orgId,
            scope: budget.scope,
            appId: budget.appId,
            period: budget.period,
            window: stamp,
            limitUsd: budget.limitUsd,
            spentMicroUsd: reserve.current,
            percent: Math.round(ratio * 100),
          });
        }
      }

      reservations.push({
        orgId: identity.orgId,
        period: budget.period,
        key,
        reservedMicroUsd,
        ttlSeconds,
      });
    }

    return { headers, reservations };
  }

  /** Hand back reservations taken before a later ceiling rejected the request. */
  async function release(reservations: readonly BudgetReservation[]): Promise<void> {
    if (!client) return;
    for (const reservation of reservations) {
      await settleBudget(client, scripts, {
        key: reservation.key,
        deltaMicroUsd: -reservation.reservedMicroUsd,
        ttlSeconds: reservation.ttlSeconds,
      });
    }
  }

  async function settle(
    decision: PolicyDecision,
    target: PolicyTarget | undefined,
    usage: UsageTokens | undefined,
  ): Promise<void> {
    if (!client || !decision.reservations?.length) return;
    const actual = target && usage ? actualCostMicroUsd(usage, target) : 0;
    // Every ceiling reserved the same estimate, so each is corrected by the same delta.
    for (const reservation of decision.reservations) {
      await settleBudget(client, scripts, {
        key: reservation.key,
        deltaMicroUsd: actual - reservation.reservedMicroUsd,
        ttlSeconds: reservation.ttlSeconds,
      });
    }
    budgetSettles.inc({ org: decision.reservations[0]!.orgId });
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
    seedMicroUsd: number;
  },
): Promise<{ allowed: boolean; current: number }> {
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
    input.seedMicroUsd,
  )) as [number, number];
  // The script returns the counter alongside the verdict: `current` on a rejection (what has
  // already been spent) and the new total on success.
  return { allowed: out[0] === 1, current: out[1] ?? 0 };
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
