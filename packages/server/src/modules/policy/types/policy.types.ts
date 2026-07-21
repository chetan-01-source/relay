/**
 * Policy module contracts (Week 2 Day 10). The module enforces rate limits and budgets against
 * Valkey's atomic counters; Postgres stores config only, loaded into identity snapshots.
 */
interface PolicyMessage {
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

export interface PolicyRequest {
  model: string;
  messages: PolicyMessage[];
  max_tokens?: number;
}

export interface PolicyTarget {
  inputUsdPer1k?: number;
  outputUsdPer1k?: number;
}

export interface PolicySnapshot {
  orgId: string;
  keyId: string;
  policy: {
    rateLimit: { rpm: number | null; tpm: number | null } | null;
    budget: { period: 'daily' | 'monthly'; limitUsd: number; hardCutoff: boolean } | null;
  };
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface PolicyDecision {
  headers: Record<string, string>;
  reservation?: BudgetReservation;
}

export interface BudgetReservation {
  orgId: string;
  period: 'daily' | 'monthly';
  key: string;
  reservedMicroUsd: number;
}

export interface PolicyService {
  authorize(
    identity: PolicySnapshot,
    req: PolicyRequest,
    targets: PolicyTarget[],
  ): Promise<PolicyDecision>;
  settle(
    decision: PolicyDecision,
    target: PolicyTarget | undefined,
    usage: UsageTokens | undefined,
  ): Promise<void>;
}
