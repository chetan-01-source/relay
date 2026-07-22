/**
 * Cost computation (Week 3 Day 11) — PURE. Mirrors the money math the policy module uses at budget
 * settle (`actualCostMicroUsd`), but returns whole USD for the `usage_events.cost_usd` column. Pricing
 * comes from the route target, which the routing module already joined from `rate_cards` — so we reuse
 * that resolved price rather than re-reading pricing here.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TargetPricing {
  inputUsdPer1k?: number;
  outputUsdPer1k?: number;
}

/** USD cost for one request. Missing pricing (no rate card for the model) costs 0. */
export function computeCostUsd(usage: TokenUsage, pricing: TargetPricing): number {
  const input = ((pricing.inputUsdPer1k ?? 0) * usage.inputTokens) / 1000;
  const output = ((pricing.outputUsdPer1k ?? 0) * usage.outputTokens) / 1000;
  return input + output;
}
