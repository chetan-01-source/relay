/**
 * OpenAI SDK conformance (Day 14, PRD §11) — the official `openai` Node SDK, unmodified, pointed at
 * the running gateway (→ mockllm). This is the drop-in promise under test: a real client should stream,
 * pass tools through, and surface our error envelope as its own typed errors, with zero gateway-specific
 * code. It talks to a LIVE stack, so it self-skips unless RELAY_CONFORMANCE_BASE_URL + _KEY are set
 * (conformance.yml boots the stack and seeds the key; locally: `make dev` then `make conformance`).
 *
 * Provider-SDK matrix note: Python SDK + LangChain + Vercel AI SDK are tracked follow-ons (heavy CI
 * deps) — see conformance.yml. The OpenAI wire format is the canonical surface, so it is covered first.
 */
import { describe, it, expect } from 'vitest';
import OpenAI, { APIError } from 'openai';

const baseURL = process.env.RELAY_CONFORMANCE_BASE_URL; // e.g. http://localhost:3000
const apiKey = process.env.RELAY_CONFORMANCE_KEY; // a real virtual key (rk_live_…)
const MODEL = process.env.RELAY_CONFORMANCE_MODEL ?? 'gpt-4o';

// The SDK appends `/chat/completions` etc. to baseURL, so it must end in the versioned prefix.
const client = new OpenAI({ baseURL: `${baseURL}/v1`, apiKey: apiKey ?? 'unset', maxRetries: 0 });

describe.skipIf(!baseURL || !apiKey)('openai SDK ↔ gateway', () => {
  it('non-streaming chat completion returns an OpenAI-shaped body', async () => {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.object).toBe('chat.completion');
    expect(res.choices[0]?.message.content).toBeTruthy();
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage?.total_tokens).toBeGreaterThanOrEqual(0);
  });

  it('streaming yields deltas that assemble into content and a final stop', async () => {
    const stream = await client.chat.completions.create({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    });
    let content = '';
    let sawStop = false;
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.choices[0]?.finish_reason === 'stop') sawStop = true;
    }
    expect(content.length).toBeGreaterThan(0);
    expect(sawStop).toBe(true);
  });

  it('passes a tools payload through without breaking the completion', async () => {
    // mockllm does not synthesize tool_calls, so this proves request-body passthrough + a valid
    // response — not tool selection. Tool-call emission is a mock capability tracked separately.
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'what is the weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });
    expect(res.choices[0]).toBeDefined();
  });

  it('surfaces a bad key as a 401 AuthenticationError with our error envelope', async () => {
    const bad = new OpenAI({
      baseURL: `${baseURL}/v1`,
      apiKey: 'rk_live_definitely_invalid',
      maxRetries: 0,
    });
    const err = await bad.chat.completions
      .create({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(401);
    expect((err as APIError).type).toBeTruthy(); // envelope's error.type reached the SDK
  });

  it('maps an unknown model to a 404 NotFoundError', async () => {
    const err = await client.chat.completions
      .create({ model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(404);
  });

  it('rejects a malformed request as a 400 BadRequestError', async () => {
    const err = await client.chat.completions
      // a message missing `content` violates the route schema (required: role + content)
      .create({ model: MODEL, messages: [{ role: 'user' } as never] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(400);
  });
});
