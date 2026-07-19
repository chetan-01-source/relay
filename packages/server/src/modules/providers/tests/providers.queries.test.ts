import { describe, it, expect } from 'vitest';
import {
  insertCredentialQuery,
  getCredentialQuery,
  listCredentialsQuery,
  deleteCredentialQuery,
} from '../queries/providers.queries.js';

const sealed = {
  orgId: 'org-1',
  name: 'c',
  provider: 'openai' as const,
  ciphertext: Buffer.from('ct'),
  iv: Buffer.from('iv'),
  authTag: Buffer.from('tag'),
  wrappedDek: Buffer.from('dek'),
  last4: 'wxyz',
  baseUrl: null,
};

describe('providers queries', () => {
  it('read shapes NEVER select the sealed columns', () => {
    for (const q of [getCredentialQuery('c1'), listCredentialsQuery()]) {
      for (const secret of ['ciphertext', 'iv', 'auth_tag', 'wrapped_dek']) {
        expect(q.text).not.toContain(secret);
      }
    }
  });

  it('insert binds all values as params and returns metadata only', () => {
    const q = insertCredentialQuery(sealed);
    expect(q.values).toHaveLength(9);
    expect(q.values[3]).toBe(sealed.ciphertext);
    expect(q.text).toContain(
      'RETURNING id, name, provider, last4, base_url, status, health_score, created_at',
    );
  });

  it('delete returns the id so the service can detect a 404', () => {
    expect(deleteCredentialQuery('c1').text).toContain('RETURNING id');
    expect(deleteCredentialQuery('c1').values).toEqual(['c1']);
  });
});
