/**
 * Zod-validated runtime config (PRD §4 · playbook §5). Single source of truth for env.
 * Boot-time validation with actionable errors; secrets are never echoed. All keys RELAY_*.
 */
import { z } from 'zod';

const schema = z.object({
  // servers
  RELAY_PORT: z.coerce.number().int().positive().default(3000), // data plane (/v1/*)
  RELAY_INTERNAL_PORT: z.coerce.number().int().positive().default(9090), // health + metrics
  RELAY_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // datastores
  RELAY_DATABASE_URL: z.string().url(), // runtime: relay_app (RLS applies)
  RELAY_MIGRATION_DATABASE_URL: z.string().url().optional(), // migrate: postgres (bypasses RLS)
  RELAY_VALKEY_URL: z.string().url().default('redis://localhost:6379'),

  // crypto — envelope KEK, 32 bytes base64 (openssl rand -base64 32)
  RELAY_MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  // upstream (Phase-1 skeleton: hardcoded target → mockllm)
  RELAY_UPSTREAM_URL: z.string().url().default('http://localhost:8080'),

  // Logto — control-plane (/api/*) JWT verification (Week 2 Day 6 · ADR two-auth-planes).
  // Issuer is `${endpoint}/oidc`; JWKS is fetched + cached from its discovery document. Audience is
  // the Relay API resource indicator. Optional: when unset, the control plane rejects every JWT
  // (401) since it cannot verify one — the data plane (virtual keys) works regardless.
  RELAY_LOGTO_ENDPOINT: z.string().url().optional(),
  RELAY_LOGTO_JWT_AUDIENCE: z.string().default('https://relay.gateway/api'),

  // Logto Management API M2M app (Week 2 Day 7 · ADR-7). Used by the tenancy module to create Logto
  // organizations and send admin invites at onboarding. Optional: without all three the control
  // plane still runs, but org onboarding returns 503 (service_unavailable) since it cannot sync Logto.
  RELAY_LOGTO_M2M_APP_ID: z.string().optional(),
  RELAY_LOGTO_M2M_APP_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  RELAY: ${i.path.join('.')} — ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Effective config with secrets redacted — safe to log at boot. */
export function redactedConfig(c: Config): Record<string, unknown> {
  return {
    ...c,
    RELAY_DATABASE_URL: redactUrl(c.RELAY_DATABASE_URL),
    RELAY_MIGRATION_DATABASE_URL: c.RELAY_MIGRATION_DATABASE_URL
      ? redactUrl(c.RELAY_MIGRATION_DATABASE_URL)
      : undefined,
    RELAY_VALKEY_URL: redactUrl(c.RELAY_VALKEY_URL),
    RELAY_MASTER_KEY: '***redacted***',
  };
}

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '***';
  }
}
