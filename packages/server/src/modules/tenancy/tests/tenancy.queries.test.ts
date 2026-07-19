import { describe, it, expect } from 'vitest';
import {
  insertOrgQuery,
  getOrgByIdQuery,
  listOrgsQuery,
  updateOrgStatusQuery,
  updateOnboardingStateQuery,
  upsertOrgFeatureQuery,
  listOrgFeaturesQuery,
} from '../queries/tenancy.queries.js';

describe('tenancy queries', () => {
  it('binds all user values as params — never interpolated', () => {
    const insert = insertOrgQuery('logto-1', "Robert'); DROP TABLE orgs;--");
    expect(insert.values).toEqual(['logto-1', "Robert'); DROP TABLE orgs;--"]);
    expect(insert.text).not.toContain('DROP TABLE');
    expect(insert.text).toContain('$1');
    expect(insert.text).toContain('$2');
  });

  it('getOrgById / status / onboarding bind the id + value', () => {
    expect(getOrgByIdQuery('o1').values).toEqual(['o1']);
    expect(updateOrgStatusQuery('o1', 'suspended').values).toEqual(['o1', 'suspended']);
    expect(updateOnboardingStateQuery('o1', 'admin_invited').values).toEqual([
      'o1',
      'admin_invited',
    ]);
  });

  it('listOrgs takes no params and orders deterministically', () => {
    const q = listOrgsQuery();
    expect(q.values).toEqual([]);
    expect(q.text).toContain('ORDER BY created_at DESC');
  });

  it('upsertFeature serializes the value to JSON and casts to jsonb', () => {
    const q = upsertOrgFeatureQuery('o1', 'cache.exact', true);
    expect(q.values).toEqual(['o1', 'cache.exact', 'true']);
    expect(q.text).toContain('$3::jsonb');
    expect(q.text).toContain('ON CONFLICT (org_id, feature_key)');
  });

  it('listFeatures binds the org id', () => {
    expect(listOrgFeaturesQuery('o1').values).toEqual(['o1']);
  });
});
