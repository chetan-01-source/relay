-- 0003_providers.sql — provider credentials + global model catalog (PRD §3, Day 8-9 modules)
-- Two-key model, outbound side: provider credentials are AES-256-GCM envelope-encrypted,
-- write-only, decrypted only in worker memory at send time.

-- ── provider_credentials ─────────────────────────────────────────────────────
CREATE TABLE provider_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  provider     text NOT NULL
                 CHECK (provider IN ('openai', 'anthropic', 'openai_compat')),
  ciphertext   bytea NOT NULL,                        -- AES-256-GCM(sk-…) under a per-credential DEK
  iv           bytea NOT NULL,                        -- GCM nonce (12 bytes)
  auth_tag     bytea NOT NULL,                        -- GCM auth tag (16 bytes)
  wrapped_dek  bytea NOT NULL,                        -- DEK wrapped by RELAY_MASTER_KEY (KEK)
  last4        text NOT NULL,                         -- display only: sk-…wxyz
  base_url     text,                                  -- for openai_compat (vLLM/Ollama/LM Studio)
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'disabled')),
  health_score real NOT NULL DEFAULT 1.0,             -- rolling (1 - error_rate); feeds the router
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_credentials_org_idx ON provider_credentials (org_id);

ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON provider_credentials
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY platform_admin_access ON provider_credentials
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMENT ON TABLE provider_credentials IS 'Envelope-encrypted upstream keys. Plaintext exists only transiently in worker memory.';

-- ── model_catalog (GLOBAL, community-maintainable seed — intentionally no org_id) ────
-- Not tenant data: keeping capabilities out of the tenant boundary means adding a model
-- is a seed PR that touches zero tenant rows and no RLS. Per-org overrides, if ever
-- needed, become a small additive tenant table later.
CREATE TABLE model_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  model         text NOT NULL,                        -- provider-native model id, e.g. gpt-4o
  capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {modalities:[...],max_tokens,tools,streaming}
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model)
);
COMMENT ON TABLE model_catalog IS 'Global model capability catalog. No org_id: not tenant data, seed-maintained.';
