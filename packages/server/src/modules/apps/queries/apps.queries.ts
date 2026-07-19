/**
 * Apps SQL — the ONLY file in this module with query text. Every user value is bound as a $-param
 * (never interpolated), so these statements are injection-safe by construction (DEVELOPMENT.md §3.4).
 * key_sha256 (the secret verifier) is written but NEVER selected back — API shapes cannot leak it.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { VirtualKeyEnvironment } from '../../../platform/crypto.js';

const APP_COLUMNS = 'id, org_id, name, description, created_at';
// Deliberately excludes key_sha256 — the verifier never leaves the database.
const KEY_COLUMNS =
  'id, app_id, key_id, last4, name, environment, status, successor_id, grace_until, created_at, revoked_at';

export function insertAppQuery(orgId: string, name: string, description: string | null): SqlQuery {
  return {
    text: `INSERT INTO applications (org_id, name, description) VALUES ($1, $2, $3) RETURNING ${APP_COLUMNS}`,
    values: [orgId, name, description],
  };
}

export function getAppByIdQuery(appId: string): SqlQuery {
  return { text: `SELECT ${APP_COLUMNS} FROM applications WHERE id = $1`, values: [appId] };
}

export function listAppsQuery(): SqlQuery {
  return { text: `SELECT ${APP_COLUMNS} FROM applications ORDER BY created_at DESC`, values: [] };
}

export function insertKeyQuery(input: {
  orgId: string;
  appId: string;
  keyId: string;
  verifier: Buffer;
  last4: string;
  name: string | null;
  environment: VirtualKeyEnvironment;
}): SqlQuery {
  return {
    text: `INSERT INTO virtual_keys (org_id, app_id, key_id, key_sha256, last4, name, environment)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${KEY_COLUMNS}`,
    values: [
      input.orgId,
      input.appId,
      input.keyId,
      input.verifier,
      input.last4,
      input.name,
      input.environment,
    ],
  };
}

export function getKeyByIdQuery(keyId: string): SqlQuery {
  return { text: `SELECT ${KEY_COLUMNS} FROM virtual_keys WHERE id = $1`, values: [keyId] };
}

export function listKeysByAppQuery(appId: string): SqlQuery {
  return {
    text: `SELECT ${KEY_COLUMNS} FROM virtual_keys WHERE app_id = $1 ORDER BY created_at DESC`,
    values: [appId],
  };
}

/** Revoke immediately: status flips and revoked_at is stamped. Idempotent-safe (re-revoke is a no-op). */
export function revokeKeyQuery(keyId: string): SqlQuery {
  return {
    text: `UPDATE virtual_keys SET status = 'revoked', revoked_at = now()
           WHERE id = $1 AND status = 'active'`,
    values: [keyId],
  };
}

/** Rotate step: point the predecessor at its successor and set its grace window. */
export function linkSuccessorQuery(
  predecessorId: string,
  successorId: string,
  graceUntil: string,
): SqlQuery {
  return {
    text: `UPDATE virtual_keys SET successor_id = $2, grace_until = $3 WHERE id = $1`,
    values: [predecessorId, successorId, graceUntil],
  };
}
