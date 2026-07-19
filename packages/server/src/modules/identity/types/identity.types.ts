/**
 * Identity module interfaces (Week 2 Day 6). The identity module is the auth spine of both planes:
 * it resolves a data-plane virtual key OR a control-plane Logto JWT to a tenant context, then hands
 * downstream layers an immutable snapshot. Its public surface is a set of Fastify preHandlers
 * (see middleware/auth.ts), not HTTP routes — app.ts attaches them per route group.
 *
 * Every layer depends on an interface declared here.
 */
import type { VirtualKeyEnvironment } from '../../../platform/crypto.js';

/**
 * A virtual_keys row joined to its organization's status — the raw lookup result BEFORE the
 * presented secret is verified. key_sha256 is the stored PBKDF2 verifier of the secret half.
 */
export interface VirtualKeyRow {
  id: string;
  org_id: string;
  app_id: string;
  key_id: string;
  key_sha256: Buffer;
  environment: VirtualKeyEnvironment;
  status: 'active' | 'revoked';
  grace_until: string | null;
  revoked_at: string | null;
  org_status: 'active' | 'suspended';
}

/**
 * The immutable identity snapshot cached in-process by key_id (ADR snapshot + pub/sub). Holds
 * everything the hot path needs to authorize a request without touching Postgres in steady state.
 * `policy` is reserved for Day 10 (rate limits + budgets); it is an empty object until then.
 */
export interface VirtualKeySnapshot {
  virtualKeyId: string;
  keyId: string;
  orgId: string;
  appId: string;
  environment: VirtualKeyEnvironment;
  orgStatus: 'active' | 'suspended';
  keyStatus: 'active' | 'revoked';
  entitlements: Record<string, unknown>;
  policy: Record<string, unknown>;
}

/** Data-access boundary. The ONLY layer that touches the database. */
export interface IdentityRepository {
  /**
   * Look up a key by its public selector, returning the row + the org's entitlements, or null.
   * This is the one read on the data path that must cross the org boundary (a presented key names
   * no org yet), so it runs as a platform admin. Called only on a snapshot miss.
   */
  resolveByKeyId(
    keyId: string,
  ): Promise<{ row: VirtualKeyRow; entitlements: Record<string, unknown> } | null>;
}

/** Resolves a presented virtual key to a snapshot, backed by an in-process cache + bus invalidation. */
export interface VirtualKeyResolver {
  /**
   * Resolve a presented plaintext key to a snapshot. Returns null ONLY for an unresolvable key
   * (malformed, unknown selector, or a wrong secret) — the caller maps that to 401. A found-and-
   * verified key is returned WITH its status so the caller can distinguish 401 (revoked key) from
   * 403 (suspended org).
   */
  resolve(plaintext: string): Promise<VirtualKeySnapshot | null>;
  /** Drop a cached entry by key_id (local invalidation). */
  invalidate(keyId: string): void;
  /** Wire the Valkey subscriptions (key.invalidate / org.suspend / org.features.updated). */
  start(): Promise<void>;
}

/** Verified Logto JWT claims used by the control plane (/api/*). */
export interface JwtClaims {
  userId: string;
  orgId: string | null;
  scopes: string[];
  isPlatformAdmin: boolean;
}
