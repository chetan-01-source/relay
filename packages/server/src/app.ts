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
import { RelayError, toErrorEnvelope } from 'relay-shared';
import { RELAY_VERSION } from './version.js';
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
import { registerBudgets } from './modules/budgets/index.js';
import {
  registerNotifications,
  createConsoleSender,
  createSmtpSender,
  type EmailSender,
  createBudgetAlertSink,
} from './modules/notifications/index.js';
import { createPolicyRepository } from './modules/policy/index.js';
import {
  createPlans,
  createPlanSource,
  createRetentionSource,
  registerPlans,
  type Edition,
} from './modules/plans/index.js';
import { registerAudit } from './modules/audit/index.js';
import { registerRoutes } from './modules/routes/index.js';
import { registerTraffic } from './modules/traffic/index.js';
import { createRoutingService } from './modules/routing/index.js';
import { createPolicyService } from './modules/policy/index.js';
import { createCacheService } from './modules/cache/index.js';
import { createMeteringService } from './modules/metering/index.js';

export interface AppDeps {
  db: Database;
  bus: EventBus;
}

/** Liveness of a booting/draining worker. `warm` flips true once every module is wired and both
 * ports are listening, and false the instant shutdown begins — so /readyz fails first and the load
 * balancer drains this worker before we start closing connections. Mutable by design: the CLI owns
 * the flag's lifecycle, the /readyz handler only reads it. */
export interface Readiness {
  warm: boolean;
}

export interface Servers {
  publicApp: FastifyInstance;
  internalApp: FastifyInstance;
  readiness: Readiness;
  /** Block until in-flight requests drain (or the timeout elapses); returns the count still running. */
  drain: (timeoutMs: number) => Promise<number>;
}

export interface PublicAppDeps {
  db: Database; // identity's key lookup needs withTenant; models uses it as a plain Queryable
  upstreamUrl: string;
  masterKey: string;
  bus?: EventBus; // present when serving; absent for the offline `relay openapi` spec dump
  /**
   * Entitlement regime (ADR-0014). Defaults to 'oss' — every org unlimited — so a self-hoster, the
   * test suite and the offline spec dump all get the permissive service without configuring anything.
   */
  edition?: Edition;
  logto?: LogtoJwtConfig; // control-plane JWT verification (identity)
  logtoM2m?: LogtoConfig; // Logto Management API creds (tenancy org sync); absent → onboarding 503
  // Day-11 value-layer knobs (defaulted so the offline spec dump needs none).
  cacheTtlS?: number;
  // Notifications: absent smtp ⇒ the console sender, which records but never delivers.
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string | undefined;
    password?: string | undefined;
  };
  smtpFrom?: string;
  consoleUrl?: string;
  notifyIntervalMs?: number;
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
    // Read from version.ts, never written here: a hardcoded copy silently publishes a spec whose
    // stated version disagrees with the binary serving it, and the generated SDK inherits the lie.
    version: RELAY_VERSION,
  },
  tags: [
    { name: 'chat', description: 'Chat completions (OpenAI-compatible hot path)' },
    { name: 'models', description: 'Model discovery' },
    { name: 'identity', description: 'Control-plane identity (Logto JWT + scopes)' },
    { name: 'tenancy', description: 'Platform control plane: org lifecycle + entitlements' },
    { name: 'apps', description: 'Applications + virtual-key lifecycle (issue/rotate/revoke)' },
    { name: 'providers', description: 'Encrypted upstream provider credentials' },
    { name: 'analytics', description: 'Usage/spend reporting over hourly rollups' },
    {
      name: 'budgets',
      description: 'Per-org spend ceilings the data plane enforces (reserve/settle)',
    },
    {
      name: 'notifications',
      description: 'Per-tenant delivery channel, event preferences, and the delivery log',
    },
    { name: 'audit', description: 'Append-only, hash-chained audit trail (read/verify)' },
    {
      name: 'routes',
      description: 'Route editor: versions, targets, activate/rollback, cache toggle',
    },
    { name: 'traffic', description: 'Recent request feed + trace detail (live SSE)' },
    {
      name: 'plans',
      description:
        'Plan catalog, effective entitlements and quotas. Empty/unlimited in the self-hosted edition.',
    },
  ],
};

/**
 * Build the public data-plane app: Swagger docs + feature modules. Shared by serve and `relay openapi`.
 * Async because Swagger must FULLY load (installing its onRoute hook) before any route registers —
 * `await app.register(...)` forces that ordering; otherwise the generated spec has empty paths.
 */
export async function buildPublicApp(deps: PublicAppDeps): Promise<FastifyInstance> {
  // forceCloseConnections: 'idle' — on graceful shutdown, close() drops idle keep-alive sockets
  // immediately but lets IN-FLIGHT requests (including open SSE streams) finish draining. Fastify v5
  // otherwise force-closes every socket, which would abruptly cut an in-flight completion. The hard
  // RELAY_SHUTDOWN_TIMEOUT_MS in the CLI is the backstop if a stream never ends.
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
    forceCloseConnections: 'idle',
  });

  // In-flight request tracker for graceful shutdown. Fastify's own socket accounting does not reliably
  // hold a request that is still awaiting upstream (no bytes sent yet), so we count requests
  // explicitly: onResponse fires only once the response is fully sent — for an SSE stream, at stream
  // end — so this brackets the entire request lifetime. The CLI drains to zero (bounded) before
  // close(), which is what actually lets an in-flight completion finish instead of being cut.
  let inflight = 0;
  app.addHook('onRequest', (_req, _reply, done) => {
    inflight += 1;
    done();
  });
  app.addHook('onResponse', (_req, _reply, done) => {
    inflight -= 1;
    done();
  });
  (app as unknown as { inflight: () => number }).inflight = () => inflight;

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

  // Plans first: it is the one place that answers "what may this org do", and identity folds its
  // answer into every virtual-key snapshot. Constructed before identity because identity consumes it
  // (through the narrow PlanSource interface) — and it depends on nothing but the database, so this
  // ordering is free. THE edition switch lives inside createPlans and nowhere else (docs/editions.md).
  const plans = createPlans({
    db: deps.db,
    edition: deps.edition ?? 'oss',
    ...(deps.bus ? { bus: deps.bus } : {}),
  });

  // Identity is the auth spine: it registers the control-plane /api routes and returns the
  // preHandlers the data plane guards with. Registered before the data routes so its /api paths and
  // the proxy's virtual-key guard are both in place.
  const identity = await registerIdentity(app, {
    db: deps.db,
    masterKey: deps.masterKey,
    planSource: createPlanSource(plans),
    ...(deps.bus ? { bus: deps.bus } : {}),
    ...(deps.logto ? { logto: deps.logto } : {}),
  });

  // Tenancy is a platform control-plane module: it manages the tenant lifecycle, guarded by the
  // identity JWT preHandlers. Logto org-sync is wired only when M2M creds are present; without them
  // onboarding returns 503 while the rest of the control plane works.
  // One Logto client shared by tenancy (org sync) and notifications (member → recipient lookup).
  const logtoSync = deps.logtoM2m ? createLogtoOrgSync(deps.logtoM2m) : undefined;

  const guards = {
    authJwt: identity.authJwt,
    requireScope: identity.requireScope,
    requireOrgAdmin: identity.requireOrgAdmin,
  };

  // The plan read surface + the catalog. In the oss edition the catalog is empty and the effective
  // plan is `self_hosted`, so the console's plan page still renders real usage with no ceilings.
  registerPlans(app, { service: plans, guards });

  // Notifications registers its config API and returns the enqueuer other modules produce through.
  // The platform sender is chosen HERE, once: no SMTP host configured means a console sender, so a
  // developer cannot accidentally mail a tenant's members while testing.
  const platformSender: EmailSender = deps.smtp
    ? createSmtpSender(deps.smtp)
    : createConsoleSender();
  const notifications = registerNotifications(app, {
    db: deps.db,
    masterKey: deps.masterKey,
    guards,
    plans,
    platformSender,
    platformFrom: deps.smtpFrom ?? 'relay@localhost',
    logto: logtoSync,
    consoleUrl: deps.consoleUrl,
    ...(deps.notifyIntervalMs ? { dispatchIntervalMs: deps.notifyIntervalMs } : {}),
  });
  (app as unknown as { notifications: typeof notifications }).notifications = notifications;

  // Tenancy comes after notifications so it can produce org.suspended and member.removed. Logto
  // org-sync is wired only when M2M creds are present; without them onboarding returns 503 while the
  // rest of the control plane works.
  registerTenancy(app, {
    db: deps.db,
    ...(deps.bus ? { bus: deps.bus } : {}),
    ...(logtoSync ? { logto: logtoSync } : {}),
    guards,
    plans,
    notify: notifications.enqueuer,
    consoleUrl: deps.consoleUrl,
  });

  // Org-scoped control plane: applications + virtual-key lifecycle, and the encrypted provider
  // credential store. Both guarded by the identity JWT preHandlers.
  // `plans` is threaded into every module that creates a countable resource. Each one calls
  // assertQuota INSIDE its insert transaction — outside it the check races (ADR-0014 §5).
  registerApps(app, {
    db: deps.db,
    masterKey: deps.masterKey,
    ...(deps.bus ? { bus: deps.bus } : {}),
    guards,
    plans,
    notify: notifications.enqueuer,
  });
  registerProviders(app, {
    db: deps.db,
    masterKey: deps.masterKey,
    guards,
    plans,
    notify: notifications.enqueuer,
  });

  // Value-layer read surfaces (Day 12): usage/spend analytics over the hourly rollups, and the
  // read/verify endpoints for the append-only audit trail. Both guarded by the identity preHandlers.
  // Analytics is NOT plan-gated at the gateway. `analytics.export` gates the console's CSV route,
  // which is where a CSV is actually produced; the underlying usage API is available on every plan,
  // and pretending otherwise would be a gate anyone could walk around with curl.
  registerAnalytics(app, { db: deps.db, guards });
  // Budgets are the write side of what policy enforces on the hot path; the bus lets a change reach
  // every worker's cached snapshot within ~1s instead of waiting for an eviction.
  registerBudgets(app, {
    db: deps.db,
    ...(deps.bus ? { bus: deps.bus } : {}),
    guards,
    notify: notifications.enqueuer,
  });
  registerAudit(app, { db: deps.db, guards });

  // Day-13 org control plane: the routes editor (CRUD over the routing tables) and the request-feed
  // read surface (recent usage events + trace detail + live SSE). No new tables — routes reuses 0005
  // + 0012; traffic reads usage_events (0007). Both guarded by the identity preHandlers.
  registerRoutes(app, { db: deps.db, guards, plans });
  registerTraffic(app, {
    db: deps.db,
    ...(deps.bus ? { bus: deps.bus } : {}),
    guards,
  });

  const routing = createRoutingService({
    db: deps.db,
    masterKey: deps.masterKey,
    fallbackBaseUrl: deps.upstreamUrl,
  });
  // The spend reader seeds a cold budget counter from what the period has already cost, so creating
  // a budget mid-period (or restarting Valkey) cannot silently re-grant the allowance already spent.
  const policy = createPolicyService({
    ...(deps.bus ? { bus: deps.bus } : {}),
    spendReader: createPolicyRepository(deps.db),
    // Turns a rejection into ONE notification per ceiling per period (see budget-alerts.ts).
    alerts: createBudgetAlertSink(notifications.enqueuer),
  });

  // Value layer (Day 11): exact cache (Valkey, no-op without a bus) + metering (async ring queue).
  const cache = createCacheService({
    ...(deps.bus ? { client: deps.bus.client } : {}),
    ttlSeconds: deps.cacheTtlS ?? 0,
    maxBytes: deps.cacheMaxBytes ?? 256 * 1024,
  });
  const metering = createMeteringService({
    db: deps.db,
    ...(deps.bus ? { bus: deps.bus } : {}),
    // Enforces each plan's `retention.traffic_days`. In the oss edition every org resolves to
    // "unlimited", so the sweep runs and deletes nothing.
    retention: createRetentionSource(plans),
    queueMax: deps.meteringQueueMax ?? 10_000,
    flushIntervalMs: deps.meteringFlushIntervalMs ?? 2_000,
    rollupIntervalMs: deps.rollupIntervalMs ?? 60_000,
  });
  // Start the flush/rollup workers only when serving (a bus is present); the offline spec dump doesn't.
  if (deps.bus) {
    metering.start();
    // The delivery worker runs only when serving — the offline `relay openapi` dump must not start
    // timers or attempt to send anything.
    notifications.dispatcher.start();
    app.addHook('onClose', async () => {
      notifications.dispatcher.stop();
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
    edition: config.RELAY_EDITION,
    cacheTtlS: config.RELAY_CACHE_TTL_S,
    // No SMTP host ⇒ buildPublicApp picks the console sender and nothing is delivered.
    ...(config.RELAY_SMTP_HOST
      ? {
          smtp: {
            host: config.RELAY_SMTP_HOST,
            port: config.RELAY_SMTP_PORT,
            secure: config.RELAY_SMTP_SECURE,
            user: config.RELAY_SMTP_USER,
            password: config.RELAY_SMTP_PASSWORD,
          },
        }
      : {}),
    smtpFrom: config.RELAY_SMTP_FROM,
    ...(config.RELAY_CONSOLE_URL ? { consoleUrl: config.RELAY_CONSOLE_URL } : {}),
    notifyIntervalMs: config.RELAY_NOTIFY_INTERVAL_MS,
    cacheMaxBytes: config.RELAY_CACHE_MAX_BYTES,
    meteringQueueMax: config.RELAY_METERING_QUEUE_MAX,
    meteringFlushIntervalMs: config.RELAY_METERING_FLUSH_INTERVAL_MS,
    rollupIntervalMs: config.RELAY_ROLLUP_INTERVAL_MS,
    ...(logto ? { logto } : {}),
    ...(logtoM2m ? { logtoM2m } : {}),
  });

  // The CLI flips `warm` true after both ports listen, and false when a signal arrives — so a
  // draining worker reports not-ready (and the LB stops routing) before any connection is closed.
  const readiness: Readiness = { warm: false };

  const internalApp = Fastify({ logger: false });
  // Rate-limit the internal app (its /readyz probe touches the DB). The ceiling is generous so
  // orchestrator health probes and Prometheus scrapes are never throttled in practice.
  const internalRateLimit = { max: 6000, timeWindow: '1 minute' };
  await internalApp.register(rateLimit, internalRateLimit);
  // Liveness: the process is up. Never touches a dependency, so a slow DB never triggers a restart.
  internalApp.get('/healthz', () => ({ status: 'ok' }));
  // Readiness: safe to route traffic here. Gated on Postgres + Valkey reachable AND the worker being
  // warm (fully wired, not draining). The probe touches dependencies, so it carries a rate limit.
  internalApp.get('/readyz', { config: { rateLimit: internalRateLimit } }, async (_req, reply) => {
    const [pg, valkey] = await Promise.all([deps.db.ping(), deps.bus.ping()]);
    const ready = pg && valkey && readiness.warm;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      pg,
      valkey,
      warm: readiness.warm,
      version: RELAY_VERSION,
    });
  });
  internalApp.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  // Wait until in-flight requests finish (or the timeout elapses), so shutdown can let open SSE
  // streams complete before closing the server. Returns however many were still in flight at the cap.
  const getInflight = (publicApp as unknown as { inflight: () => number }).inflight;
  async function drain(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (getInflight() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return getInflight();
  }

  return { publicApp, internalApp, readiness, drain };
}
