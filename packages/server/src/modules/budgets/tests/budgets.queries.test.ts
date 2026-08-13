import { describe, it, expect } from 'vitest';
import {
  listBudgetsQuery,
  getBudgetQuery,
  upsertBudgetQuery,
  deleteBudgetQuery,
} from '../queries/budgets.queries.js';

const ORG = '0744ded6-30b6-4990-a3df-3f2ce74d632c';
const APP = '9f1c2e3d-0000-4000-8000-000000000001';

describe('budgets queries', () => {
  it('binds every user-supplied value as a parameter — never interpolated', () => {
    const queries = [
      listBudgetsQuery(ORG),
      getBudgetQuery(ORG, APP, 'monthly'),
      upsertBudgetQuery(ORG, APP, 'monthly', 50, true),
      deleteBudgetQuery(ORG, APP, 'monthly'),
    ];
    for (const query of queries) {
      expect(query.text).not.toContain(ORG);
      expect(query.text).not.toContain(APP);
      expect(query.values).toContain(ORG);
    }
  });

  it('reads limit_usd as text so pg numeric never round-trips through a float', () => {
    expect(listBudgetsQuery(ORG).text).toContain('limit_usd::text');
    expect(getBudgetQuery(ORG, null, 'monthly').text).toContain('limit_usd::text');
  });

  // `app_id = NULL` is never true, so an org-wide ceiling could never be matched — every write would
  // silently become an insert and every delete a no-op.
  it('matches the scope with IS NOT DISTINCT FROM so a NULL app_id is addressable', () => {
    expect(getBudgetQuery(ORG, null, 'monthly').text).toContain('app_id IS NOT DISTINCT FROM $2');
    expect(deleteBudgetQuery(ORG, null, 'monthly').text).toContain(
      'app_id IS NOT DISTINCT FROM $2',
    );
    expect(getBudgetQuery(ORG, null, 'monthly').values[1]).toBeNull();
  });

  it('upserts on the same expression the unique index uses, or ON CONFLICT would not match it', () => {
    const query = upsertBudgetQuery(ORG, APP, 'monthly', 50, false);
    expect(query.text).toContain(
      "ON CONFLICT (org_id, COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid), period)",
    );
    expect(query.text).toContain('DO UPDATE SET');
    expect(query.values).toEqual([ORG, APP, 'monthly', 50, false]);
  });

  it('carries a null app_id through an upsert as the org-wide ceiling', () => {
    expect(upsertBudgetQuery(ORG, null, 'daily', 5, true).values[1]).toBeNull();
  });

  it('touches updated_at on an upsert so a change is visible without an audit lookup', () => {
    expect(upsertBudgetQuery(ORG, null, 'daily', 5, true).text).toContain('updated_at = now()');
  });

  it('returns the deleted id so the caller can tell a real delete from a no-op', () => {
    expect(deleteBudgetQuery(ORG, null, 'daily').text).toContain('RETURNING id');
  });

  it('lists org-wide ceilings before per-app ones', () => {
    expect(listBudgetsQuery(ORG).text).toContain('ORDER BY app_id NULLS FIRST');
  });

  it('scopes every statement to the org, belt-and-braces with RLS', () => {
    expect(listBudgetsQuery(ORG).text).toContain('org_id = $1');
    expect(getBudgetQuery(ORG, null, 'monthly').text).toContain('org_id = $1');
    expect(deleteBudgetQuery(ORG, null, 'monthly').text).toContain('org_id = $1');
  });
});
