# Migrations

Plain SQL, applied by `relay migrate` (advisory-locked, in order). One numbered file per change: `NNNN_description.sql`.

## RLS contract — enforced by `scripts/check-rls.sh` (CI gate)

**Every table with an `org_id` column is a tenant table** and MUST, in the same migration:

1. `ENABLE` + `FORCE` row-level security
2. define policy `tenant_isolation`
3. define policy `platform_admin_access`

The gate fails the PR if any tenant table is missing any of these. This is PRD hard non-negotiable #1 — never bypass it.

### Template

```sql
CREATE TABLE example_resource (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE example_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_resource FORCE  ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON example_resource
  USING (org_id = current_setting('app.current_org')::uuid);

CREATE POLICY platform_admin_access ON example_resource
  USING (current_setting('app.is_platform_admin', true) = 'true');
```

The gateway sets `app.current_org` (and `app.is_platform_admin`) via `SET LOCAL` inside each
per-request transaction, so RLS scopes every query to the caller's tenant. The static gate here
is backed by the dynamic isolation suite (`test/isolation/`) — both must stay green.
