-- 0019_provider_registry.sql — widen the supported provider list beyond the Phase-1 three.
--
-- Most of the providers added here are NOT new wire formats: OpenRouter, Groq, Together, Mistral,
-- DeepSeek, Fireworks, xAI, Perplexity and Google's compatibility endpoint all speak OpenAI's
-- protocol. They were already reachable via 'openai_compat' + a base URL. Naming them individually
-- buys three things that matter: the console can offer a real list with correct default base URLs,
-- `relay sync-models` knows where each one publishes its catalog, and usage/analytics group by the
-- vendor an operator actually recognises rather than lumping eight vendors into one bucket.
--
-- 'azure_openai' IS a new wire format (per-deployment URL + api-key header) and has its own adapter.
--
-- The authoritative list is packages/shared/src/providers.ts. This constraint mirrors it: keeping
-- the check in SQL means a bad provider cannot be written even by a direct psql session, and the
-- pair is small enough that drift is caught by the registry's own test.
--
-- Additive and safe: the constraint only ever WIDENS, so every existing row stays valid and no
-- rewrite is needed. Dropping a provider later would be the breaking direction and is not done here.

ALTER TABLE provider_credentials DROP CONSTRAINT IF EXISTS provider_credentials_provider_check;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
  CHECK (provider IN (
    'openai',
    'anthropic',
    'openrouter',
    'azure_openai',
    'google',
    'groq',
    'together',
    'mistral',
    'deepseek',
    'fireworks',
    'xai',
    'perplexity',
    'openai_compat'
  ));

-- model_catalog and rate_cards deliberately carry NO provider constraint. They are global seed data
-- refreshed by `relay sync-models` from the providers themselves, and a catalog row for a provider
-- this gateway does not yet name is harmless — it is never selected unless a credential points at
-- it. Constraining them would make a catalog sync fail on the day a vendor adds a family we have
-- not shipped support for, which is exactly when an operator most wants the data.
