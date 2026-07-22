/**
 * Metering module public face (dependency-cruiser: only index.ts is cross-importable). A library
 * module (no HTTP surface): the proxy calls `recordUsage` on the hot path; the composition root starts
 * the flush + rollup workers when serving and stops them on shutdown.
 */
export { createMeteringService, type MeteringServiceDeps } from './services/metering.service.js';
export { createMeteringRepository } from './repositories/metering.repository.js';
export { computeCostUsd, type TargetPricing, type TokenUsage } from './lib/cost.js';
export type { MeteringService, UsageEvent, UsageStatus } from './types/metering.types.js';
