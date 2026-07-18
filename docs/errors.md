# Relay Gateway — Error Catalog

Every error the gateway returns comes from **one** source of truth: `packages/shared/src/errors.ts`
(`ERROR_CATALOG`). This page mirrors it. Regenerate/verify after changing the catalog.

## Wire format (OpenAI-compatible)

All errors — thrown `RelayError`, request-validation failures, and unexpected exceptions — return the
same envelope, so client SDKs handle them natively:

```json
{
  "error": {
    "message": "Missing or malformed virtual key.",
    "type": "authentication_error",
    "code": "invalid_api_key",
    "param": null
  }
}
```

- `code` — the stable, machine-readable Relay code (branch on this).
- `type` — OpenAI-style category (`authentication_error`, `rate_limit_error`, `api_error`, …).
- `param` — the offending field when applicable, else `null`.
- HTTP status is fixed per code (an upstream error may pass the provider's status through).

## Codes

| Code                        | HTTP | type                    | When                                                          |
| --------------------------- | ---- | ----------------------- | ------------------------------------------------------------- |
| `invalid_request`           | 400  | `invalid_request_error` | Malformed body / failed schema validation                     |
| `model_capability_mismatch` | 400  | `invalid_request_error` | No routed target supports the requested capability            |
| `invalid_api_key`           | 401  | `authentication_error`  | Missing or malformed virtual key                              |
| `key_revoked`               | 401  | `authentication_error`  | Virtual key was revoked                                       |
| `insufficient_scope`        | 403  | `permission_error`      | Key lacks the required scope                                  |
| `org_suspended`             | 403  | `permission_error`      | Organization is suspended                                     |
| `not_found`                 | 404  | `not_found_error`       | Unknown route / resource                                      |
| `model_not_found`           | 404  | `not_found_error`       | Model id does not exist                                       |
| `payload_too_large`         | 413  | `invalid_request_error` | Body exceeds the configured limit                             |
| `rate_limited`              | 429  | `rate_limit_error`      | Token-bucket rate limit exceeded                              |
| `budget_exceeded`           | 429  | `rate_limit_error`      | Org budget hard-cutoff reached                                |
| `upstream_error`            | 502* | `api_error`             | Upstream provider returned non-2xx (*status may pass through) |
| `upstream_unreachable`      | 502  | `api_error`             | Upstream provider could not be reached                        |
| `internal_error`            | 500  | `api_error`             | Unexpected exception (details logged, never returned)         |

## How it works

- Any layer signals an error by **throwing** `new RelayError('code', { message?, status?, param? })`.
- The server's central `setErrorHandler` / `setNotFoundHandler` (in `packages/server/src/app.ts`) call
  `toErrorEnvelope(err)` and send the envelope — controllers never build error responses by hand.
- Unknown exceptions become a safe `internal_error` (500); their details go to the logs, not the client.
- Adding a code = add one entry to `ERROR_CATALOG`, update this table, add a test. Nothing else.
