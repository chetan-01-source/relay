/**
 * Plans controller — HTTP boundary only. Shapes the envelope and status codes; no business logic,
 * no SQL. The org always comes from the verified token, never from the caller, so one tenant cannot
 * read another's plan by guessing an id — except on the `/platform/` routes, which are guarded by
 * `platform:admin` and name the org explicitly by design.
 *
 * `GET /api/v1/plan` is the payload the console's plan page and the SDK's `admin.plan.get()` both
 * render, which is why it carries provenance and usage rather than bare numbers: a customer asking
 * "why is my limit 600" gets "from plan Pro" or "override" in the same response.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay-ai/shared';
import { LIMIT_KEYS, isCountKey, type LimitKey } from '../lib/limits.js';
import type { PlansService, QuotaUsage, SetSubscriptionInput } from '../types/plans.types.js';

interface OrgParams {
  orgId: string;
}

interface ChangePlanBody {
  plan_code: string;
}

interface SetSubscriptionBody {
  plan_code: string;
  status?: SetSubscriptionInput['status'];
  trial_ends_at?: string | null;
  grace_until?: string | null;
  current_period_end?: string | null;
  overrides?: Record<string, unknown>;
}

export interface PlansController {
  getPlan(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listCatalog(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  changePlan(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getSubscription(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  setSubscription(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createPlansController(service: PlansService): PlansController {
  function orgOf(request: FastifyRequest): string {
    const orgId = request.claims?.orgId;
    if (!orgId) {
      throw new RelayError('invalid_request', {
        message: 'This token is not scoped to an organization.',
      });
    }
    return orgId;
  }

  function actorOf(request: FastifyRequest): string {
    return request.claims?.userId ?? 'system';
  }

  return {
    async getPlan(request, reply) {
      const orgId = orgOf(request);
      const [effective, usage] = await Promise.all([
        service.effectiveFor(orgId),
        service.usageFor(orgId),
      ]);
      return reply.send({
        object: 'plan.effective',
        plan: {
          code: effective.planCode,
          name: effective.planName,
          tier: effective.tier,
        },
        status: effective.status,
        // Distinct from `status`: the row can still say `trialing` while the entitlement has already
        // fallen back. The console needs both to explain the difference.
        lapsed: effective.lapsed,
        trial_ends_at: effective.trialEndsAt,
        current_period_end: effective.currentPeriodEnd,
        limits: toWireLimits(effective.limits, usage),
      });
    },

    async listCatalog(_request, reply) {
      return reply.send({ object: 'list', data: await service.listCatalog() });
    },

    async changePlan(request, reply) {
      const body = request.body as ChangePlanBody;
      const subscription = await service.changePlan(
        actorOf(request),
        orgOf(request),
        body.plan_code,
      );
      return reply.send(subscription);
    },

    async getSubscription(request, reply) {
      const { orgId } = request.params as OrgParams;
      const subscription = await service.getSubscription(orgId);
      if (!subscription) {
        throw new RelayError('not_found', { message: 'That organization has no subscription.' });
      }
      return reply.send(subscription);
    },

    async setSubscription(request, reply) {
      const { orgId } = request.params as OrgParams;
      const body = request.body as SetSubscriptionBody;
      const subscription = await service.setSubscription(actorOf(request), orgId, {
        planCode: body.plan_code,
        ...(body.status ? { status: body.status } : {}),
        ...(body.trial_ends_at !== undefined ? { trialEndsAt: body.trial_ends_at } : {}),
        ...(body.grace_until !== undefined ? { graceUntil: body.grace_until } : {}),
        ...(body.current_period_end !== undefined
          ? { currentPeriodEnd: body.current_period_end }
          : {}),
        ...(body.overrides ? { overrides: sanitizeOverrides(body.overrides) } : {}),
      });
      return reply.send(subscription);
    },
  };
}

/** Keep only declared limit keys off the wire — an unknown key in a PUT is a typo, not a feature. */
function sanitizeOverrides(raw: Record<string, unknown>): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((LIMIT_KEYS as readonly string[]).includes(key)) out[key] = value;
  }
  return out as Record<string, never>;
}

/**
 * Resolved map → wire map. `used` is attached only to countable quotas, and only where the count is
 * meaningful at org scope: `keys.per_app.max` is per application, so reporting an org-wide key count
 * beside it would invite exactly the wrong comparison.
 */
function toWireLimits(
  limits: Record<LimitKey, { value: unknown; source: string }>,
  usage: QuotaUsage,
): Record<string, { value: unknown; source: string; used?: number }> {
  const out: Record<string, { value: unknown; source: string; used?: number }> = {};
  for (const key of LIMIT_KEYS) {
    const resolved = limits[key];
    out[key] = {
      value: resolved.value,
      source: resolved.source,
      ...(isCountKey(key) && key !== 'keys.per_app.max' ? { used: usage[key] } : {}),
    };
  }
  return out;
}
