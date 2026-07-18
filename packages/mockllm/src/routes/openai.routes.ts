import type { FastifyInstance } from 'fastify';
import { openaiChat } from '../providers/openai.js';

export function registerOpenaiRoutes(app: FastifyInstance): void {
  app.post('/v1/chat/completions', (req, reply) => openaiChat(req, reply));
}
