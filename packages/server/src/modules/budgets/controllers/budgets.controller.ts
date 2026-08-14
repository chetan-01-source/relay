/**
 * Budgets controller — HTTP boundary only. Shapes the envelope and status codes; no business logic,
 * no SQL. Mirrors the other org-scoped controllers: the org comes from the verified token, never from
 * the caller, so one tenant can't address another's budget by guessing an id.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from 'relay-shared';
import type { BudgetPeriod, BudgetsService } from '../types/budgets.types.js';

interface PeriodParams {
  period: BudgetPeriod;
  /** Present only on the app-scoped routes; absent means the org-wide ceiling. */
  appId?: string;
}

interface SetBudgetBody {
  limit_usd: number;
  hard_cutoff?: boolean;
}

export interface BudgetsController {
  listBudgets(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  setBudget(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  deleteBudget(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createBudgetsController(service: BudgetsService): BudgetsController {
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
    async listBudgets(request, reply) {
      return reply.send({ object: 'list', data: await service.listBudgets(orgOf(request)) });
    },

    async setBudget(request, reply) {
      const { period, appId } = request.params as PeriodParams;
      const body = request.body as SetBudgetBody;
      // One handler serves both routes: the app-scoped path supplies appId, the org-wide one omits
      // it. Keeping them on one code path is what stops the two scopes from drifting apart.
      const budget = await service.setBudget(
        actorOf(request),
        orgOf(request),
        appId ?? null,
        period,
        {
          limitUsd: body.limit_usd,
          // Enforcing is the safe default: a budget you have to remember to switch on is not a budget.
          hardCutoff: body.hard_cutoff ?? true,
        },
      );
      return reply.send(budget);
    },

    async deleteBudget(request, reply) {
      const { period, appId } = request.params as PeriodParams;
      await service.deleteBudget(actorOf(request), orgOf(request), appId ?? null, period);
      return reply.code(204).send();
    },
  };
}
