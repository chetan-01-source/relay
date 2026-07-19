/**
 * Proxy routes (playbook §5) — HTTP surface only: bind paths to controller handlers.
 * The `schema` block feeds @fastify/swagger. Body validation is intentionally permissive
 * (OpenAI clients send many optional fields); only model + messages are required.
 */
import type { FastifyInstance } from 'fastify';
import type { ProxyController } from '../controllers/proxy.controller.js';
import type { ProxyPreHandler } from '../types/proxy.types.js';

const chatCompletionSchema = {
  tags: ['chat'],
  summary: 'Create a chat completion (streaming or non-streaming)',
  description:
    'OpenAI-compatible. Requires a virtual key: `Authorization: Bearer rk_live_…`. ' +
    'With `stream:true` the response is an SSE stream of `chat.completion.chunk` events.',
  body: {
    type: 'object',
    required: ['model', 'messages'],
    properties: {
      model: { type: 'string' },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: { type: 'string' },
          },
        },
      },
      stream: { type: 'boolean' },
      max_tokens: { type: 'integer' },
      temperature: { type: 'number' },
    },
  },
  response: {
    200: {
      description: 'A chat.completion object, or an SSE stream when stream=true.',
      type: 'object',
      additionalProperties: true,
    },
  },
};

export function registerProxyRoutes(
  app: FastifyInstance,
  controller: ProxyController,
  authVirtualKey?: ProxyPreHandler,
): void {
  app.post(
    '/v1/chat/completions',
    {
      schema: chatCompletionSchema,
      ...(authVirtualKey ? { preHandler: authVirtualKey } : {}),
    },
    (request, reply) => controller.chatCompletions(request, reply),
  );
}
