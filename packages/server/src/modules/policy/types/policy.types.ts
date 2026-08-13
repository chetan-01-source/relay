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

export interface PolicyBudget {
  scope: 'org' | 'app';
  appId: string | null;
  period: 'daily' | 'monthly';
  limitUsd: number;
  hardCutoff: boolean;
}

export interface PolicySnapshot {
  orgId: string;
  keyId: string;
  policy: {
    rateLimit: { rpm: number | null; tpm: number | null } | null;
    /** Every ceiling that binds this key — its application's and its org's, per configured period. */
    budgets: PolicyBudget[];
  };
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface PolicyDecision {
  headers: Record<string, string>;
  /** One reservation per ceiling the request was admitted against; all are settled together. */
  reservations?: BudgetReservation[];
}

export interface BudgetReservation {
  orgId: string;
  period: 'daily' | 'monthly';
  key: string;
  reservedMicroUsd: number;
  /** Seconds the counter should live for — the remaining window, not a fixed span. */
  ttlSeconds: number;
}

/**
 * Reads spend already made in the current period, so a cold counter starts from reality rather than
 * from zero. Without it, creating a budget mid-period grants a free allowance equal to whatever the
 * period had already cost — and a Valkey restart silently does the same.
 */
export interface SpendReader {
  periodSpendMicroUsd(orgId: string, appId: string | null, periodStart: string): Promise<number>;
}

/**
 * Notified when a ceiling rejects a request. The policy service has no transaction to join (this is
 * the data plane), so this is fire-and-forget and must never throw — a notification failing cannot
 * be allowed to change the outcome of the request that triggered it.
 */
export interface BudgetAlertSink {
  /** Spend crossed the warning mark while requests are still being served. */
  budgetThreshold(input: {
    orgId: string;
    scope: 'org' | 'app';
    appId: string | null;
    period: 'daily' | 'monthly';
    window: string;
    limitUsd: number;
    spentMicroUsd: number;
    percent: number;
  }): void;
  budgetExceeded(input: {
    orgId: string;
    scope: 'org' | 'app';
    appId: string | null;
    period: 'daily' | 'monthly';
    window: string;
    limitUsd: number;
    spentMicroUsd: number;
  }): void;
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
