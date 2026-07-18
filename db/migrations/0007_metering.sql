-- 0007_metering.sql — usage events + hourly rollups + global rate cards (PRD §3 · §4.8)
-- The keystone: every request lands as ONE normalized usage_event carrying org_id + app_id
-- (+ key_id + route_id) — never the provider's response body. Cost is computed from the
-- global rate_card at settle time, never parsed from the provider payload.
-- Layout note: tenant tables come first; the GLOBAL rate_cards table (no org_id) is LAST so
-- the RLS gate's line-window heuristic never conflates it with a following tenant table.

-- ── usage_events (tenant, PARTITIONED BY MONTH) ──────────────────────────────
-- Partitioned from day one so it never needs re-partitioning. PK includes the partition
-- key (created_at), as Postgres requires. No FK on org_id/app_id: this is a high-volume
-- append-only table and the write is off the hot path via a bounded async queue.
CREATE TABLE usage_events (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,                        -- WHICH ORG (tenant) — RLS boundary
  app_id         uuid NOT NULL,                        -- WHICH APP incurred the usage
  key_id         uuid,                                 -- which virtual key (nullable: key may be deleted)
  route_id       uuid,                                 -- which route resolved the request
  request_id     text NOT NULL,                        -- X-Relay-Trace-Id, for correlation
  provider       text NOT NULL,
  model          text NOT NULL,                        -- provider-native model actually called
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,     -- computed from rate_cards at settle
  status         text NOT NULL,                        -- ok | error | rate_limited | budget_exceeded
  latency_ms     integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX usage_events_org_time_idx     ON usage_events (org_id, created_at DESC);
CREATE INDEX usage_events_org_app_time_idx ON usage_events (org_id, app_id, created_at DESC);
CREATE INDEX usage_events_created_brin     ON usage_events USING brin (created_at);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON usage_events
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON TABLE usage_events IS 'Normalized per-request metering (org_id + app_id). Never stores provider response bodies.';

-- ── usage_rollups_hourly (tenant) ────────────────────────────────────────────
-- Dashboards read rollups, never the raw partitions. Populated by a background worker.
CREATE TABLE usage_rollups_hourly (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hour           timestamptz NOT NULL,                 -- truncated to the hour
  app_id         uuid,
  route_id       uuid,
  provider       text,
  model          text,
  requests       bigint NOT NULL DEFAULT 0,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  cost_usd       numeric(14,6) NOT NULL DEFAULT 0,
  UNIQUE (org_id, hour, app_id, route_id, provider, model)
);
CREATE INDEX usage_rollups_hourly_org_idx ON usage_rollups_hourly (org_id, hour DESC);

ALTER TABLE usage_rollups_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups_hourly FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_rollups_hourly
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON usage_rollups_hourly
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- ── partition maintenance ────────────────────────────────────────────────────
-- Idempotent helper: create one month partition. A background worker calls this ahead
-- of time; the DEFAULT partition guarantees inserts never fail meanwhile.
CREATE OR REPLACE FUNCTION relay_ensure_usage_partition(month_start date)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  part_name  text := 'usage_events_' || to_char(month_start, 'YYYY_MM');
  next_month date := (month_start + interval '1 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
    part_name, month_start, next_month
  );
END;
$fn$;

DO $$
BEGIN
  PERFORM relay_ensure_usage_partition(date_trunc('month', now())::date);
  PERFORM relay_ensure_usage_partition((date_trunc('month', now()) + interval '1 month')::date);
END $$;

CREATE TABLE usage_events_default PARTITION OF usage_events DEFAULT;

-- ── rate_cards (GLOBAL seed — intentionally no org_id, kept LAST) ─────────────
-- Pricing lives outside the tenant boundary: change a price / add a model = a seed PR,
-- versioned by effective_from. effective_to = null means "current".
CREATE TABLE rate_cards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  model             text NOT NULL,
  input_usd_per_1k  numeric(12,6) NOT NULL,           -- USD per 1K input (prompt) tokens
  output_usd_per_1k numeric(12,6) NOT NULL,           -- USD per 1K output (completion) tokens
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,                       -- null = currently effective
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_cards_lookup_idx ON rate_cards (provider, model, effective_from DESC);
COMMENT ON TABLE rate_cards IS 'Global pricing. No org_id: pricing is not tenant data. Cost computed at settle.';
