/**
 * Adapts the policy service's budget rejections into notifications.
 *
 * This is where the dedupe key is built, and it is the whole reason this adapter exists. A tripped
 * ceiling rejects EVERY subsequent request, so the raw signal fires continuously — hundreds of times
 * a minute under load. Keying on (ceiling, period) collapses that to one notification per period,
 * and mails again next period because the window is part of the key.
 *
 * Fire-and-forget by contract: the policy service calls this synchronously on the hot path and does
 * not await it. Nothing here may throw, and nothing here may slow a request down.
 */
import { dedupeKeyFor } from '../lib/events.js';
import type { BudgetAlertSink } from '../../policy/index.js';
import type { NotificationEnqueuer } from '../types/notifications.types.js';

const MICRO_USD = 1_000_000;

export function createBudgetAlertSink(notify: NotificationEnqueuer): BudgetAlertSink {
  /** Shared shape: both alerts describe the same ceiling, only at different points on the way up. */
  function scopeOf(input: { scope: 'org' | 'app'; appId: string | null }): string {
    return input.scope === 'app' ? (input.appId ?? 'application') : 'organization';
  }

  return {
    budgetThreshold(input) {
      const scope = scopeOf(input);
      void notify
        .enqueueDetached(input.orgId, {
          event: 'budget.threshold',
          // One warning per ceiling per period. Without this, every request past 80% would mail.
          dedupeKey: dedupeKeyFor('budget.threshold', { scope, window: input.window }),
          payload: {
            scope,
            period: input.period,
            limitUsd: input.limitUsd,
            spentUsd: input.spentMicroUsd / MICRO_USD,
            percent: input.percent,
          },
        })
        .catch(() => {
          // see budgetExceeded below — nothing may surface from the request path
        });
    },

    budgetExceeded(input) {
      const scope = scopeOf(input);
      void notify
        .enqueueDetached(input.orgId, {
          event: 'budget.exceeded',
          // One per ceiling per period. Without this the outbox would fill with duplicates faster
          // than the dispatcher could drain it.
          dedupeKey: dedupeKeyFor('budget.exceeded', { scope, window: input.window }),
          payload: {
            scope,
            period: input.period,
            limitUsd: input.limitUsd,
            spentUsd: input.spentMicroUsd / MICRO_USD,
          },
        })
        .catch(() => {
          // enqueueDetached already swallows; this is belt-and-braces so an unhandled rejection can
          // never surface from the request path.
        });
    },
  };
}
