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
import { RelayError, toErrorEnvelope } from '@relay/shared';
import type { Config } from './platform/config.js';
import type { Database, Queryable } from './platform/db.js';
import type { EventBus } from './platform/eventbus.js';
import { registry } from './platform/metrics.js';
import { registerProxy } from './modules/proxy/index.js';
import { registerModels } from './modules/models/index.js';

export interface AppDeps {
  db: Database;
  bus: EventBus;
}

export interface Servers {
  publicApp: FastifyInstance;
  internalApp: FastifyInstance;
}

export interface PublicAppDeps {
  db: Queryable;
  upstreamUrl: string;
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

  registerProxy(app, { upstreamUrl: deps.upstreamUrl });
  registerModels(app, { db: deps.db });

  // machine-readable spec next to the human UI at /docs
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  return app;
}

export async function buildServers(config: Config, deps: AppDeps): Promise<Servers> {
  const publicApp = await buildPublicApp({ db: deps.db, upstreamUrl: config.RELAY_UPSTREAM_URL });

  const internalApp = Fastify({ logger: false });
  internalApp.get('/healthz', () => ({ status: 'ok' }));
  internalApp.get('/readyz', async (_req, reply) => {
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
