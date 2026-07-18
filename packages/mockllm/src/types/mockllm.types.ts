/** Shared types for the mock upstream. */

export interface ChatBody {
  model?: string;
  stream?: boolean;
  max_tokens?: number;
}
