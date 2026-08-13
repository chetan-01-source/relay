# `relay-gateway-sdk`

TypeScript client for a [Relay Gateway](https://github.com/chetan-01-source/relay). Zero runtime
dependencies. Runs on Node 18+, Bun, Deno, Cloudflare Workers and in browsers.

> Relay speaks the OpenAI Chat Completions API, so the official `openai` SDK already works against it
> with two lines changed. Use **this** package when you want Relay's per-request metadata as typed
> fields, or when you want to drive the control plane from code.

```bash
npm i relay-gateway-sdk
```

## Chat, with the metadata

```ts
import { Relay } from 'relay-gateway-sdk';

const relay = new Relay({
  baseUrl: 'https://relay.acme.internal',
  apiKey: process.env.RELAY_API_KEY!, // rk_live_…
});

const res = await relay.chat.completions.create({
  model: 'fast', // your alias, not a vendor's
  messages: [{ role: 'user', content: 'hello' }],
});

res.choices[0].message.content;
res.relay.provider; // 'anthropic' — which upstream actually served it
res.relay.costUsd; // 0.000412  — metered, not estimated
res.relay.cached; // false
res.relay.failover; // true if the first target was down
res.relay.traceId; // '8f2c…'   — the id the console's traffic view is keyed on
res.relay.plan; // 'pro'
res.relay.rateLimit.remainingRequests; // 599
```

Every field of `res.relay` is `null` when the gateway did not report it. An older gateway with a
newer SDK degrades to `costUsd === null` — never to a throw, and never to a fabricated `0`.

## Streaming

```ts
const stream = await relay.chat.completions.stream({ model: 'fast', messages });

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}

const meta = await stream.relay;
```

Or, if you only want the finished text: `await stream.text()`.

A failure **before the first token** — a tripped budget, an unreachable provider — throws from
`stream()` itself, which is where your `try/catch` actually is. Failures mid-stream end the stream.

> **Streaming cost caveat.** Token usage arrives in the final SSE frame, _after_ the response headers
> are sent, so `x-relay-cost-usd` on a stream reflects only what the gateway knew at header time
> (often `0.000000`). The settled cost always lands on the metered usage event and the analytics
> rollups. Do not build billing on the streaming header.

## Errors

```ts
import { RelayApiError } from 'relay-gateway-sdk';

try {
  await relay.chat.completions.create({ model: 'fast', messages });
} catch (err) {
  if (err instanceof RelayApiError) {
    switch (err.code) {
      case 'budget_exceeded': // the org's spend ceiling is reached
        break;
      case 'rate_limited': // err.retryAfterSeconds
        break;
      case 'quota_exceeded': // err.param names the plan quota, e.g. 'apps.max'
        break;
      case 'plan_upgrade_required': // err.param names the capability
        break;
    }
    console.error(err.traceId); // correlate with the console's traffic view
  }
}
```

## Retries

Off by default. When enabled, only `429`/`502`/`503` are retried, `retry-after` is honoured, and a
request that has already streamed a byte is **never** re-sent — retrying a partially-consumed
completion bills you twice for one answer.

```ts
new Relay({ baseUrl, apiKey, retry: { attempts: 3 } });
```

## Control plane

Authenticated with a Logto access token, not a virtual key — a separate client on purpose, so an
admin token cannot end up in code that only needed to send a completion.

```ts
const admin = relay.admin(await getLogtoAccessToken());

const app = await admin.apps.create({ name: 'checkout-service' });
const key = await admin.apps.keys.issue(app.id, { environment: 'live' });
key.key; // rk_live_… — returned ONCE; Relay stores a verifier, not the secret

await admin.budgets.setForApp(app.id, 'monthly', { limit_usd: 200, hard_cutoff: true });

const plan = await admin.plan.get();
plan.limits['apps.max']; // { value: 10, source: 'plan', used: 4 }
```

Available: `me` · `apps` (+ `apps.keys`) · `providers` · `routes` · `budgets` · `analytics` ·
`traffic` · `audit` · `plan`.

Every request and response type is projected out of the gateway's own OpenAPI document
(`pnpm gen:api`), so the client cannot drift from the server.

## Options

| Option                    | Default | Notes                                                    |
| ------------------------- | ------- | -------------------------------------------------------- |
| `baseUrl`                 | —       | No trailing `/v1`; the SDK adds the paths.               |
| `apiKey`                  | —       | A virtual key, `rk_live_…` / `rk_test_…`.                |
| `timeoutMs`               | 120 000 | Completions are legitimately slow.                       |
| `retry`                   | off     | `{ attempts, baseDelayMs, maxDelayMs }`.                 |
| `headers`                 | —       | Merged into every request; per-call headers win.         |
| `fetch`                   | global  | For proxies, instrumentation and tests.                  |
| `dangerouslyAllowBrowser` | `false` | Constructing in a browser throws without it — see below. |

`Relay.fromEnv()` reads `RELAY_BASE_URL` and `RELAY_API_KEY`.

### Why the browser guard

A virtual key is a server-side credential: anything shipped to a browser is readable by every visitor
and can be spent against your providers. Call Relay from your server. If a key genuinely is public —
a demo, a key under a budget you are content to lose — pass `dangerouslyAllowBrowser: true`.

## Versioning

The SDK's minor tracks the gateway's (`0.2.x` SDK ↔ `0.2.x` gateway); patches are independent. The
client sends `x-relay-sdk: ts/<version>` so a deployment can see its client-version spread, and
tolerates unknown response fields and missing headers in both directions.

## Licence

Apache-2.0.
