/**
 * Mock upstream composition root (playbook §6). Deterministic OpenAI + Anthropic emulation for
 * bench + conformance — no live provider calls in CI. Emulates each provider's NATIVE wire format so
 * adapters are tested against real drift. Unknown routes return an OpenAI-style error envelope (a real
 * upstream never returns a bare framework 404), which keeps adapter error-handling realistic.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerOpenaiRoutes } from './routes/openai.routes.js';
import { registerAnthropicRoutes } from './routes/anthropic.routes.js';

export function buildMockLlm(): FastifyInstance {
  const app = Fastify({ logger: false });

  registerHealthRoutes(app);
  registerOpenaiRoutes(app);
  registerAnthropicRoutes(app);

  // OpenAI-shaped 404 so clients/adapters see a provider-like error, not a framework envelope.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: {
        message: `Unknown route ${req.method} ${req.url}`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    });
  });

  return app;
}
