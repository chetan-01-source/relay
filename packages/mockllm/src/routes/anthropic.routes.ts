import type { FastifyInstance } from 'fastify';
import { anthropicMessages } from '../providers/anthropic.js';

export function registerAnthropicRoutes(app: FastifyInstance): void {
  app.post('/v1/messages', (req, reply) => anthropicMessages(req, reply));
}
