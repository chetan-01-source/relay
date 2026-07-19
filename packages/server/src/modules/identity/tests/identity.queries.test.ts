import { describe, it, expect } from 'vitest';
import {
  resolveVirtualKeyByKeyIdQuery,
  listOrgFeaturesQuery,
} from '../queries/identity.queries.js';

describe('identity queries', () => {
  it('resolveVirtualKeyByKeyIdQuery binds key_id as $1 and joins the org status', () => {
    const q = resolveVirtualKeyByKeyIdQuery('kid-abc');
    expect(q.values).toEqual(['kid-abc']);
    expect(q.text).toContain('WHERE vk.key_id = $1');
    expect(q.text).toContain('JOIN organizations o');
    expect(q.text).toContain('o.status AS org_status');
    expect(q.text).not.toContain('kid-abc'); // never interpolated
  });

  it('listOrgFeaturesQuery binds org_id as $1', () => {
    const q = listOrgFeaturesQuery('org-1');
    expect(q.values).toEqual(['org-1']);
    expect(q.text).toContain('FROM org_features WHERE org_id = $1');
  });
});
