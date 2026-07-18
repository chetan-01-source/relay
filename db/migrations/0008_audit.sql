-- 0007_audit.sql — hash-chained audit log (PRD §3 · §4.2, Day 12 module)
-- Append-only, tamper-evident: each row's hash = sha256(prev_hash || canonical_json(row)).
-- `relay audit verify` walks the chain per org. Every control-plane mutation + data-plane
-- request summary appends a record.

CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seq            bigint NOT NULL,                      -- per-org monotonic sequence
  actor          text NOT NULL,                        -- logto user id / 'system' / virtual key id
  action         text NOT NULL,                        -- e.g. 'key.rotate', 'org.suspend'
  target         text,                                 -- affected resource id
  canonical_json jsonb NOT NULL,                       -- deterministic serialization of the event
  prev_hash      bytea,                                -- previous row's hash (null for seq=1)
  hash           bytea NOT NULL,                        -- sha256(prev_hash || canonical_json)
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, seq)
);
CREATE INDEX audit_log_org_seq_idx ON audit_log (org_id, seq);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON audit_log
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON TABLE audit_log IS 'Hash-chained append-only audit trail, verified per org by `relay audit verify`.';
