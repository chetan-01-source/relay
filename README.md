# Relay Gateway

> Self-hostable, multi-tenant, OpenAI-compatible LLM gateway — Node.js 22 + TypeScript.

Relay sits between client SDKs and upstream providers (OpenAI, Anthropic, Gemini, vLLM/Ollama),
exchanging an inbound **virtual key** (`rk_live_…`, hashed) for an outbound **provider credential**
(`sk-…`, encrypted) while enforcing tenancy, rate limits, budgets, caching, metering and audit —
with strict Postgres Row-Level-Security isolation.

## Status

Phase 1 (3-week cycle) — building toward tagged `v0.2.0`. See `llm/docs/` for the PRD and Week-0 setup guide.

## Quickstart (target)

```bash
git clone https://github.com/chetan-01-source/relay.git && cd relay
make bootstrap        # check tools, install, generate
make up               # compose core + migrate + seed
make dev              # watch server + console + mockllm
```

Target: clean laptop → first proxied call in < 15 minutes.

## Stack

| Concern        | Tool                                   |
| -------------- | -------------------------------------- |
| Runtime        | Node.js 22 LTS + TypeScript 5 (strict) |
| HTTP           | Fastify 5                              |
| Datastore      | PostgreSQL 16 + pgvector (RLS forced)  |
| Cache / limits | Valkey 8                               |
| Auth           | Logto (OIDC + Orgs + RBAC)             |
| Console        | Next.js 14                             |
| Monorepo       | pnpm workspaces + Turborepo            |

## Development

Trunk-based, PR-only to `main`. See [CONTRIBUTING.md](CONTRIBUTING.md).
Security disclosures: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE).
