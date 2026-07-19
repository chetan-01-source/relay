/**
 * Audit module public face (dependency-cruiser: only index.ts is cross-importable). The audit trail
 * has no HTTP surface yet — it is a library other modules use to record control-plane mutations
 * atomically with the change. The read/verify endpoints + `relay audit verify` CLI land in Day 12.
 *
 * Layering: repository → queries, plus lib/ (the pure hash chain).
 */
export { createAuditRepository } from './repositories/audit.repository.js';
export { canonicalize, computeAuditHash } from './lib/hash-chain.js';
export type { AuditRepository, AuditEventInput, AuditRecord } from './types/audit.types.js';
