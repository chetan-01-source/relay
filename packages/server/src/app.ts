/**
 * Composition root (playbook §5 · §11). Lives at the top level — NOT under platform/ — because
 * it wires the platform kernel + feature modules together; the dependency-cruiser rule forbids
 * the platform layer from importing modules. This is the ONLY place dependencies are constructed
 * and injected (DI): db (singleton) → module registrars.
 *
 * The public data plane also serves its own API docs: OpenAPI 3.1 (generated from route schemas by
 * @fastify/swagger) at /openapi.json and Swagger UI at /docs. `relay openapi` dumps the spec to
 * api/openapi/openapi.json without a running DB (see buildPublicApp + the CLI).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { RelayError, toErrorEnvelope } from '@relay/shared';
import type { Config } from './platform/config.js';
import type { Database } from './platform/db.js';
import type { EventBus } from './platform/eventbus.js';
import { registry } from './platform/metrics.js';
import { createLogtoOrgSync, type LogtoConfig } from './platform/logto.js';
import { registerProxy } from './modules/proxy/index.js';
import { registerModels } from './modules/models/index.js';
import { registerIdentity, type LogtoJwtConfig } from './modules/identity/index.js';
import { registerTenancy } from './modules/tenancy/index.js';
import { registerApps } from './modules/apps/index.js';
import { registerProviders } from './modules/providers/index.js';
import { registerAnalytics } from './modules/analytics/index.js';
import { registerAudit } from './modules/audit/index.js';
import { createRoutingService } from './modules/routing/index.js';
import { createPolicyService } from './modules/policy/index.js';
import { createCacheService } from './modules/cache/index.js';
import { createMeteringService } from './modules/metering/index.js';

export interface AppDeps {
  db: Database;
  bus: EventBus;
}

export interface Servers {
  publicApp: FastifyInstance;
  internalApp: FastifyInstance;
}

export interface PublicAppDeps {
  db: Database; // identity's key lookup needs withTenant; models uses it as a plain Queryable
  upstreamUrl: string;
  masterKey: string;
  bus?: EventBus; // present when serving; absent for the offline `relay openapi` spec dump
  logto?: LogtoJwtConfig; // control-plane JWT verification (identity)
  logtoM2m?: LogtoConfig; // Logto Management API creds (tenancy org sync); absent → onboarding 503
  // Day-11 value-layer knobs (defaulted so the offline spec dump needs none).
  cacheTtlS?: number;
  cacheMaxBytes?: number;
  meteringQueueMax?: number;
  meteringFlushIntervalMs?: number;
  rollupIntervalMs?: number;
}

const OPENAPI_DOC = {
  openapi: '3.1.0',
  info: {
    title: 'Relay Gateway API',
    description: 'OpenAI-compatible, multi-tenant LLM gateway. Data-plane (/v1/*) surface.',
    version: '0.2.0',
  },
  tags: [
    { name: 'chat', description: 'Chat completions (OpenAI-compatible hot path)' },
    { name: 'models', description: 'Model discovery' },
    { name: 'identity', description: 'Control-plane identity (Logto JWT + scopes)' },
    { name: 'tenancy', description: 'Platform control plane: org lifecycle + entitlements' },
    { name: 'apps', description: 'Applications + virtual-key lifecycle (issue/rotate/revoke)' },
    { name: 'providers', description: 'Encrypted upstream provider credentials' },
    { name: 'analytics', description: 'Usage/spend reporting over hourly rollups' },
    { name: 'audit', description: 'Append-only, hash-chained audit trail (read/verify)' },
  ],
};

/**
 * Build the public data-plane app: Swagger docs + feature modules. Shared by serve and `relay openapi`.
 * Async because Swagger must FULLY load (installing its onRoute hook) before any route registers —
 * `await app.register(...)` forces that ordering; otherwise the generated spec has empty paths.
 */
export async function buildPublicApp(deps: PublicAppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  await app.register(swagger, { openapi: OPENAPI_DOC });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Coarse per-IP rate limit — a DoS backstop in front of EVERY route (registered before them so its
  // onRequest hook applies globally). This complements, not replaces, the per-virtual-key token-bucket
  // limits in modules/policy: those meter tenant usage; this caps abusive request volume per source.
  // Loopback is allow-listed so a self-hoster's own traffic and the local load/bench harness (all from
  // one localhost IP at high RPS) are never throttled; remote clients are still capped.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // Central error contract: every error — thrown RelayError, schema-validation failure, or an
  // unexpected exception — leaves as the same OpenAI-compatible envelope (shared/errors.ts).
  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorEnvelope(err);
    if (status >= 500) req.log.error({ err }, 'request failed'); // details to logs, not the client
    if (reply.raw.headersSent) {
      reply.raw.end(); // stream already started — can't change status
      return;
    }
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    const { status, body } = new RelayError('not_found', {
      message: `Unknown route ${req.method} ${req.url}`,
    }).toResponse();
    void reply.code(status).send(body);
  });

  // Identity is the auth spine: it registers the control-plane /api routes and returns the
  // preHandlers the data plane guards with. Registered before the data routes so its /api paths and
  // the proxy's virtual-key guard are both in place.
  const identity = await registerIdentity(app, {
    db: deps.db,
    masterKey: deps.masterKey,
    ...(deps.bus ? { bus: deps.bus } : {}),
    ...(deps.logto ? { logto: deps.logto } : {}),
  });

  // Tenancy is a platform control-plane module: it manages the tenant lifecycle, guarded by the
  // identity JWT preHandlers. Logto org-sync is wired only when M2M creds are present; without them
  // onboarding returns 503 while the rest of the control plane works.
  registerTenancy(app, {
    db: deps.db,
    ...(deps.bus ? { bus: deps.bus } : {}),
    ...(deps.logtoM2m ? { logto: createLogtoOrgSync(deps.logtoM2m) } : {}),
    guards: { authJwt: identity.authJwt, requireScope: identity.requireScope },
  });

  // Org-scoped control plane: applications + virtual-key lifecycle, and the encrypted provider
  // credential store. Both guarded by the identity JWT preHandlers.
  const guards = { authJwt: identity.authJwt, requireScope: identity.requireScope };
  registerApps(app, {
    db: deps.db,
    masterKey: deps.masterKey,
    ...(deps.bus ? { bus: deps.bus } : {}),
    guards,
  });
  registerProviders(app, { db: deps.db, masterKey: deps.masterKey, guards });

  // Value-layer read surfaces (Day 12): usage/spend analytics over the hourly rollups, and the
  // read/verify endpoints for the append-only audit trail. Both guarded by the identity preHandlers.
  registerAnalytics(app, { db: deps.db, guards });
  registerAudit(app, { db: deps.db, guards });

  const routing = createRoutingService({
    db: deps.db,
    masterKey: deps.masterKey,
    fallbackBaseUrl: deps.upstreamUrl,
  });
  const policy = createPolicyService({ ...(deps.bus ? { bus: deps.bus } : {}) });

  // Value layer (Day 11): exact cache (Valkey, no-op without a bus) + metering (async ring queue).
  const cache = createCacheService({
    ...(deps.bus ? { client: deps.bus.client } : {}),
    ttlSeconds: deps.cacheTtlS ?? 0,
    maxBytes: deps.cacheMaxBytes ?? 256 * 1024,
  });
  const metering = createMeteringService({
    db: deps.db,
    queueMax: deps.meteringQueueMax ?? 10_000,
    flushIntervalMs: deps.meteringFlushIntervalMs ?? 2_000,
    rollupIntervalMs: deps.rollupIntervalMs ?? 60_000,
  });
  // Start the flush/rollup workers only when serving (a bus is present); the offline spec dump doesn't.
  if (deps.bus) {
    metering.start();
    app.addHook('onClose', async () => {
      await metering.stop();
    });
  }

  registerProxy(app, { routing, policy, cache, metering, authVirtualKey: identity.authVirtualKey });
  registerModels(app, { db: deps.db });

  // machine-readable spec next to the human UI at /docs
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  return app;
}

export async function buildServers(config: Config, deps: AppDeps): Promise<Servers> {
  const logto: LogtoJwtConfig | undefined = config.RELAY_LOGTO_ENDPOINT
    ? { endpoint: config.RELAY_LOGTO_ENDPOINT, audience: config.RELAY_LOGTO_JWT_AUDIENCE }
    : undefined;
  // Logto Management API creds for tenancy org-sync — present only when all three are configured.
  const logtoM2m: LogtoConfig | undefined =
    config.RELAY_LOGTO_ENDPOINT &&
    config.RELAY_LOGTO_M2M_APP_ID &&
    config.RELAY_LOGTO_M2M_APP_SECRET
      ? {
          endpoint: config.RELAY_LOGTO_ENDPOINT,
          m2mAppId: config.RELAY_LOGTO_M2M_APP_ID,
          m2mAppSecret: config.RELAY_LOGTO_M2M_APP_SECRET,
        }
      : undefined;
  const publicApp = await buildPublicApp({
    db: deps.db,
    upstreamUrl: config.RELAY_UPSTREAM_URL,
    masterKey: config.RELAY_MASTER_KEY,
    bus: deps.bus,
    cacheTtlS: config.RELAY_CACHE_TTL_S,
    cacheMaxBytes: config.RELAY_CACHE_MAX_BYTES,
    meteringQueueMax: config.RELAY_METERING_QUEUE_MAX,
    meteringFlushIntervalMs: config.RELAY_METERING_FLUSH_INTERVAL_MS,
    rollupIntervalMs: config.RELAY_ROLLUP_INTERVAL_MS,
    ...(logto ? { logto } : {}),
    ...(logtoM2m ? { logtoM2m } : {}),
  });

  const internalApp = Fastify({ logger: false });
  // Rate-limit the internal app (its /readyz probe touches the DB). The ceiling is generous so
  // orchestrator health probes and Prometheus scrapes are never throttled in practice.
  const internalRateLimit = { max: 6000, timeWindow: '1 minute' };
  await internalApp.register(rateLimit, internalRateLimit);
  internalApp.get('/healthz', () => ({ status: 'ok' }));
  // The readiness probe pings Postgres + Valkey, so it carries an explicit per-route rate limit.
  internalApp.get('/readyz', { config: { rateLimit: internalRateLimit } }, async (_req, reply) => {
    const [pg, valkey] = await Promise.all([deps.db.ping(), deps.bus.ping()]);
    const ready = pg && valkey;
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not-ready', pg, valkey });
  });
  internalApp.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  return { publicApp, internalApp };
}
