/**
 * Anthropic Messages emulation — native typed-event stream (playbook §6). A DIFFERENT wire format
 * from OpenAI: non-stream returns `content[].text` + `usage.input/output_tokens`; stream emits typed
 * events (`message_start` → `content_block_delta`… → `message_stop`). Honors the same knobs.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { delay, LATENCY, numHeader, shouldError, words } from '../lib/knobs.js';
import { sseEvent, sseHead } from '../lib/sse.js';
import type { ChatBody } from '../types/mockllm.types.js';

export async function anthropicMessages(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const errStatus = shouldError(req.headers['x-mock-error']);
  if (errStatus) {
    return reply
      .code(errStatus)
      .send({ type: 'error', error: { type: 'mock_error', message: 'mock injected error' } });
  }

  await delay(LATENCY);
  const body = (req.body ?? {}) as ChatBody;
  const toks = words(numHeader(req.headers['x-mock-tokens']));
  const model = body.model ?? 'claude-mock';
  const id = `msg-mock-${Date.now()}`;

  if (!body.stream) {
    return reply.send({
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: toks.join(' ') }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: toks.length },
    });
  }

  sseHead(reply);
  sseEvent(reply, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      usage: { input_tokens: 12, output_tokens: 0 },
    },
  });
  sseEvent(reply, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (const t of toks) {
    await delay(5);
    sseEvent(reply, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: `${t} ` },
    });
  }
  sseEvent(reply, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseEvent(reply, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 12, output_tokens: toks.length },
  });
  sseEvent(reply, 'message_stop', { type: 'message_stop' });
  reply.raw.end();
  return reply;
}
