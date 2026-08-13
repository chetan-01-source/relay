-- 0017_plans.sql — the plan catalog (ADR-0014).
--
-- A plan is a NAMED BUNDLE OF LIMITS. It is platform data, not tenant data: the same catalog for
-- every org, so it carries no org_id and is deliberately NOT gated by check-rls.sh. It is still
-- RLS-protected — anyone may read the catalog (the console renders it, the pricing page lists it),
-- only a platform admin may write it.
--
-- `limits` is one jsonb object rather than twenty columns because limits are the part of this system
-- most likely to change during pricing experiments, and a pricing experiment must not require a
-- migration. The KEY SET is closed and typed in modules/plans/lib/limits.ts — the flexibility is in
-- the storage, not in the contract.
--
-- Precedence at resolution time (see 0018 + plans.service):
--   plan.limits  ⊕  org_subscriptions.overrides  ⊕  org_features   =  effective entitlements

CREATE TABLE plans (
  code                text PRIMARY KEY,                 -- 'free' | 'pro' | … — stable, referenced by subscriptions
  name                text NOT NULL,                    -- display name
  description         text NOT NULL DEFAULT '',
  -- Ordinal rank, used ONLY for ordering and for "is this an upgrade or a downgrade". Never for
  -- entitlement decisions: those read `limits`, so a bespoke plan can sit anywhere in the order.
  tier                smallint NOT NULL,
  limits              jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_monthly_usd   numeric(10,2),                    -- null = not purchasable (custom / built-in)
  price_yearly_usd    numeric(10,2),
  -- Listed in the public catalog. A grandfathered or bespoke plan stays assignable but unlisted.
  public              boolean NOT NULL DEFAULT true,
  -- Assignable to NEW subscriptions. Retiring a plan flips this; existing subscribers are untouched.
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_catalog_idx ON plans (public, active, tier);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
-- Read is open: the catalog is public information and the entitlement resolver reads it inside a
-- tenant transaction, where no platform-admin flag is set.
CREATE POLICY catalog_read ON plans FOR SELECT USING (true);
CREATE POLICY catalog_admin_write ON plans
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON TABLE plans IS 'Plan catalog. Platform-scoped (no org_id): read by all, written by platform admins.';
COMMENT ON COLUMN plans.limits IS 'Closed key set typed in modules/plans/lib/limits.ts. null value = unlimited.';

-- ── Seeded tiers ─────────────────────────────────────────────────────────────
-- null means UNLIMITED, everywhere, for every key. That convention is what lets the self-hosted
-- plan be expressed as "all nulls, all flags true" rather than as a special case in code.
--
-- `self_hosted` is what the oss edition resolves EVERY org to. It is seeded (not hardcoded) so the
-- schema is identical across editions — which is what makes a self-hosted → cloud migration a data
-- move rather than a rewrite — but it is never public and never purchasable.

INSERT INTO plans (code, name, description, tier, price_monthly_usd, price_yearly_usd, public, limits) VALUES
  ('free', 'Free', 'Evaluate Relay against real traffic.', 1, 0, 0, true, '{
     "apps.max": 1,
     "providers.max": 1,
     "routes.max": 2,
     "keys.per_app.max": 2,
     "members.max": 3,
     "rate.rpm": 60,
     "rate.tpm": 60000,
     "spend.monthly_usd.max": 25,
     "retention.traffic_days": 7,
     "cache.exact": false,
     "routing.failover": false,
     "modalities.image": false,
     "notifications.chat": false,
     "analytics.export": false
   }'::jsonb),

  ('pro', 'Pro', 'A production gateway for one team.', 2, 49, 490, true, '{
     "apps.max": 10,
     "providers.max": 5,
     "routes.max": 25,
     "keys.per_app.max": 10,
     "members.max": 10,
     "rate.rpm": 600,
     "rate.tpm": 600000,
     "spend.monthly_usd.max": 2500,
     "retention.traffic_days": 30,
     "cache.exact": true,
     "routing.failover": true,
     "modalities.image": true,
     "notifications.chat": true,
     "analytics.export": true
   }'::jsonb),

  ('scale', 'Scale', 'Many teams, many providers, one gateway.', 3, 499, 4990, true, '{
     "apps.max": 100,
     "providers.max": 25,
     "routes.max": 250,
     "keys.per_app.max": 50,
     "members.max": 50,
     "rate.rpm": 6000,
     "rate.tpm": 6000000,
     "spend.monthly_usd.max": 50000,
     "retention.traffic_days": 90,
     "cache.exact": true,
     "routing.failover": true,
     "modalities.image": true,
     "notifications.chat": true,
     "analytics.export": true
   }'::jsonb),

  ('enterprise', 'Enterprise', 'Negotiated limits, SSO enforcement and an SLA.', 4, NULL, NULL, true, '{
     "apps.max": null,
     "providers.max": null,
     "routes.max": null,
     "keys.per_app.max": null,
     "members.max": null,
     "rate.rpm": null,
     "rate.tpm": null,
     "spend.monthly_usd.max": null,
     "retention.traffic_days": 365,
     "cache.exact": true,
     "routing.failover": true,
     "modalities.image": true,
     "notifications.chat": true,
     "analytics.export": true
   }'::jsonb),

  ('self_hosted', 'Self-hosted', 'Every capability, no ceiling. The open-source edition.', 0, 0, 0, false, '{
     "apps.max": null,
     "providers.max": null,
     "routes.max": null,
     "keys.per_app.max": null,
     "members.max": null,
     "rate.rpm": null,
     "rate.tpm": null,
     "spend.monthly_usd.max": null,
     "retention.traffic_days": null,
     "cache.exact": true,
     "routing.failover": true,
     "modalities.image": true,
     "notifications.chat": true,
     "analytics.export": true
   }'::jsonb);
