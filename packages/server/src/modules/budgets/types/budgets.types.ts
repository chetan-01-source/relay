/**
 * Budgets module types. A budget is a per-org spend ceiling for a period; the data plane loads it
 * into the virtual-key snapshot (identity) and the policy service enforces it on the hot path with
 * an atomic reserve/settle in Valkey.
 *
 * `(org_id, period)` is UNIQUE, so a period names at most one budget per org — the resource is keyed
 * by period rather than by a synthetic id, which is why writes are an idempotent upsert.
 */
import type { Queryable } from '../../../platform/db.js';

/** The periods the schema's CHECK constraint allows. */
export const BUDGET_PERIODS = ['daily', 'monthly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** A budgets row as stored. `limit_usd` arrives from pg as a string (numeric), never a float. */
export interface BudgetRow {
  id: string;
  org_id: string;
  /** Application this ceiling binds, or null for an org-wide one. */
  app_id: string | null;
  period: BudgetPeriod;
  limit_usd: string;
  hard_cutoff: boolean;
  created_at: string;
  updated_at: string;
}

/** The wire shape. `limit_usd` is a number here — the API speaks JSON, not pg text. */
export interface Budget {
  object: 'budget';
  id: string;
  /** Application this ceiling binds, or null for an org-wide one. */
  app_id: string | null;
  period: BudgetPeriod;
  limit_usd: number;
  hard_cutoff: boolean;
  created_at: string;
  updated_at: string;
}

export interface SetBudgetInput {
  limitUsd: number;
  /** true (default) rejects requests over the ceiling; false only reports, never blocks. */
  hardCutoff: boolean;
}

export interface BudgetsRepository {
  list(tx: Queryable, orgId: string): Promise<BudgetRow[]>;
  get(
    tx: Queryable,
    orgId: string,
    appId: string | null,
    period: BudgetPeriod,
  ): Promise<BudgetRow | null>;
  /** Insert or update a ceiling — the natural key makes this idempotent. */
  upsert(
    tx: Queryable,
    orgId: string,
    appId: string | null,
    period: BudgetPeriod,
    input: SetBudgetInput,
  ): Promise<BudgetRow>;
  /** Remove the ceiling; returns false when there was none (so the caller can 404 honestly). */
  remove(
    tx: Queryable,
    orgId: string,
    appId: string | null,
    period: BudgetPeriod,
  ): Promise<boolean>;
}

export interface BudgetsService {
  listBudgets(orgId: string): Promise<Budget[]>;
  /** `appId` null sets the org-wide ceiling; a value scopes it to that application. */
  setBudget(
    actor: string,
    orgId: string,
    appId: string | null,
    period: BudgetPeriod,
    input: SetBudgetInput,
  ): Promise<Budget>;
  deleteBudget(
    actor: string,
    orgId: string,
    appId: string | null,
    period: BudgetPeriod,
  ): Promise<void>;
}
