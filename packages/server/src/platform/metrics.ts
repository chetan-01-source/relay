/**
 * Prometheus metrics (PRD §16.2 headline metrics). collectDefaultMetrics gives us
 * nodejs_eventloop_lag_seconds (the hot-path discipline guardrail); we add the gateway
 * overhead histogram (G3 gate reads this) and the request counter.
 */
import { Registry, collectDefaultMetrics, Histogram, Counter } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const gatewayOverhead = new Histogram({
  name: 'relay_gateway_overhead_seconds',
  help: 'Gateway-only latency: full in-gateway time (request in + response out) minus time awaiting the external provider. The G3 gate reads this.',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry],
});

export const requestsTotal = new Counter({
  name: 'relay_requests_total',
  help: 'Requests by tenant/route/provider/status.',
  labelNames: ['org', 'route', 'provider', 'status'] as const,
  registers: [registry],
});

/**
 * Snapshot invalidation lag (Week 2 Day 6 DoD): seconds from a key/org mutation being published on
 * the Valkey bus to a worker dropping the stale entry from its in-process snapshot. The revocation
 * SLA is ≤1s; this histogram is how we prove it. Observed by the identity module's bus subscriber.
 */
export const snapshotInvalidationLag = new Histogram({
  name: 'relay_snapshot_invalidation_lag',
  help: 'Seconds from a bus invalidation message to the local snapshot entry being dropped (revocation SLA ≤1s).',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const rateLimitRejections = new Counter({
  name: 'relay_rate_limit_rejections_total',
  help: 'Rate-limit rejections by org and limited dimension.',
  labelNames: ['org', 'dimension'] as const,
  registers: [registry],
});

export const budgetRejections = new Counter({
  name: 'relay_budget_rejections_total',
  help: 'Budget hard-cutoff rejections by org.',
  labelNames: ['org'] as const,
  registers: [registry],
});

export const budgetSettles = new Counter({
  name: 'relay_budget_settles_total',
  help: 'Budget settle operations by org.',
  labelNames: ['org'] as const,
  registers: [registry],
});
