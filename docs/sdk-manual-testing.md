# Testing the SDK by hand, one step at a time

Eight scripts you run yourself, in order, against a real gateway. Each one adds a single capability
and shows you what "working" looks like — so when something breaks later you know exactly which
step stopped producing the output below.

**Every command and every output on this page was executed against a live gateway while writing
it.** Where a result looks surprising (a cache that never hits, a catalog with zero plans), the
reason is explained rather than tidied away.

|                                          |                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------ |
| This page                                | **Manual.** You run it, you read the output, you learn the surface |
| [sdk-e2e-testing.md](sdk-e2e-testing.md) | **Automated.** `make sdk-e2e`, 12 assertions, for CI               |

You do **not** need a deployed server. A gateway on `localhost` runs the same binary, migrations,
RLS policies and middleware as one behind a load balancer.

---

## 0. Set up the lab

Start a gateway and mint a real tenant:

```bash
cd /path/to/relay
make up          # Postgres, Valkey, Logto; migrations; seeds
make dev         # gateway :3000 · console :3100 · mock upstream :8080
make seed-demo   # writes .relay/seed-demo.key
```

Then a scratch project **outside** the repo, so you are testing the package as a consumer rather
than testing your working tree:

```bash
mkdir /tmp/sdk-lab && cd /tmp/sdk-lab
npm init -y
npm pkg set type=module

# From npm once published:
npm i relay-gateway-sdk
# Or from your local build, which is what you want pre-release:
#   (cd /path/to/relay/packages/sdk && npm pack --pack-destination /tmp/sdk-lab)
#   npm i ./relay-gateway-sdk-1.0.0.tgz

cp /path/to/relay/.relay/seed-demo.key ./key.txt
```

> `mockllm` is the default upstream on purpose. These scripts send real completions, and pointing
> them at a real provider means a real bill and a rate limit that is not yours to spend.

---

## 1. Connect

Proves the key resolves, the base URL is right, and the gateway answers.

```js
// 01-connect.mjs
import { Relay } from 'relay-gateway-sdk';
import { readFileSync } from 'node:fs';

const relay = new Relay({
  baseUrl: 'http://localhost:3000', // no /v1 — the SDK adds the paths
  apiKey: readFileSync('./key.txt', 'utf8').trim(),
});

const models = await relay.models();
console.log('models:', models.map((m) => m.id).join(', ') || '(none)');
```

```
models: claude-3-5-haiku, claude-3-5-sonnet, gpt-4o, gpt-4o-mini
```

These are **route aliases your key may call**, not a vendor's catalog. An empty list means no routes
are configured — build one in the console under **Build → Routes**.

---

## 2. A completion, and every metadata field

The reason this package exists. A stock OpenAI client gets the text; it cannot reach the rest without
digging through raw headers.

```js
// 02-completion.mjs
const res = await relay.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Say hello in five words.' }],
});

console.log('text      :', res.choices[0].message.content);
console.log('provider  :', res.relay.provider);
console.log('cached    :', res.relay.cached);
console.log('failover  :', res.relay.failover);
console.log('costUsd   :', res.relay.costUsd);
console.log('traceId   :', res.relay.traceId);
console.log('modalities:', res.relay.modalities);
console.log('plan      :', res.relay.plan);
console.log('rateLimit :', res.relay.rateLimit);
```

```
text      : Hello from the mock upstream — this is a streamed completion, token by token.
provider  : openai_compat
cached    : false
failover  : false
costUsd   : 0
traceId   : 68c9758f-d962-44b8-ad50-8f1533079e18
modalities: [ 'text' ]
plan      : self_hosted
rateLimit : { limitRequests: null, remainingRequests: null, limitTokens: null, remainingTokens: null }
```

What each field is telling you:

| Field       | Meaning                                                     | When it surprises you                                                               |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `provider`  | Which upstream actually served it                           | `openai_compat` here because `mockllm` is the target                                |
| `cached`    | Served from the exact-match cache                           | Always `false` until you enable the cache — [§5](#5-the-cache)                      |
| `failover`  | The first target was down and a lower-priority one answered | `false` on a healthy route                                                          |
| `costUsd`   | Settled cost, metered not estimated                         | `0` against `mockllm` — it has no rate card. Real providers give real numbers       |
| `traceId`   | Correlation id                                              | Paste it into the console's **Live traffic** to see this exact request              |
| `plan`      | Which plan the enforced ceilings came from                  | `self_hosted` = `RELAY_EDITION=oss`, everything unlimited                           |
| `rateLimit` | Remaining budget                                            | All `null` when no rate limit is configured — the gateway sends no headers to parse |

Every field is `null` (or `false`/`[]`) when the gateway did not report it. An older gateway with a
newer SDK degrades to `costUsd === null` — never to a throw, and never to a fabricated `0`.

**Check it end to end:** open `http://localhost:3100/traffic` and find that `traceId`. Same request,
same cost, same provider.

---

## 3. Streaming

```js
// 03-stream.mjs
const stream = await relay.chat.completions.stream({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Count to five.' }],
});

let chunks = 0;
process.stdout.write('tokens    : ');
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta.content;
  if (delta) {
    process.stdout.write(delta);
    chunks += 1;
  }
}
console.log(`\nchunk count: ${chunks}`);

const meta = await stream.relay; // resolves once the stream ends
console.log('provider  :', meta.provider);
console.log('traceId   :', meta.traceId);
```

```
tokens    : Hello from the mock upstream — this is a streamed completion, token by token.
chunk count: 14
provider  : openai_compat
traceId   : c46b4992-ccbe-4607-b583-a254bc28dc45
```

Two things to actually verify:

1. **It terminates.** If the loop hangs, the gateway never emitted `[DONE]`. That is a real bug — do
   not "fix" it by adding a timeout.
2. **`chunk count` > 1.** One chunk means you got a buffered response, not a stream.

`stream.relay` is a **promise** because cost is only known at the end. Reading it before the stream
finishes would give you a number that is wrong.

> **Do not bill on the streaming cost header.** Token usage arrives in the final SSE frame, _after_
> the response headers are sent, so `x-relay-cost-usd` on a stream reflects only what the gateway
> knew at header time. The settled cost lands on the metered usage event and the analytics rollups.

`await stream.text()` gives you the whole string if you did not want the loop.

---

## 4. Errors

Failures should be typed and specific, never a generic 500.

```js
// 04-errors.mjs
import { Relay, RelayApiError } from 'relay-gateway-sdk';

async function expectError(label, fn) {
  try {
    await fn();
    console.log(`${label.padEnd(22)} NO ERROR  <-- unexpected`);
  } catch (err) {
    if (err instanceof RelayApiError)
      console.log(`${label.padEnd(22)} ${String(err.status).padEnd(4)} ${err.code}`);
    else console.log(`${label.padEnd(22)} non-RelayApiError: ${err.constructor.name}`);
  }
}

await expectError('unknown model', () =>
  new Relay({ baseUrl: base, apiKey: key }).chat.completions.create({
    model: 'no-such-alias',
    messages: [{ role: 'user', content: 'x' }],
  }),
);

await expectError('bad key', () =>
  new Relay({ baseUrl: base, apiKey: 'rk_live_nope.nope' }).chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'x' }],
  }),
);

await expectError('virtual key on /api', () =>
  new Relay({ baseUrl: base, apiKey: key }).admin(key).apps.list(),
);
```

```
unknown model          404  model_not_found
bad key                401  invalid_api_key
virtual key on /api    401  invalid_api_key
```

The third one is the one worth caring about. It proves the **two auth planes do not cross**: a
data-plane virtual key handed to a control-plane endpoint is an authentication failure, never an
accidental grant. That is [ADR-0002](adr/0002-two-auth-planes.md)'s core guarantee, and it is the
kind of thing that quietly regresses.

Codes you will meet in production: `budget_exceeded`, `rate_limited` (with `err.retryAfterSeconds`),
`quota_exceeded` (with `err.param` naming the quota), `plan_upgrade_required`. Every error carries
`err.traceId` — correlate it in the console.

---

## 5. The cache

```js
// 05-cache.mjs
const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'cache probe 42' }] };
for (const label of ['first ', 'second']) {
  const t0 = Date.now();
  const res = await relay.chat.completions.create(body);
  console.log(
    `${label}: cached=${res.relay.cached} ${Date.now() - t0}ms cost=${res.relay.costUsd}`,
  );
}
```

```
first : cached=false 73ms  cost=0
second: cached=false 50ms  cost=0
```

**`cached=false` twice is correct out of the box** — the exact cache ships **off**
(`RELAY_CACHE_TTL_S=0`). It is opt-in because caching completions is a product decision, not a
default anyone should inherit silently.

To see it work, set `RELAY_CACHE_TTL_S=60` in `deploy/compose/.env`, restart, and re-run. The second
call becomes `cached=true` in about a millisecond, at `cost=0`.

---

## 6. Timeouts and unreachable hosts

Both must fail fast and typed, never hang.

```js
// 06-control.mjs
import { Relay, RelayConnectionError } from 'relay-gateway-sdk';

try {
  await new Relay({
    baseUrl: 'http://localhost:3000',
    apiKey: key,
    timeoutMs: 1,
  }).chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
} catch (err) {
  console.log('timeout    :', err.constructor.name);
}

try {
  await new Relay({ baseUrl: 'http://127.0.0.1:59999', apiKey: key, timeoutMs: 2000 }).models();
} catch (err) {
  console.log('unreachable:', err.constructor.name);
}
```

```
timeout    : RelayConnectionError
unreachable: RelayConnectionError
```

`RelayConnectionError` means the request never got a reply — distinct from `RelayApiError`, which
means the gateway answered and said no. Retry the first; do not blindly retry the second.

---

## 7. The control plane

A different credential: a **Logto access token**, not a virtual key. Get one by signing in to the
console at `localhost:3100` and copying the bearer token the browser sends on any `/api/v1/*`
request (DevTools → Network → any `/api/v1/` call → Request Headers → `authorization`).

> **Cannot sign in to get the token?** If the callback fails, the console now says why. The usual
> cause is opening it on a LAN IP (`http://192.168.1.4:3100`) while `LOGTO_BASE_URL` still says
> `localhost` — the sign-in cookie is set on one origin and the callback lands on the other, so the
> browser never sends it. Open the console at whatever `LOGTO_BASE_URL` names, or change both that
> variable _and_ the redirect URI on the Logto application. Retrying a failed callback URL never
> works either: an authorization code is single-use, so start again from the home page.

First, without a token, confirm every path is actually wired:

```js
// 07-admin-routing.mjs
const admin = new Relay({ baseUrl: 'http://localhost:3000', apiKey: 'rk_live_a.b' }).admin(
  'not-a-real-jwt',
);
// 401 = reached and rejected. 404 would mean the SDK is calling a path that does not exist.
```

```
me                 401 reached + rejected OK
apps.list          401 reached + rejected OK
providers.list     401 reached + rejected OK
routes.list        401 reached + rejected OK
budgets.list       401 reached + rejected OK
analytics.usage    401 reached + rejected OK
traffic.list       401 reached + rejected OK
audit.list         401 reached + rejected OK
plan.get           401 reached + rejected OK
plan.catalog       200 public, 0 plans
```

`plan.catalog` is public and returns **0 plans** — correct under `RELAY_EDITION=oss`, where nothing
is for sale. It fills in only on a `cloud` deployment.

Now with a real token, the flow that matters — provisioning an isolated, budgeted tenant:

```js
// 07b-provision.mjs
const admin = relay.admin(process.env.RELAY_ADMIN_TOKEN);

const me = await admin.me();
console.log('org:', me.org_id);

const app = await admin.apps.create({ name: `lab-${Date.now()}` });
console.log('app:', app.id);

// snake_case — the input type is projected straight from the OpenAPI body
await admin.budgets.setForApp(app.id, 'monthly', { limit_usd: 5, hard_cutoff: true });

const issued = await admin.apps.keys.issue(app.id, { environment: 'test' });
console.log('key:', issued.key); // shown ONCE — Relay stores a verifier, not the secret

const plan = await admin.plan.get();
console.log('plan:', plan.plan.code, plan.limits['apps.max']);
```

Then prove the new key works, which closes the loop between the two planes:

```js
const tenant = new Relay({ baseUrl: 'http://localhost:3000', apiKey: issued.key });
console.log(await tenant.models());
```

> These calls **create real rows**. Point them at a scratch organization, and name things obviously
> disposable — the automated suite uses an `e2e-sdk-<timestamp>` prefix for exactly this reason.

Full surface: `me` · `apps` (+`apps.keys`: `list`/`issue`/`rotate`/`revoke`) · `providers` ·
`routes` (+`createVersion`/`activateVersion`) · `budgets` (+`setForApp`/`removeForApp`) ·
`analytics.usage` · `traffic` · `audit` (+`verify`) · `plan` (+`catalog`/`change`).

---

## 8. Guards and conveniences

```js
// 08-guards.mjs
globalThis.window = {};
globalThis.document = {}; // pretend to be a browser
try {
  new Relay({ baseUrl, apiKey });
} catch (e) {
  console.log('browser guard :', e.message);
}
new Relay({ baseUrl, apiKey, dangerouslyAllowBrowser: true }); // explicit opt-in

process.env.RELAY_BASE_URL = 'http://localhost:3000';
process.env.RELAY_API_KEY = key;
const fromEnv = Relay.fromEnv();
```

```
browser guard : A Relay virtual key must not be shipped to the browser: anyone can read …
with opt-in   : constructed OK
fromEnv       : 4 models
retry option  : 4 models
```

A virtual key is a server-side credential — anything shipped to a browser is readable by every
visitor and spendable against your providers. The guard is a constructor throw, not a lint rule, so
it cannot be ignored by accident.

**Retries** are off by default. `retry: { attempts: 3 }` retries only `429`/`502`/`503`, honours
`retry-after`, and **never** re-sends a request that has already streamed a byte — retrying a
partially-consumed completion bills you twice for one answer.

---

## Checklist

- [ ] §1 `models()` lists your route aliases
- [ ] §2 completion returns text **and** `provider`, `costUsd`, `traceId`, `plan`
- [ ] §2 that `traceId` appears in the console's Live traffic
- [ ] §3 stream terminates on its own, more than one chunk, `stream.relay` resolves
- [ ] §4 all three errors are `RelayApiError` with the right status — especially the virtual key rejected on `/api/*`
- [ ] §5 `cached=false` off by default; `cached=true` after enabling the TTL
- [ ] §6 timeout and unreachable host both raise `RelayConnectionError` fast
- [ ] §7 every admin path answers 401 with a bogus token (never 404)
- [ ] §7 with a real token: create app → set budget → issue key → the new key completes a request
- [ ] §8 browser guard throws; `dangerouslyAllowBrowser` opts out; `fromEnv()` works

## When something fails

| Symptom                              | Cause                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `models()` returns `(none)`          | No routes configured. Console → **Build → Routes**                                                                   |
| `404 model_not_found`                | The alias is not a route on this gateway                                                                             |
| `401 invalid_api_key`                | Key revoked, or minted under a different `RELAY_MASTER_KEY`. Re-run `make seed-demo`                                 |
| `502 upstream_unreachable`           | No provider credential, or `RELAY_UPSTREAM_URL` points nowhere                                                       |
| Stream hangs                         | The gateway is not terminating the SSE stream. A real bug — do not paper over it with a timeout                      |
| Admin call returns **404** not 401   | The SDK is calling a path that does not exist — a routing regression                                                 |
| Admin 401 with a real token          | The token is not scoped to an organization; Logto only sets `organization_id` on an org-scoped grant                 |
| Console sign-in fails at `/callback` | Origin mismatch between the browser and `LOGTO_BASE_URL`, or a reused authorization code. The error page names which |
