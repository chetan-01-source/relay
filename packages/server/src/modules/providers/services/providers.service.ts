/**
 * Providers service (Week 2 Day 8) — the credential store. Seals the upstream key with envelope
 * crypto on write and returns only metadata; the plaintext and ciphertext never leave here. No SQL,
 * no HTTP. Every mutation is audited.
 */
import { RelayError } from '@relay/shared';
import { sealCredential } from '../../../platform/crypto.js';
import type { Database } from '../../../platform/db.js';
import type { AuditRepository } from '../../audit/index.js';
import type {
  CreateCredentialInput,
  ProviderCredential,
  ProviderCredentialRow,
  ProvidersRepository,
  ProvidersService,
} from '../types/providers.types.js';

export interface ProvidersServiceDeps {
  db: Database;
  repo: ProvidersRepository;
  audit: AuditRepository;
  masterKey: string;
}

export function createProvidersService(deps: ProvidersServiceDeps): ProvidersService {
  const { db, repo, audit, masterKey } = deps;
  const scope = { isPlatformAdmin: false }; // self-service within the caller's own org

  async function createCredential(
    actor: string,
    orgId: string,
    input: CreateCredentialInput,
  ): Promise<ProviderCredential> {
    // openai_compat targets are self-hosted, so the base URL is mandatory (nowhere to send otherwise).
    if (input.provider === 'openai_compat' && !input.baseUrl) {
      throw new RelayError('invalid_request', {
        message: 'base_url is required for the openai_compat provider.',
        param: 'base_url',
      });
    }

    // Seal BEFORE the transaction — the plaintext exists only for this call and is never persisted raw.
    const sealed = sealCredential(masterKey, input.apiKey);
    const last4 = input.apiKey.slice(-4);

    const row = await db.withTenant(orgId, scope, async (tx) => {
      const created = await repo.insert(tx, {
        orgId,
        name: input.name,
        provider: input.provider,
        sealed,
        last4,
        baseUrl: input.baseUrl ?? null,
      });
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'provider.create',
        target: created.id,
        data: { name: input.name, provider: input.provider },
      });
      return created;
    });
    return toApi(row);
  }

  function listCredentials(orgId: string): Promise<ProviderCredential[]> {
    return db.withTenant(orgId, scope, async (tx) => (await repo.list(tx)).map(toApi));
  }

  async function getCredential(orgId: string, id: string): Promise<ProviderCredential | null> {
    const row = await db.withTenant(orgId, scope, (tx) => repo.get(tx, id));
    return row ? toApi(row) : null;
  }

  async function deleteCredential(actor: string, orgId: string, id: string): Promise<void> {
    await db.withTenant(orgId, scope, async (tx) => {
      const removed = await repo.remove(tx, id);
      if (removed === 0) {
        throw new RelayError('not_found', { message: `Credential '${id}' not found.` });
      }
      await audit.appendWithTx(tx, orgId, { actor, action: 'provider.delete', target: id });
    });
  }

  return { createCredential, listCredentials, getCredential, deleteCredential };
}

function toApi(row: ProviderCredentialRow): ProviderCredential {
  return {
    object: 'provider_credential',
    id: row.id,
    name: row.name,
    provider: row.provider,
    last4: row.last4,
    base_url: row.base_url,
    status: row.status,
    health_score: row.health_score,
    created_at: row.created_at,
  };
}
