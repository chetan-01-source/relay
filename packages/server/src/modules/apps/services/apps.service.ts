/**
 * Apps service (Week 2 Day 8) — the virtual-key lifecycle. Orchestrates crypto (mint), Postgres via
 * withTenant, the audit trail, and snapshot invalidation. No SQL, no HTTP.
 *
 * Three key operations, each tenant-scoped and audited:
 *   issue  — mint a key, store only key_id + PBKDF2 verifier, return the plaintext ONCE
 *   rotate — mint a successor and, in ONE transaction, link the predecessor + set its grace window
 *   revoke — flip the key to revoked immediately
 * Rotate and revoke publish `key.invalidate` so every worker's in-process snapshot reloads ≤1s
 * (a revoked or grace-expired key is then rejected on the data plane with 401).
 */
import { RelayError } from '@relay/shared';
import { mintVirtualKey } from '../../../platform/crypto.js';
import type { Database } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import type { AuditRepository } from '../../audit/index.js';
import { publishKeyInvalidation } from '../../identity/index.js';
import type {
  Application,
  ApplicationRow,
  AppsRepository,
  AppsService,
  CreateAppInput,
  IssuedVirtualKey,
  IssueKeyInput,
  VirtualKey,
  VirtualKeyRow,
} from '../types/apps.types.js';

// Old keys stay valid for this window after a rotation, then expire. Well under the ≤72h cap so a
// leaked-then-rotated key has a bounded blast radius while clients migrate.
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AppsServiceDeps {
  db: Database;
  repo: AppsRepository;
  audit: AuditRepository;
  masterKey: string;
  bus: EventBus | null; // absent for the offline spec dump — invalidation is skipped
}

export function createAppsService(deps: AppsServiceDeps): AppsService {
  const { db, repo, audit, masterKey, bus } = deps;

  // All operations are self-service within the caller's own org (RLS-scoped, not a platform bypass).
  const scope = { isPlatformAdmin: false };

  function createApp(actor: string, orgId: string, input: CreateAppInput): Promise<Application> {
    return db.withTenant(orgId, scope, async (tx) => {
      const app = await repo.createApp(tx, orgId, input);
      await audit.appendWithTx(tx, orgId, { actor, action: 'app.create', target: app.id });
      return toApp(app);
    });
  }

  function listApps(orgId: string): Promise<Application[]> {
    return db.withTenant(orgId, scope, async (tx) => (await repo.listApps(tx)).map(toApp));
  }

  async function getApp(orgId: string, appId: string): Promise<Application | null> {
    const row = await db.withTenant(orgId, scope, (tx) => repo.getApp(tx, appId));
    return row ? toApp(row) : null;
  }

  async function issueKey(
    actor: string,
    orgId: string,
    appId: string,
    input: IssueKeyInput,
  ): Promise<IssuedVirtualKey> {
    const minted = mintVirtualKey(masterKey, input.environment ?? 'live');
    const row = await db.withTenant(orgId, scope, async (tx) => {
      await requireApp(tx, appId);
      const key = await repo.insertKey(tx, {
        orgId,
        appId,
        keyId: minted.keyId,
        verifier: minted.secretVerifier,
        last4: minted.last4,
        name: input.name ?? null,
        environment: input.environment ?? 'live',
      });
      await audit.appendWithTx(tx, orgId, { actor, action: 'key.issue', target: key.id });
      return key;
    });
    return { ...toKey(row), key: minted.plaintext };
  }

  async function listKeys(orgId: string, appId: string): Promise<VirtualKey[]> {
    return db.withTenant(orgId, scope, async (tx) => {
      await requireApp(tx, appId);
      return (await repo.listKeys(tx, appId)).map(toKey);
    });
  }

  async function rotateKey(actor: string, orgId: string, keyId: string): Promise<IssuedVirtualKey> {
    const graceUntil = new Date(Date.now() + ROTATION_GRACE_MS).toISOString();
    let predecessorKeyId: string | null = null;

    const successor = await db.withTenant(orgId, scope, async (tx) => {
      const predecessor = await requireKey(tx, keyId);
      if (predecessor.status !== 'active') {
        throw new RelayError('invalid_request', { message: 'Only an active key can be rotated.' });
      }
      predecessorKeyId = predecessor.key_id;

      // Mint the successor and link the predecessor to it — one transaction, one invariant.
      const minted = mintVirtualKey(masterKey, predecessor.environment);
      const key = await repo.insertKey(tx, {
        orgId,
        appId: predecessor.app_id,
        keyId: minted.keyId,
        verifier: minted.secretVerifier,
        last4: minted.last4,
        name: predecessor.name,
        environment: predecessor.environment,
      });
      await repo.linkSuccessor(tx, predecessor.id, key.id, graceUntil);
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'key.rotate',
        target: predecessor.id,
        data: { successor: key.id, grace_until: graceUntil },
      });
      return { ...toKey(key), key: minted.plaintext };
    });

    // Drop the predecessor's cached snapshot so its new grace window takes effect ≤1s.
    if (bus && predecessorKeyId) await publishKeyInvalidation(bus, predecessorKeyId);
    return successor;
  }

  async function revokeKey(actor: string, orgId: string, keyId: string): Promise<VirtualKey> {
    let revokedKeyId: string | null = null;
    const row = await db.withTenant(orgId, scope, async (tx) => {
      const key = await requireKey(tx, keyId);
      revokedKeyId = key.key_id;
      await repo.revokeKey(tx, keyId);
      await audit.appendWithTx(tx, orgId, { actor, action: 'key.revoke', target: keyId });
      return (await repo.getKey(tx, keyId))!;
    });
    if (bus && revokedKeyId) await publishKeyInvalidation(bus, revokedKeyId);
    return toKey(row);
  }

  /** Load an app in the current tx or 404 — RLS guarantees it belongs to the caller's org. */
  async function requireApp(
    tx: Parameters<AppsRepository['getApp']>[0],
    appId: string,
  ): Promise<ApplicationRow> {
    const app = await repo.getApp(tx, appId);
    if (!app) throw new RelayError('not_found', { message: `Application '${appId}' not found.` });
    return app;
  }

  async function requireKey(
    tx: Parameters<AppsRepository['getKey']>[0],
    keyId: string,
  ): Promise<VirtualKeyRow> {
    const key = await repo.getKey(tx, keyId);
    if (!key) throw new RelayError('not_found', { message: `Virtual key '${keyId}' not found.` });
    return key;
  }

  return { createApp, listApps, getApp, issueKey, listKeys, rotateKey, revokeKey };
}

function toApp(row: ApplicationRow): Application {
  return {
    object: 'application',
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
  };
}

function toKey(row: VirtualKeyRow): VirtualKey {
  return {
    object: 'virtual_key',
    id: row.id,
    app_id: row.app_id,
    key_id: row.key_id,
    name: row.name,
    last4: row.last4,
    environment: row.environment,
    status: row.status,
    successor_id: row.successor_id,
    grace_until: row.grace_until,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}
