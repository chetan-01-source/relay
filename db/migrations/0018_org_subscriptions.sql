-- 0018_org_subscriptions.sql — which plan an org is on (ADR-0014).
--
-- Separate migration from 0017 on purpose: check-rls.sh decides whether a table is tenant-scoped by
-- scanning the ~60 lines below each table declaration, looking for an org_id column. Putting this
-- tenant table immediately after the platform-scoped `plans` table would make the gate conflate the
-- two — the same reason org_features lives apart from organizations (see 0001/0002).
--
-- (The gate matches the literal phrase "CREATE TABLE <name>" anywhere in these files, comments
--  included, so prose here deliberately avoids that phrase.)
--
-- One row per org (UNIQUE org_id): an org is on exactly one plan. An org with NO row resolves to the
-- default plan for the edition — `self_hosted` under oss, `free` under cloud — so this table is
-- additive and every org that predates it keeps working.

CREATE TABLE org_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code             text NOT NULL REFERENCES plans(code),

  -- Lifecycle. Resolution reads status + the two timestamps and NEVER needs a scheduled job:
  --   trialing + trial_ends_at in the past      → resolves to the free plan's limits
  --   past_due + grace_until   in the past      → resolves to the free plan's limits
  --   canceled                                  → resolves to the free plan's limits
  -- The row keeps its real status so the console can explain WHY, instead of silently showing Free.
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at         timestamptz,
  -- How long paid limits survive a failed payment. Cutting a production gateway off over a card
  -- decline is a worse outcome than a week of unpaid usage.
  grace_until           timestamptz,

  current_period_start  timestamptz,
  current_period_end    timestamptz,

  -- Per-contract deviations from the plan: {"members.max": 40}. Same closed key set as plans.limits,
  -- and it wins over the plan. This is what makes "enterprise, but 40 seats" a row edit rather than
  -- a bespoke plan nobody can find later.
  overrides             jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Billing linkage. The core knows a subscription MAY be backed by an external provider and nothing
  -- about which one — Stripe lives entirely in packages/cloud behind the PaymentProvider interface.
  provider              text,
  provider_ref          text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_subscriptions_org_idx ON org_subscriptions (org_id);
CREATE INDEX org_subscriptions_plan_idx ON org_subscriptions (plan_code);

ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_subscriptions
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON org_subscriptions
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON TABLE org_subscriptions IS 'One row per org: which plan, its lifecycle state, and per-contract overrides.';
COMMENT ON COLUMN org_subscriptions.overrides IS 'Wins over plans.limits; loses to org_features. Same closed key set.';
