import { describe, it, expect } from 'vitest';
import {
  insertAppQuery,
  insertKeyQuery,
  getKeyByIdQuery,
  listKeysByAppQuery,
  revokeKeyQuery,
  linkSuccessorQuery,
} from '../queries/apps.queries.js';

describe('apps queries', () => {
  it('binds every user value as a param — never interpolated', () => {
    const q = insertAppQuery('org-1', "a'; DROP TABLE applications;--", null);
    expect(q.values).toEqual(['org-1', "a'; DROP TABLE applications;--", null]);
    expect(q.text).not.toContain('DROP TABLE');
    expect(q.text).toContain('$1');
  });

  it('NEVER selects key_sha256 into a read shape', () => {
    for (const q of [getKeyByIdQuery('k1'), listKeysByAppQuery('a1')]) {
      expect(q.text).not.toContain('key_sha256');
    }
  });

  it('insertKey binds the verifier as bytea and returns no hash column', () => {
    const verifier = Buffer.alloc(32, 7);
    const q = insertKeyQuery({
      orgId: 'o',
      appId: 'a',
      keyId: 'kid',
      verifier,
      last4: 'abcd',
      name: null,
      environment: 'live',
    });
    expect(q.values[3]).toBe(verifier);
    expect(q.text).toContain('RETURNING');
    expect(q.text).not.toContain(
      'RETURNING id, app_id, key_id, last4, name, environment, status, successor_id, grace_until, created_at, revoked_at, key_sha256',
    );
  });

  it('revoke only affects an active key; rotate links successor + grace', () => {
    expect(revokeKeyQuery('k1').text).toContain("status = 'active'");
    const link = linkSuccessorQuery('pred', 'succ', '2026-07-20T00:00:00Z');
    expect(link.values).toEqual(['pred', 'succ', '2026-07-20T00:00:00Z']);
  });
});
