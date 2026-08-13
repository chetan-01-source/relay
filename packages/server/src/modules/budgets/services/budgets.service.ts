/**
 * Budgets service — the org-scoped spend ceiling the policy module enforces on the hot path.
 *
 * Two things make this more than CRUD:
 *
 * 1. **Invalidation.** The limit is folded into each virtual-key snapshot, which workers cache in
 *    process. A write that only touched Postgres would leave the data plane enforcing the OLD
 *    ceiling until an entry happened to be evicted. Lowering a budget is exactly the case where that
 *    matters, so every mutation publishes on the policy channel and workers drop their snapshots
 *    within ~1s.
 * 2. **Validation.** `limit_usd` is `numeric(12,4)`; a value outside that range, or a non-finite one,
 *    would either raise a driver error or silently round. Both are rejected here with a 400 that says
 *    which parameter was wrong, rather than surfacing as a 500 from the database.
 *
 * No SQL and no HTTP live here. Every mutation is audited inside the same transaction as the write,
 * so the trail cannot disagree with the state.
 */
import { RelayError } from '@relay/shared';
import type { Database } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import type { AuditRepository } from '../../audit/index.js';
import { publishOrgPolicyUpdated } from '../../identity/index.js';
import { dedupeKeyFor, type NotificationEnqueuer } from '../../notifications/index.js';
import type {
  Budget,
  BudgetRow,
  BudgetsRepository,
  BudgetsService,
  SetBudgetInput,
} from '../types/budgets.types.js';

/** numeric(12,4) → 8 integer digits. Anything at or above this cannot be stored. */
const MAX_LIMIT_USD = 99_999_999.9999;

export interface BudgetsServiceDeps {
  db: Database;
  repo: BudgetsRepository;
  audit: AuditRepository;
  bus?: EventBus; // absent offline (the OpenAPI dump) — publishing is then skipped
  notify?: NotificationEnqueuer; // absent ⇒ no notification is produced
}

export function createBudgetsService(deps: BudgetsServiceDeps): BudgetsService {
  const { db, repo, audit, bus, notify } = deps;
  const scope = { isPlatformAdmin: false }; // self-service within the caller's own org

  /** Reject a limit the column cannot hold, before the driver turns it into a 500. */
  function validateLimit(limitUsd: number): void {
    if (!Number.isFinite(limitUsd)) {
      throw new RelayError('invalid_request', {
        message: 'limit_usd must be a finite number.',
        param: 'limit_usd',
      });
    }
    if (limitUsd <= 0) {
      throw new RelayError('invalid_request', {
        message: 'limit_usd must be greater than 0. Remove the budget to stop enforcing a ceiling.',
        param: 'limit_usd',
      });
    }
    if (limitUsd > MAX_LIMIT_USD) {
      throw new RelayError('invalid_request', {
        message: `limit_usd must not exceed ${MAX_LIMIT_USD}.`,
        param: 'limit_usd',
      });
    }
  }

  return {
    async listBudgets(orgId) {
      const rows = await db.withTenant(orgId, scope, (tx) => repo.list(tx, orgId));
      return rows.map(toBudget);
    },

    async setBudget(actor, orgId, appId, period, input: SetBudgetInput) {
      validateLimit(input.limitUsd);

      const row = await db.withTenant(orgId, scope, async (tx) => {
        // Read first so the audit entry can say whether this created or changed a ceiling — "raised
        // the monthly budget from 50 to 500" is the line an operator needs during an incident.
        const previous = await repo.get(tx, orgId, appId, period);
        const saved = await repo.upsert(tx, orgId, appId, period, input);
        // Enqueued in THIS transaction, right next to the audit append: if the write rolls back,
        // no notification can survive it.
        if (notify) {
          await notify.enqueueWithTx(tx, orgId, {
            event: 'budget.updated',
            dedupeKey: dedupeKeyFor('budget.updated'),
            payload: {
              actor,
              scope: appId ? 'an application' : 'organization',
              period,
              limitUsd: input.limitUsd,
              detail: previous
                ? `Limit changed from ${previous.limit_usd} to ${input.limitUsd}.`
                : `Limit set to ${input.limitUsd}.`,
            },
          });
        }
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: previous ? 'budget.update' : 'budget.create',
          target: saved.id,
          data: {
            period,
            app_id: appId,
            scope: appId ? 'app' : 'org',
            limit_usd: input.limitUsd,
            hard_cutoff: input.hardCutoff,
            ...(previous
              ? {
                  previous_limit_usd: Number(previous.limit_usd),
                  previous_hard_cutoff: previous.hard_cutoff,
                }
              : {}),
          },
        });
        return saved;
      });

      await announce(orgId);
      return toBudget(row);
    },

    async deleteBudget(actor, orgId, appId, period) {
      await db.withTenant(orgId, scope, async (tx) => {
        const existing = await repo.get(tx, orgId, appId, period);
        if (!existing) {
          throw new RelayError('not_found', {
            message: appId
              ? `No ${period} budget is set for that application.`
              : `No ${period} budget is set for this organization.`,
          });
        }
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: 'budget.delete',
          target: existing.id,
          data: { period, app_id: appId, limit_usd: Number(existing.limit_usd) },
        });
        await repo.remove(tx, orgId, appId, period);
      });

      await announce(orgId);
    },
  };

  /** Drop every worker's cached snapshot for this org so the new ceiling takes effect at once. */
  async function announce(orgId: string): Promise<void> {
    if (bus) await publishOrgPolicyUpdated(bus, orgId);
  }
}

/** Row → wire shape. `limit_usd` arrives as pg text; the API speaks numbers. */
function toBudget(row: BudgetRow): Budget {
  return {
    object: 'budget',
    id: row.id,
    app_id: row.app_id,
    period: row.period,
    limit_usd: Number(row.limit_usd),
    hard_cutoff: row.hard_cutoff,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
