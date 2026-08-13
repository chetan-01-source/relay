/**
 * The data plane: chat completions, streaming and non-streaming, with Relay's metadata attached.
 *
 * The SSE parser here is intentionally small — Relay emits OpenAI's exact wire format, so there is
 * one event shape to handle plus the `[DONE]` sentinel. Pulling in an SSE library for that would
 * cost a dependency and buy nothing.
 */
import type { Http } from './http.js';
import { parseMetadata, type RelayMetadata } from './metadata.js';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionParams,
  ChatCompletionStream,
  ModelObject,
} from './types.js';

export interface ChatRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function createChat(http: Http) {
  return {
    completions: {
      async create(
        params: ChatCompletionParams,
        options: ChatRequestOptions = {},
      ): Promise<ChatCompletion> {
        const { data, headers } = await http.json<Omit<ChatCompletion, 'relay'>>({
          method: 'POST',
          path: '/v1/chat/completions',
          body: { ...params, stream: false },
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
        });
        return { ...data, relay: parseMetadata(headers) };
      },

      async stream(
        params: ChatCompletionParams,
        options: ChatRequestOptions = {},
      ): Promise<ChatCompletionStream> {
        const controller = new AbortController();
        const signal = options.signal;
        if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

        // Awaited here so a pre-first-token failure (a tripped budget, an unreachable provider)
        // throws from `stream()` itself rather than from the first `for await` step — which is where
        // a caller's try/catch actually is.
        const response = await http.send({
          method: 'POST',
          path: '/v1/chat/completions',
          body: { ...params, stream: true },
          stream: true,
          signal: controller.signal,
          ...(options.headers ? { headers: options.headers } : {}),
        });

        return makeStream(response, controller);
      },
    },

    async models(options: ChatRequestOptions = {}): Promise<ModelObject[]> {
      const { data } = await http.json<{ data?: ModelObject[] }>({
        path: '/v1/models',
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return data.data ?? [];
    },
  };
}

/**
 * Wrap the response body as an async-iterable of chunks.
 *
 * Metadata resolves as soon as the headers are in — for a stream that is BEFORE the completion has
 * finished, so `costUsd` there reflects what the gateway knew at header time. That is the gateway's
 * documented behaviour, not a defect in the SDK, and the note is repeated in the README so nobody
 * builds billing on the streaming header.
 */
function makeStream(response: Response, controller: AbortController): ChatCompletionStream {
  const metadata: RelayMetadata = parseMetadata(response.headers);
  let accumulated = '';
  let finished: Promise<void> | undefined;

  async function* iterate(): AsyncGenerator<ChatCompletionChunk> {
    const body = response.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line. Anything after the last separator is a partial
        // event and stays in the buffer until the next read completes it.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const chunk = parseEvent(raw);
          if (chunk === 'done') return;
          if (chunk) {
            accumulated += chunk.choices[0]?.delta?.content ?? '';
            yield chunk;
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  const iterable: AsyncIterable<ChatCompletionChunk> = { [Symbol.asyncIterator]: iterate };

  return {
    [Symbol.asyncIterator]: iterate,
    relay: Promise.resolve(metadata),
    async text() {
      // Idempotent: calling text() after iterating returns what was already accumulated rather than
      // trying to re-read a consumed body.
      finished ??= (async () => {
        // The generator accumulates as it goes; this loop exists only to drive it to completion.
        for await (const chunk of iterable) void chunk;
      })();
      await finished;
      return accumulated;
    },
    abort() {
      controller.abort();
    },
  };
}

/** One SSE event → a chunk, the `[DONE]` sentinel, or null for a comment/keep-alive line. */
function parseEvent(raw: string): ChatCompletionChunk | 'done' | null {
  const dataLines = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('');
  if (payload === '[DONE]') return 'done';
  try {
    return JSON.parse(payload) as ChatCompletionChunk;
  } catch {
    // A malformed event is skipped rather than thrown: one bad frame must not kill a live stream.
    return null;
  }
}
