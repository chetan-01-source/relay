/**
 * Playground proxy. The data plane authenticates with a **virtual key**, not the Logto session, so
 * the console cannot call `/v1/chat/completions` on the user's behalf — the user supplies a key. This
 * same-origin handler forwards that key server-side, which means: the browser never makes a
 * cross-origin request (no CORS allowance to widen on the gateway), and the key is not exposed to
 * any third-party origin.
 *
 * The session gate matters: without it this route would be an unauthenticated open proxy to the
 * gateway for anyone who could reach the console.
 *
 * The key is used for exactly one upstream call and is never logged, cached or persisted.
 */
import { chatCompletion, type ChatCompletionInput } from '../../lib/api';
import { requireOrg } from '../../lib/auth';

export const dynamic = 'force-dynamic';

interface PlaygroundRequest {
  key?: unknown;
  model?: unknown;
  system?: unknown;
  prompt?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
}

function bad(message: string): Response {
  return Response.json({ error: { message } }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  await requireOrg();

  let payload: PlaygroundRequest;
  try {
    payload = (await request.json()) as PlaygroundRequest;
  } catch {
    return bad('Request body must be JSON.');
  }

  const key = typeof payload.key === 'string' ? payload.key.trim() : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!key) return bad('A virtual key is required.');
  if (!model) return bad('A model is required.');
  if (!prompt) return bad('A prompt is required.');

  const system = typeof payload.system === 'string' ? payload.system.trim() : '';
  const messages: ChatCompletionInput['messages'] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    { role: 'user' as const, content: prompt },
  ];

  const maxTokens = Number(payload.maxTokens);
  const temperature = Number(payload.temperature);
  const input: ChatCompletionInput = {
    model,
    messages,
    // Streaming is deliberately not offered here: the value of this screen is the settled
    // `x-relay-cost-usd`, which a streamed response can only report as 0 at header time.
    stream: false,
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { max_tokens: Math.trunc(maxTokens) } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
  };

  try {
    const result = await chatCompletion(key, input);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json(
      { error: { message: 'The gateway is unreachable from the console.' } },
      { status: 502 },
    );
  }
}
