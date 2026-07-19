/**
 * Providers SQL — the ONLY file in this module with query text. Every value is bound as a $-param
 * (never interpolated), so these statements are injection-safe by construction (DEVELOPMENT.md §3.4).
 * The sealed columns are written but NEVER selected back — the read column list excludes them, so no
 * ciphertext or key material can leak through an API shape.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { ProviderName } from '../types/providers.types.js';

// Read shape: metadata only. Deliberately omits ciphertext/iv/auth_tag/wrapped_dek.
const READ_COLUMNS = 'id, name, provider, last4, base_url, status, health_score, created_at';

export function insertCredentialQuery(input: {
  orgId: string;
  name: string;
  provider: ProviderName;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  last4: string;
  baseUrl: string | null;
}): SqlQuery {
  return {
    text: `INSERT INTO provider_credentials
             (org_id, name, provider, ciphertext, iv, auth_tag, wrapped_dek, last4, base_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${READ_COLUMNS}`,
    values: [
      input.orgId,
      input.name,
      input.provider,
      input.ciphertext,
      input.iv,
      input.authTag,
      input.wrappedDek,
      input.last4,
      input.baseUrl,
    ],
  };
}

export function getCredentialQuery(id: string): SqlQuery {
  return { text: `SELECT ${READ_COLUMNS} FROM provider_credentials WHERE id = $1`, values: [id] };
}

export function listCredentialsQuery(): SqlQuery {
  return {
    text: `SELECT ${READ_COLUMNS} FROM provider_credentials ORDER BY created_at DESC`,
    values: [],
  };
}

/** Returns the deleted id (empty result = nothing matched → the service raises 404). */
export function deleteCredentialQuery(id: string): SqlQuery {
  return { text: `DELETE FROM provider_credentials WHERE id = $1 RETURNING id`, values: [id] };
}
