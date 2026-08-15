# SDK end-to-end testing

How to prove `relay-gateway-sdk` works against a **real** gateway, not a mock — and what each layer of the
test suite is actually responsible for.

---

## 1. Two suites, two jobs

| Suite    | File                                 | Proves                                                                                                                                              | Needs                    |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Unit** | `packages/sdk/src/tests/sdk.test.ts` | The SDK's own behaviour: header parsing, retry policy, error mapping, SSE reassembly, the browser guard                                             | nothing — a fake `fetch` |
| **E2E**  | `packages/sdk/src/tests/e2e.test.ts` | The **wire contract** still holds: the gateway really sends `x-relay-*`, a stream really ends, a virtual key really is refused on the control plane | a running gateway        |

The split matters. A fake `fetch` always closes its stream, always sends the headers the test author
remembered, and always returns the status the test author chose — so it can never catch the gateway
dropping a header, or an SSE stream that never emits `[DONE]`. Those are precisely the failures that
only show up in production, which is why they are tested against the real thing.

The E2E suite **self-skips** when its environment is absent, the same way the server's integration
tests skip without `RELAY_TEST_DATABASE_URL`. A contributor with no stack running gets a green run;
CI sets the variables and gets real coverage. It reports as _skipped_, never as _passed_ — nobody
should be able to mistake "not run" for "fine".

> **Learning the surface rather than gating a release?**
> [sdk-manual-testing.md](sdk-manual-testing.md) walks the same ground in eight scripts you run by
> hand, with the real output of each printed alongside.

---

## 2. Running it

### 2.1 Start a gateway

```bash
make up          # postgres + valkey + logto, migrations, seeds
make dev         # gateway on :3000, console on :3100
```

### 2.2 Get a virtual key

```bash
make seed-demo   # writes .relay/seed-demo.key (gitignored)
```

### 2.3 Run

```bash
make sdk-e2e
```

which is exactly:

```bash
RELAY_E2E_BASE_URL=http://localhost:3000 \
RELAY_E2E_API_KEY="$(cat .relay/seed-demo.key)" \
RELAY_E2E_MODEL=gpt-4o \
pnpm --filter relay-gateway-sdk exec vitest run src/tests/e2e.test.ts
```

Expected — the control-plane block skips until you supply a token (§2.4):

```
✓ src/tests/e2e.test.ts (12 tests | 6 skipped)
  Tests  6 passed | 6 skipped (12)
```

### 2.4 Add the control plane

The control plane needs a **Logto access token** for the Relay API resource, scoped to an
organization. The easiest source is the console: sign in, then copy the bearer token the browser
sends on any `/api/v1/*` request.

```bash
RELAY_E2E_ADMIN_TOKEN="eyJhbGciOi…" \
RELAY_E2E_BASE_URL=… RELAY_E2E_API_KEY=… \
pnpm --filter relay-gateway-sdk exec vitest run src/tests/e2e.test.ts
```

### Variables

| Variable                | Required | Meaning                                                                                      |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `RELAY_E2E_BASE_URL`    | yes      | Gateway root, no `/v1` suffix                                                                |
| `RELAY_E2E_API_KEY`     | yes      | A virtual key, `rk_live_…` / `rk_test_…`                                                     |
| `RELAY_E2E_MODEL`       | no       | Route alias to call. Default `gpt-4o-mini` — set it to an alias your gateway actually routes |
| `RELAY_E2E_ADMIN_TOKEN` | no       | Logto access token; enables the control-plane block                                          |

---

## 3. What it asserts, and why

### Data plane

| Test                                          | Catches                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completes a chat request and reports metadata | The gateway silently dropping `x-relay-cost-usd` / `-provider` / `-trace-id`. The completion would still be valid, so only an explicit assertion notices    |
| Streams and reassembles                       | An SSE stream that never emits `[DONE]` — the test would hang, which a fake stream can never reproduce because it always closes                             |
| Lists models                                  | `/v1/models` shape drift                                                                                                                                    |
| Unknown model → typed error                   | A routing miss surfacing as a 500 instead of a 4xx                                                                                                          |
| Bad key → 401                                 | Auth failures leaking as 500s, and the SDK mapping a bodyless error correctly                                                                               |
| Virtual key refused on `/api/*`               | [ADR-0002](adr/0002-two-auth-planes.md)'s guarantee. Asserted rather than assumed — a data-plane credential must never be an accidental control-plane grant |

### Control plane

| Test                                      | Catches                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| Resolves identity                         | Token → organization mapping broken                         |
| Reads the effective plan with provenance  | The plan payload losing `source`, which the console renders |
| Lists apps / providers / routes / budgets | Envelope drift (`{object, data}` → bare array)              |
| Round-trips an app and issues a key       | The **one-time key reveal** silently returning nothing      |
| Reports usage                             | Analytics window handling                                   |
| Verifies the audit chain                  | A genuine integrity break — never a flake                   |

### What it deliberately does not assert

**Completion text.** The model's answer is the provider's business and differs every run; asserting
on it would make the suite flaky for a reason that has nothing to do with Relay. Every assertion here
is about **shape** — the field exists, the type is right, the status is in range.

---

## 4. Test data hygiene

The control-plane block **creates real rows** in whatever organization the token names. It is
therefore written to be obvious about it:

- Applications are named `e2e-sdk-<timestamp>` with a description saying they are safe to delete, so
  a failed run leaves something plainly disposable rather than a plausible-looking tenant resource.
- Keys are issued in the `test` environment.
- Nothing is deleted on teardown **on purpose**: a teardown that runs on failure destroys the
  evidence you need to debug the failure.

Point it at a scratch organization, not a customer's. Clean up with:

```sql
DELETE FROM applications WHERE org_id = '<org>' AND name LIKE 'e2e-sdk-%';
```

---

## 5. In CI

The suite is safe to leave in the default `pnpm test` run — it skips without configuration. To make
it actually run, bring a stack up in the job and export the two variables:

```yaml
- name: SDK end-to-end
  env:
    RELAY_E2E_BASE_URL: http://localhost:3000
    RELAY_E2E_MODEL: gpt-4o
  run: |
    make up
    pnpm --filter relay-server exec tsx src/cli/index.ts seed-demo
    RELAY_E2E_API_KEY="$(cat .relay/seed-demo.key)" \
      pnpm --filter relay-gateway-sdk exec vitest run src/tests/e2e.test.ts
```

Point `RELAY_UPSTREAM_URL` at the bundled `mockllm` container rather than a real provider: the suite
sends completions, and a real provider means a real bill and a rate limit that is not yours to spend.

---

## 6. Testing the SDK against a release before publishing

Catches the packaging failures a source-tree test cannot — a missing export map entry, a type that
does not resolve under `moduleResolution: node16`, a `dist` that was never rebuilt.

```bash
pnpm --filter relay-gateway-sdk build
cd packages/sdk && npm pack          # → relay-sdk-0.2.0.tgz

mkdir /tmp/sdk-smoke && cd /tmp/sdk-smoke && npm init -y
npm i /path/to/relay-sdk-0.2.0.tgz

node --input-type=module -e "
  import { Relay } from 'relay-gateway-sdk';
  const relay = new Relay({ baseUrl: process.env.RELAY_E2E_BASE_URL, apiKey: process.env.RELAY_E2E_API_KEY });
  const res = await relay.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'ok' }] });
  console.log(res.relay);
"
```

Repeat with `require()` to prove the CJS build, and with `tsc --noEmit` in a strict project to prove
the types.

---

## 7. Troubleshooting

| Symptom                    | Cause                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Whole suite skipped        | `RELAY_E2E_BASE_URL` or `RELAY_E2E_API_KEY` unset. That is the designed behaviour, not a failure                      |
| `401 invalid_api_key`      | Key revoked, or from a different `RELAY_MASTER_KEY` than the gateway is running with. Re-run `make seed-demo`         |
| `404 model_not_found`      | `RELAY_E2E_MODEL` is not a route alias on this gateway. Check **Build → Routes**                                      |
| `502 upstream_unreachable` | No provider credential, or `RELAY_UPSTREAM_URL` points nowhere. Point it at `mockllm` for tests                       |
| Streaming test hangs       | The gateway is not terminating the SSE stream. This is the bug this test exists to find — do not increase the timeout |
| Control-plane tests 401    | The admin token is not scoped to an organization. Logto only sets `organization_id` on an org-scoped grant            |
