-- 0012_route_cache.sql — per-route cache toggle (Week 3 Day 13, routes editor).
-- Additive column on the EXISTING tenant table `routes` (already FORCE RLS + both policies from
-- 0005). No new table → no new RLS block needed; check-rls.sh only gates newly-created tenant tables.
-- The console's routes editor flips this; the data plane may consult it to enable exact-cache per
-- route (global RELAY_CACHE_TTL_S still bounds the TTL).

ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS cache_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN routes.cache_enabled IS 'Per-route exact-cache switch (Day 13). TTL bounded by RELAY_CACHE_TTL_S.';
