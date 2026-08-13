# Relay Gateway — Postman collection

Two generated files, both produced by [`scripts/gen-postman.mjs`](../../scripts/gen-postman.mjs) from
[`api/openapi/openapi.json`](../openapi/openapi.json):

| File                                    | What it is                                                   |
| --------------------------------------- | ------------------------------------------------------------ |
| `relay-gateway.postman_collection.json` | Every endpoint, foldered by OpenAPI tag, with example bodies |
| `relay-local.postman_environment.json`  | Local-stack variables (`baseUrl`, tokens, model)             |

**Do not edit either by hand.** The chain is `Fastify route schema → OpenAPI → Postman`, so the
collection cannot drift from the server. Regenerate after any route-schema change:

```bash
make generate          # spec + typed console client + this collection
# or just the collection, when the spec is already current:
pnpm run gen:postman
```

## Import and run

1. Postman → **Import** → drop both files in.
2. Select the **Relay — local** environment.
3. Start the stack: `make dev` (gateway on `:3000`, ops listener on `:9090`).

## Auth model — three surfaces, three credentials

| Surface                           | Credential                        | Where it comes from                                               |
| --------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Control plane `/api/v1/*`         | Logto bearer — `{{access_token}}` | A Logto access token for the `https://relay.gateway/api` resource |
| Data plane `/v1/chat/completions` | Virtual key — `{{virtual_key}}`   | Captured automatically when you issue a key (below)               |
| Model discovery `/v1/models`      | none                              | Unauthenticated by design                                         |

The collection default is the Logto bearer; the two exceptions are set per-request, so you never have
to remember which is which.

## The chained happy path

Requests write ids back into collection variables, so running the folders in order works end to end
with no copy-paste:

```
providers → POST /api/v1/providers          ⇒ {{provider_id}}
apps      → POST /api/v1/apps               ⇒ {{app_id}}
apps      → POST /api/v1/apps/{appId}/keys  ⇒ {{key_id}} + {{virtual_key}}   ← plaintext, returned once
routes    → POST /api/v1/routes             ⇒ {{route_id}}
routes    → GET  /api/v1/routes/{routeId}   ⇒ {{route_version_id}}
chat      → POST /v1/chat/completions       (uses {{virtual_key}} + {{model}})
traffic   → GET  /api/v1/traffic            ⇒ {{request_id}}
```

Set `{{provider_api_key}}` (your real upstream key) before creating a provider, and `{{model}}` to the
client-facing model name your route exposes.

Every request also carries a shared assertion that the gateway did not return 5xx — so a Collection
Runner pass doubles as a coarse smoke test.

## `internal` folder

`/healthz`, `/readyz` and `/metrics` live on the ops listener (`{{internalUrl}}`, default `:9090`) and
are deliberately absent from the public OpenAPI spec — they are added by the generator. Never expose
that port publicly.
