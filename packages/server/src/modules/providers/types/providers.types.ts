/**
 * Providers module interfaces (Week 2 Day 8). Org-scoped store for upstream provider credentials —
 * the outbound half of the two-key model. Credentials are AES-256-GCM envelope-encrypted on write
 * and are WRITE-ONLY: the API returns metadata (name, provider, last4, health) but never the
 * ciphertext or the plaintext. Decryption happens only in worker memory at send time (Day 9).
 *
 * Every layer depends on an interface declared here.
 */
import type { Queryable } from '../../../platform/db.js';

export type ProviderName = 'openai' | 'anthropic' | 'openai_compat';
export type CredentialStatus = 'active' | 'disabled';

/** Persistence row. The sealed columns (ciphertext/iv/auth_tag/wrapped_dek) are never selected into
 * an API shape — only the metadata below is. */
export interface ProviderCredentialRow {
  id: string;
  name: string;
  provider: ProviderName;
  last4: string;
  base_url: string | null;
  status: CredentialStatus;
  health_score: number;
  created_at: string;
}

/** API shape — safe to return. Carries no secret material. */
export interface ProviderCredential {
  object: 'provider_credential';
  id: string;
  name: string;
  provider: ProviderName;
  last4: string;
  base_url: string | null;
  status: CredentialStatus;
  health_score: number;
  created_at: string;
}

export interface CreateCredentialInput {
  name: string;
  provider: ProviderName;
  /** The upstream key (e.g. sk-…). Sealed immediately; never stored or returned in the clear. */
  apiKey: string;
  /** Required for openai_compat (vLLM/Ollama/LM Studio); ignored otherwise. */
  baseUrl?: string;
}

export interface ProvidersRepository {
  insert(
    tx: Queryable,
    input: {
      orgId: string;
      name: string;
      provider: ProviderName;
      sealed: { ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedDek: Buffer };
      last4: string;
      baseUrl: string | null;
    },
  ): Promise<ProviderCredentialRow>;
  get(tx: Queryable, id: string): Promise<ProviderCredentialRow | null>;
  list(tx: Queryable): Promise<ProviderCredentialRow[]>;
  remove(tx: Queryable, id: string): Promise<number>;
}

export interface ProvidersService {
  createCredential(
    actor: string,
    orgId: string,
    input: CreateCredentialInput,
  ): Promise<ProviderCredential>;
  listCredentials(orgId: string): Promise<ProviderCredential[]>;
  getCredential(orgId: string, id: string): Promise<ProviderCredential | null>;
  deleteCredential(actor: string, orgId: string, id: string): Promise<void>;
}
