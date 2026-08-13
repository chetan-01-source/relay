/**
 * The OpenAI chat shapes the SDK speaks, plus the Relay-specific fields it adds.
 *
 * Only the fields Relay actually mediates are typed here. The gateway forwards anything else in the
 * body untouched, and `[key: string]: unknown` on the request keeps a newer OpenAI parameter usable
 * without an SDK release. If you want the full, exhaustively-typed OpenAI surface, use the `openai`
 * package pointed at your Relay base URL — that path stays first-class.
 */
import type { RelayMetadata } from './metadata.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
  name?: string;
}

export interface ChatCompletionParams {
  /** Your route alias (`fast`, `cheap`) or a model name — Relay resolves it to a real target. */
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  /** Not settable here: use `chat.completions.stream()`, which types the result correctly. */
  stream?: never;
  [key: string]: unknown;
}

export interface ChatChoice {
  index: number;
  message: { role: 'assistant'; content: string };
  finish_reason: string | null;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
  /** Relay's own metadata, parsed from the `x-relay-*` response headers. */
  relay: RelayMetadata;
}

export interface ChatChunkChoice {
  index: number;
  delta: { role?: 'assistant'; content?: string };
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: ChatUsage;
}

/**
 * A stream of chunks that also resolves its metadata.
 *
 * `relay` is a promise, not a field, because cost is only known once the stream ends. Making that
 * explicit beats a mutable property that is silently wrong if read too early.
 */
export interface ChatCompletionStream extends AsyncIterable<ChatCompletionChunk> {
  relay: Promise<RelayMetadata>;
  /** Accumulated assistant text once the stream is done. Resolves with the same value `for await` produced. */
  text(): Promise<string>;
  /** Stop consuming and release the underlying connection. */
  abort(): void;
}

export interface ModelObject {
  id: string;
  object: 'model';
  owned_by?: string;
  [key: string]: unknown;
}
