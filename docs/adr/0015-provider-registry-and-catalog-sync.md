# ADR-0015 — One provider registry, and a catalog synced from the providers

Status: accepted · Supersedes the hard-coded provider list in ADR-0005/0006

## Context

Phase 1 shipped three providers — `openai`, `anthropic`, `openai_compat` — and the list was written
out by hand in four places that had no way of noticing when they disagreed:

1. the proxy's adapter lookup (`adapterFor`),
2. the providers route schema's `enum`,
3. the console's "add a credential" `<select>`,
4. the SQL `CHECK` constraint on `provider_credentials.provider`.

Supporting more vendors meant editing all four correctly, every time. The failure mode is quiet and
unpleasant: the console offers a provider, the user pastes a real API key, and the INSERT fails on a
constraint violation that names no useful cause.

The second problem was the catalog. `model_catalog` gates routing (a model that is not in it is
`model_not_found`) and `rate_cards` decides what a request costs, which feeds budget enforcement.
Both were seeded by hand in `0009_seed_catalog.sql` with four models. Hand-seeded pricing is wrong
the moment a vendor changes a price, and nothing surfaces the staleness — spend is simply computed
against a number somebody typed months ago.

## Decision

**One registry, in `shared`.** `packages/shared/src/providers.ts` lists every provider once, with its
label, wire format, default base URL, models endpoint, and whether it publishes pricing. The gateway
and the console both import it. `ProviderId` is derived from the array via `satisfies`, so adding a
provider extends the type automatically and a typo anywhere becomes a compile error.

**Adapters are per WIRE FORMAT, not per provider.** This is the observation that makes the change
small. OpenRouter, Groq, Together, Mistral, DeepSeek, Fireworks, xAI, Perplexity and Google's
compatibility endpoint all speak OpenAI's protocol; they differ only in base URL and branding. So
`wire` has three values (`openai`, `anthropic`, `azure`) while the registry has thirteen entries.
Adding the next OpenAI-compatible vendor costs one registry entry and no adapter code.

Azure is the exception worth an adapter: it addresses a _deployment_ in the URL path, requires an
`api-version` query parameter, and authenticates with `api-key` rather than a bearer. Its body is
still OpenAI's, so the adapter delegates translation and rewrites only the envelope.

**The SQL constraint stays.** It is a fourth list, deliberately: a `CHECK` means a bad provider
cannot be written even from a direct psql session. Drift is prevented by a test that parses the
migration and compares it against `PROVIDER_IDS`, rather than by hoping.

**The catalog is synced, not seeded.** `relay sync-models` reads each provider's own `/models`
endpoint. OpenRouter publishes per-token prices for hundreds of models and needs no API key, which
makes it the one source that can populate `rate_cards` with numbers nobody had to guess. Providers
requiring a key read it from `RELAY_SYNC_KEY_<PROVIDER>` — never from a tenant's stored credentials,
since the catalog is global and one customer's entitlements must not decide what every other tenant
may route to.

## Consequences

- Adding an OpenAI-compatible vendor is a registry entry plus one line in a migration.
- A provider's default base URL lives in one place, so `openrouter` works with no base URL configured
  while `azure_openai` and `openai_compat` correctly demand one.
- Pricing accuracy becomes an operational concern (run the sync) rather than a code concern (edit a
  migration). Prices are the vendor's, not ours.
- Rate cards are versioned, never overwritten: a price change closes the open row and opens a new
  one, so a usage event settled last week is still explained by the price effective when it ran.
- Two provider-shaped facts are still hand-maintained per provider and cannot be derived: the models
  endpoint path, and whether that endpoint publishes pricing. Both are asserted by tests.

## Notes

`priceChanged` compares at the stored scale using `toPrecision(15)` before rounding, not `toFixed`.
Postgres `numeric(12,6)` rounds half away from zero (0.0000375 → 0.000038) while `toFixed(6)` reads
the binary double as 0.00003749… and rounds down. Comparing the two reported a difference that did
not exist, and since the sync reacts to a difference by writing a new rate-card version, the row was
rewritten on every run — unbounded growth and a price history full of changes that never happened.
Caught by running a real 413-model sync twice and noticing one row move; it affected exactly one
model, which is precisely the kind of thing a unit test alone would not have found.
