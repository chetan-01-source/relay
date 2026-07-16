import Fastify from 'fastify';

/**
 * OpenAI-compatible mock provider. Latency/error/stream knobs land sprint Day 4.
 * Deterministic upstream for bench + conformance (no live provider calls in CI).
 */
export function buildMockLlm() {
  const app = Fastify({ logger: false });

  app.get('/healthz', () => ({ status: 'ok' }));

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  buildMockLlm()
    .listen({ port, host: '0.0.0.0' })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
