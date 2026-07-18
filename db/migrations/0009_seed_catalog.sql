-- 0009_seed_catalog.sql — global seed data (playbook §3 · §8). model_catalog + rate_cards are
-- GLOBAL (no org_id): adding a model or price is a seed PR touching zero tenant rows. Idempotent
-- via ON CONFLICT so re-running is a no-op. This is data, not schema — no tables created here.

INSERT INTO model_catalog (provider, model, capabilities) VALUES
  ('openai',    'gpt-4o',            '{"modalities":["text","image"],"max_tokens":128000,"tools":true,"streaming":true}'),
  ('openai',    'gpt-4o-mini',       '{"modalities":["text","image"],"max_tokens":128000,"tools":true,"streaming":true}'),
  ('anthropic', 'claude-3-5-sonnet', '{"modalities":["text","image"],"max_tokens":200000,"tools":true,"streaming":true}'),
  ('anthropic', 'claude-3-5-haiku',  '{"modalities":["text"],"max_tokens":200000,"tools":true,"streaming":true}')
ON CONFLICT (provider, model) DO NOTHING;

INSERT INTO rate_cards (provider, model, input_usd_per_1k, output_usd_per_1k) VALUES
  ('openai',    'gpt-4o',            0.005000, 0.015000),
  ('openai',    'gpt-4o-mini',       0.000150, 0.000600),
  ('anthropic', 'claude-3-5-sonnet', 0.003000, 0.015000),
  ('anthropic', 'claude-3-5-haiku',  0.000800, 0.004000)
ON CONFLICT DO NOTHING;
