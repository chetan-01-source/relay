/**
 * Apps module interfaces (Week 2 Day 8). Org-scoped control plane for applications and their virtual
 * keys — the inbound half of the two-key model. Keys are issued once (plaintext shown once), rotated
 * (successor + grace window), and revoked (immediate). Only the public key_id + a peppered verifier
 * are stored; the plaintext and the verifier NEVER leave the server.
 *
 * Every layer depends on an interface declared here.
 */
import type { Queryable } from '../../../platform/db.js';
import type { VirtualKeyEnvironment } from '../../../platform/crypto.js';

// ── applications ─────────────────────────────────────────────────────────────
export interface ApplicationRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Application {
  object: 'application';
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface CreateAppInput {
  name: string;
  description?: string;
}

// ── virtual keys ─────────────────────────────────────────────────────────────
/** Persistence row. key_sha256 (the verifier) is deliberately NOT selected into API shapes. */
export interface VirtualKeyRow {
  id: string;
  app_id: string;
  key_id: string | null;
  last4: string;
  name: string | null;
  environment: VirtualKeyEnvironment;
  status: 'active' | 'revoked';
  successor_id: string | null;
  grace_until: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** API shape — safe to return. Never carries the secret or its verifier. */
export interface VirtualKey {
  object: 'virtual_key';
  id: string;
  app_id: string;
  key_id: string | null;
  name: string | null;
  last4: string;
  environment: VirtualKeyEnvironment;
  status: 'active' | 'revoked';
  successor_id: string | null;
  grace_until: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** Issue/rotate response — the ONLY time the plaintext key is ever returned. */
export interface IssuedVirtualKey extends VirtualKey {
  /** Full `rk_<env>_<keyId>.<secret>`. Shown once; store it securely — it cannot be recovered. */
  key: string;
}

export interface IssueKeyInput {
  name?: string;
  environment?: VirtualKeyEnvironment;
}

// ── layer boundaries ─────────────────────────────────────────────────────────
export interface AppsRepository {
  createApp(tx: Queryable, orgId: string, input: CreateAppInput): Promise<ApplicationRow>;
  getApp(tx: Queryable, appId: string): Promise<ApplicationRow | null>;
  listApps(tx: Queryable): Promise<ApplicationRow[]>;
  insertKey(
    tx: Queryable,
    key: {
      orgId: string;
      appId: string;
      keyId: string;
      verifier: Buffer;
      last4: string;
      name: string | null;
      environment: VirtualKeyEnvironment;
    },
  ): Promise<VirtualKeyRow>;
  getKey(tx: Queryable, keyId: string): Promise<VirtualKeyRow | null>;
  listKeys(tx: Queryable, appId: string): Promise<VirtualKeyRow[]>;
  revokeKey(tx: Queryable, keyId: string): Promise<void>;
  linkSuccessor(
    tx: Queryable,
    predecessorId: string,
    successorId: string,
    graceUntil: string,
  ): Promise<void>;
}

export interface AppsService {
  createApp(actor: string, orgId: string, input: CreateAppInput): Promise<Application>;
  listApps(orgId: string): Promise<Application[]>;
  getApp(orgId: string, appId: string): Promise<Application | null>;
  issueKey(
    actor: string,
    orgId: string,
    appId: string,
    input: IssueKeyInput,
  ): Promise<IssuedVirtualKey>;
  listKeys(orgId: string, appId: string): Promise<VirtualKey[]>;
  rotateKey(actor: string, orgId: string, keyId: string): Promise<IssuedVirtualKey>;
  revokeKey(actor: string, orgId: string, keyId: string): Promise<VirtualKey>;
}
