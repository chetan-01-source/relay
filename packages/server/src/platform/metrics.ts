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
  help: 'Gateway-added latency (excludes upstream time). G3 gate reads this.',
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry],
});

export const requestsTotal = new Counter({
  name: 'relay_requests_total',
  help: 'Requests by tenant/route/provider/status.',
  labelNames: ['org', 'route', 'provider', 'status'] as const,
  registers: [registry],
});
