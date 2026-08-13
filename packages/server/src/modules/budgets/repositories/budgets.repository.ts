/**
 * Budgets repository (DEVELOPMENT.md §2) — data access only. Executes the parametrized queries
 * against the caller's tenant transaction; contains NO query text and NO business rules.
 */
import {
  listBudgetsQuery,
  getBudgetQuery,
  upsertBudgetQuery,
  deleteBudgetQuery,
} from '../queries/budgets.queries.js';
import type { BudgetRow, BudgetsRepository } from '../types/budgets.types.js';

export function createBudgetsRepository(): BudgetsRepository {
  return {
    list(tx, orgId) {
      return tx.run<BudgetRow>(listBudgetsQuery(orgId));
    },

    async get(tx, orgId, appId, period) {
      const rows = await tx.run<BudgetRow>(getBudgetQuery(orgId, appId, period));
      return rows[0] ?? null;
    },

    async upsert(tx, orgId, appId, period, input) {
      const rows = await tx.run<BudgetRow>(
        upsertBudgetQuery(orgId, appId, period, input.limitUsd, input.hardCutoff),
      );
      // RETURNING on an upsert always yields exactly one row; a miss here is a broken invariant.
      return rows[0]!;
    },

    async remove(tx, orgId, appId, period) {
      const rows = await tx.run<{ id: string }>(deleteBudgetQuery(orgId, appId, period));
      return rows.length > 0;
    },
  };
}
