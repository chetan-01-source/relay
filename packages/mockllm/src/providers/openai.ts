/**
 * OpenAI Chat Completions emulation — native wire format (playbook §6). Non-stream returns a
 * `chat.completion` with `usage`; stream emits `chat.completion.chunk` deltas + a final `usage`
 * chunk + `[DONE]`. Honors the failure/latency/token knobs.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { delay, LATENCY, numHeader, shouldError, words } from '../lib/knobs.js';
import { sse, sseHead } from '../lib/sse.js';
import type { ChatBody } from '../types/mockllm.types.js';

export async function openaiChat(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const errStatus = shouldError(req.headers['x-mock-error']);
  if (errStatus) {
    return reply
      .code(errStatus)
      .send({ error: { message: 'mock injected error', type: 'mock_error' } });
  }

  await delay(LATENCY);
  const body = (req.body ?? {}) as ChatBody;
  const toks = words(numHeader(req.headers['x-mock-tokens']));
  const model = body.model ?? 'gpt-4o-mock';
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: 12,
    completion_tokens: toks.length,
    total_tokens: 12 + toks.length,
  };

  if (!body.stream) {
    return reply.send({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: toks.join(' ') },
          finish_reason: 'stop',
        },
      ],
      usage,
    });
  }

  sseHead(reply);
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
    sse(reply, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    });

  chunk({ role: 'assistant' });
  for (const t of toks) {
    await delay(5);
    chunk({ content: `${t} ` });
  }
  sse(reply, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage,
  });
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
  return reply;
}
