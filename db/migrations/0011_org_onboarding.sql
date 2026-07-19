-- 0011_org_onboarding.sql — org onboarding state machine (Week 2 Day 7 · tenancy module)
-- Additive-only. Adds the onboarding lifecycle column to the tenant-root `organizations` table.
--
-- The state machine (enforced in the tenancy service, mirrored by this CHECK) is linear:
--   created → admin_invited → provider_added → first_request
-- Each transition is an audit event. `organizations` is the tenant ROOT (no org_id), already
-- RLS-protected in 0001; adding a column changes nothing about its policies, so check-rls stays green.

ALTER TABLE organizations
  ADD COLUMN onboarding_state text NOT NULL DEFAULT 'created'
    CHECK (onboarding_state IN ('created', 'admin_invited', 'provider_added', 'first_request'));

COMMENT ON COLUMN organizations.onboarding_state IS
  'Linear onboarding lifecycle: created → admin_invited → provider_added → first_request. Advanced only through the tenancy service, which records each transition in the audit log.';
