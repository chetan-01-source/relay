/**
 * Identity module interfaces (Week 2 Day 6). The identity module is the auth spine of both planes:
 * it resolves a data-plane virtual key OR a control-plane Logto JWT to a tenant context, then hands
 * downstream layers an immutable snapshot. Its public surface is a set of Fastify preHandlers
 * (see middleware/auth.ts), not HTTP routes — app.ts attaches them per route group.
 *
 * Every layer depends on an interface declared here.
 */
import type { VirtualKeyEnvironment } from '../../../platform/crypto.js';
import type { Queryable } from '../../../platform/db.js';

/**
 * The plan-derived layer of an org's entitlements, supplied by the plans module (ADR-0014).
 *
 * Declared HERE, in identity's own vocabulary, and injected by the composition root — identity must
 * not import the plans module, because plans imports identity's route guards and the dependency
 * graph has to stay acyclic (`pnpm dep-check` enforces it). Absent (the offline spec dump, or a
 * deployment with no plan layer) means the snapshot is built exactly as it was before plans existed.
 */
export interface PlanSource {
  forOrg(tx: Queryable, orgId: string): Promise<PlanCeilingsInput>;
}

export interface PlanCeilingsInput {
  planCode: string;
  /** Plan-derived flags, merged UNDER the org's own org_features rows. */
  entitlements: Record<string, number | boolean | null>;
  rpm: number | null;
  tpm: number | null;
  /** Monthly org-wide USD ceiling the plan imposes, or null for unlimited. */
  monthlySpendUsd: number | null;
}

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
  /** Set on a rotated predecessor: the key stops working after this instant. Null = no expiry. */
  graceUntil: string | null;
  /**
   * The org's effective entitlements: the plan's flags with the org's own `org_features` rows layered
   * on top (most specific wins). Already resolved — the hot path reads a plain map and never pays
   * for plan resolution.
   */
  entitlements: Record<string, unknown>;
  /** Which plan produced the ceilings above. Stamped onto every response as `x-relay-plan`. */
  planCode: string | null;
  policy: VirtualKeyPolicy;
}

export interface RateLimitSnapshot {
  rpm: number | null;
  tpm: number | null;
}

export interface BudgetSnapshot {
  /** `app` ceilings bind one application; `org` ceilings bind everything the org sends. */
  scope: 'org' | 'app';
  /** The application this ceiling binds, or null for an org-wide one. Part of the counter key. */
  appId: string | null;
  period: 'daily' | 'monthly';
  limitUsd: number;
  hardCutoff: boolean;
}

export interface VirtualKeyPolicy {
  rateLimit: RateLimitSnapshot | null;
  /**
   * EVERY ceiling that applies to this key — its application's and its org's, for each period that
   * is configured. A request must fit inside all of them, so the policy service reserves against
   * each one rather than picking a single "winning" budget.
   */
  budgets: BudgetSnapshot[];
}

/** Data-access boundary. The ONLY layer that touches the database. */
export interface IdentityRepository {
  /**
   * Look up a key by its public selector, returning the row + the org's entitlements, or null.
   * This is the one read on the data path that must cross the org boundary (a presented key names
   * no org yet), so it runs as a platform admin. Called only on a snapshot miss.
   */
  resolveByKeyId(keyId: string): Promise<{
    row: VirtualKeyRow;
    entitlements: Record<string, unknown>;
    planCode: string | null;
    policy: VirtualKeyPolicy;
  } | null>;

  /**
   * Map a control-plane token's `organization_id` claim (Logto's org id) to our tenant key
   * (organizations.id). Like resolveByKeyId this must cross the org boundary — the claim names no
   * tenant of ours until it is resolved — so it reads as a platform admin. Null when no org matches.
   */
  resolveOrgByLogtoId(logtoOrgId: string): Promise<OrgIdentity | null>;

  /**
   * The role `userId` holds in `orgId`. Returns 'member' when there is no row — see the query's note:
   * absence must degrade to the least privilege, never to admin.
   */
  getOrgMemberRole(orgId: string, userId: string): Promise<OrgRole>;
}

/** What a user may do inside one organization. `admin` adds budget + provider writes. */
export type OrgRole = 'admin' | 'member';

/** An org as the control plane needs it: our tenant key plus the status the preHandler gates on. */
export interface OrgIdentity {
  id: string; // organizations.id — the uuid RLS binds to app.current_org
  status: 'active' | 'suspended';
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
  /**
   * Whether the caller administers the org named by `orgId`. Resolved from org_members by the
   * authJwt preHandler — NOT read from the token, which Logto controls and we do not. Undefined
   * until that lookup runs (it is skipped when the token names no org).
   */
  isOrgAdmin?: boolean;
}
