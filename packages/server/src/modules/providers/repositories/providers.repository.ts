/**
 * Providers repository (DEVELOPMENT.md §2) — data access only. Runs the parametrized queries against
 * the caller's transaction (a Queryable from withTenant). Contains NO query text and NO business
 * logic; it never selects the sealed columns, so no key material can leak upward.
 */
import {
  insertCredentialQuery,
  getCredentialQuery,
  listCredentialsQuery,
  deleteCredentialQuery,
} from '../queries/providers.queries.js';
import type { ProviderCredentialRow, ProvidersRepository } from '../types/providers.types.js';

export function createProvidersRepository(): ProvidersRepository {
  return {
    async insert(tx, input) {
      const rows = await tx.run<ProviderCredentialRow>(
        insertCredentialQuery({
          orgId: input.orgId,
          name: input.name,
          provider: input.provider,
          ciphertext: input.sealed.ciphertext,
          iv: input.sealed.iv,
          authTag: input.sealed.authTag,
          wrappedDek: input.sealed.wrappedDek,
          last4: input.last4,
          baseUrl: input.baseUrl,
        }),
      );
      return rows[0]!;
    },
    async get(tx, id) {
      const rows = await tx.run<ProviderCredentialRow>(getCredentialQuery(id));
      return rows[0] ?? null;
    },
    list(tx) {
      return tx.run<ProviderCredentialRow>(listCredentialsQuery());
    },
    async remove(tx, id) {
      const rows = await tx.run<{ id: string }>(deleteCredentialQuery(id));
      return rows.length;
    },
  };
}
