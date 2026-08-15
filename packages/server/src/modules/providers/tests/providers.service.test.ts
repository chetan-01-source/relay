import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { isRelayError } from 'relay-shared';
import { openCredential } from '../../../platform/crypto.js';
import type { Database, Queryable } from '../../../platform/db.js';
import type { AuditEventInput, AuditRepository } from '../../audit/index.js';
import { createProvidersService } from '../services/providers.service.js';
import type { ProviderCredentialRow, ProvidersRepository } from '../types/providers.types.js';

const master = randomBytes(32).toString('base64');

const fakeDb = {
  withTenant: <T>(_o: string, _s: unknown, fn: (tx: Queryable) => Promise<T>) =>
    fn({} as Queryable),
} as unknown as Database;

function fakeRepo() {
  const rows = new Map<string, ProviderCredentialRow>();
  const sealedById = new Map<
    string,
    { ciphertext: Buffer; iv: Buffer; authTag: Buffer; wrappedDek: Buffer }
  >();
  let n = 0;
  const repo: ProvidersRepository = {
    insert(_tx, input) {
      const id = `cred-${++n}`;
      const row: ProviderCredentialRow = {
        id,
        name: input.name,
        provider: input.provider,
        last4: input.last4,
        base_url: input.baseUrl,
        status: 'active',
        health_score: 1,
        created_at: '2026-07-19T00:00:00Z',
      };
      rows.set(id, row);
      sealedById.set(id, input.sealed);
      return Promise.resolve(row);
    },
    get: (_tx, id) => Promise.resolve(rows.get(id) ?? null),
    list: () => Promise.resolve([...rows.values()]),
    remove: (_tx, id) => Promise.resolve(rows.delete(id) ? 1 : 0),
  };
  return { repo, rows, sealedById };
}

function fakeAudit() {
  const events: AuditEventInput[] = [];
  const audit: AuditRepository = {
    appendWithTx: (_tx, orgId, event) => {
      events.push(event);
      return Promise.resolve({
        id: 'a',
        orgId,
        seq: events.length,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        hash: Buffer.alloc(32),
      });
    },
  };
  return { audit, events };
}

function build(repo: ProvidersRepository, audit: AuditRepository, allowPrivateAddresses = true) {
  return createProvidersService({
    db: fakeDb,
    repo,
    audit,
    masterKey: master,
    baseUrlPolicy: { allowPrivateAddresses },
  });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (isRelayError(err)) return err.code;
    throw err;
  }
  throw new Error('expected a RelayError');
}

describe('providers service', () => {
  it('seals the key on write, returns only metadata, and audits it', async () => {
    const { repo, sealedById } = fakeRepo();
    const { audit, events } = fakeAudit();
    const svc = build(repo, audit);

    const created = await svc.createCredential('u', 'org-1', {
      name: 'OpenAI prod',
      provider: 'openai',
      apiKey: 'sk-super-secret-1234',
    });

    // response carries no secret material
    expect(created.last4).toBe('1234');
    expect(JSON.stringify(created)).not.toContain('sk-super-secret');
    // what was stored actually decrypts back to the original plaintext
    expect(openCredential(master, sealedById.get(created.id)!)).toBe('sk-super-secret-1234');
    expect(events.some((e) => e.action === 'provider.create')).toBe(true);
  });

  it('requires base_url for openai_compat (400)', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit);
    expect(
      await codeOf(() =>
        svc.createCredential('u', 'org-1', {
          name: 'local',
          provider: 'openai_compat',
          apiKey: 'x',
        }),
      ),
    ).toBe('invalid_request');
  });

  it('lists/gets metadata only and 404s a missing delete', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit);
    const created = await svc.createCredential('u', 'org-1', {
      name: 'c',
      provider: 'anthropic',
      apiKey: 'ak-abcd',
    });

    const listed = await svc.listCredentials('org-1');
    expect(listed[0]!.object).toBe('provider_credential');
    expect(Object.keys(listed[0]!)).not.toContain('ciphertext');

    await svc.deleteCredential('u', 'org-1', created.id);
    expect(await codeOf(() => svc.deleteCredential('u', 'org-1', created.id))).toBe('not_found');
  });
});

describe('providers service — upstream address safety', () => {
  /**
   * The stored base_url is the address the GATEWAY fetches, so accepting an arbitrary one lets a
   * tenant aim the gateway's own process wherever they like and read the response.
   */
  it('refuses a non-http scheme', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit);

    expect(
      await codeOf(() =>
        svc.createCredential('u', 'org-1', {
          name: 'evil',
          provider: 'openai_compat',
          apiKey: 'k',
          baseUrl: 'file:///etc/passwd',
        }),
      ),
    ).toBe('invalid_request');
  });

  it('refuses the cloud metadata endpoint even on a self-hosted deployment', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit, true); // private addresses allowed, metadata still is not

    expect(
      await codeOf(() =>
        svc.createCredential('u', 'org-1', {
          name: 'imds',
          provider: 'openai_compat',
          apiKey: 'k',
          baseUrl: 'http://169.254.169.254/latest/meta-data',
        }),
      ),
    ).toBe('invalid_request');
  });

  it('refuses a private upstream on a multi-tenant deployment', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit, false);

    expect(
      await codeOf(() =>
        svc.createCredential('u', 'org-1', {
          name: 'internal',
          provider: 'openai_compat',
          apiKey: 'k',
          baseUrl: 'http://10.0.0.5:8000',
        }),
      ),
    ).toBe('invalid_request');
  });

  it('still allows a local upstream when self-hosted — Ollama is a documented setup', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit, true);

    const created = await svc.createCredential('u', 'org-1', {
      name: 'ollama',
      provider: 'openai_compat',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/',
    });

    // Normalized on the way in: the adapters append their own path.
    expect(created.base_url).toBe('http://localhost:11434');
  });

  it('refuses a blank name instead of storing an unidentifiable row', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit);

    expect(
      await codeOf(() =>
        svc.createCredential('u', 'org-1', { name: '   ', provider: 'openai', apiKey: 'sk-x' }),
      ),
    ).toBe('invalid_request');
  });

  it('trims a padded name so the stored value is the one displayed', async () => {
    const { repo } = fakeRepo();
    const { audit } = fakeAudit();
    const svc = build(repo, audit);

    const created = await svc.createCredential('u', 'org-1', {
      name: '  prod-openai  ',
      provider: 'openai',
      apiKey: 'sk-x',
    });

    expect(created.name).toBe('prod-openai');
  });
});
