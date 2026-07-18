SHELL := /bin/bash
COMPOSE := docker compose -f deploy/compose/compose.yaml
ENV_FILE := deploy/compose/.env

.DEFAULT_GOAL := help
.PHONY: help bootstrap up dev down migrate seed-auth seed-demo generate lint test coverage smoke load e2e bench release-dry

help: ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

bootstrap: ## check tools, copy .env, install deps, build shared types
	@node -v | grep -qE '^v(2[2-9]|[3-9][0-9])' || { echo "need Node >= 22"; exit 1; }
	@pnpm -v | grep -qE '^9' || { echo "need pnpm 9 (corepack enable)"; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "docker daemon not running"; exit 1; }
	@test -f $(ENV_FILE) || cp deploy/compose/.env.example $(ENV_FILE)
	pnpm install --frozen-lockfile
	pnpm turbo build --filter=@relay/shared

up: ## compose core + migrate + seeds (full local stack)
	$(COMPOSE) --profile core up -d --wait
	$(MAKE) migrate seed-auth seed-demo

dev: up ## inner loop: core + mockllm + watch all packages
	$(COMPOSE) --profile dev up -d mockllm
	pnpm turbo dev

down: ## stop everything and drop volumes
	$(COMPOSE) --profile dev --profile core down

# load .env into the node CLI processes (compose reads it itself; the CLIs need it in their env)
LOADENV := set -a; [ -f $(ENV_FILE) ] && . $(ENV_FILE); set +a;

migrate: ## apply SQL migrations (advisory-locked)          [sprint Day 2]
	$(LOADENV) pnpm --filter @relay/server exec tsx src/cli/index.ts migrate

seed-auth: ## idempotent Logto bootstrap                     [sprint Day 5]
	$(LOADENV) pnpm --filter @relay/server exec tsx src/cli/index.ts seed-auth

seed-demo: ## demo org+app+key+route -> prints working curl  [sprint Day 5]
	$(LOADENV) pnpm --filter @relay/server exec tsx src/cli/index.ts seed-demo

generate: ## dump OpenAPI spec to api/openapi/openapi.json         [sprint Day 2+]
	pnpm --filter @relay/server exec tsx src/cli/index.ts openapi

lint: ## eslint + prettier + dependency-cruiser + RLS gate
	pnpm turbo lint
	pnpm exec prettier --check .
	pnpm run dep-check
	scripts/check-rls.sh

test: ## vitest unit + integration (testcontainers)
	pnpm turbo test

coverage: ## unit coverage with thresholds (business logic)
	pnpm --filter @relay/server coverage

smoke: ## end-to-end smoke against a running stack (make dev first)
	scripts/smoke.sh

load: ## local load smoke on the hot path (node fallback; use k6 for the gate)
	node scripts/load-smoke.mjs

e2e: ## conformance (real SDKs) + Playwright                 [sprint Day 13-14]
	@echo "[make] e2e stub — lands sprint Day 13-14"

bench: ## drive load -> gate gateway overhead p99 < 25ms (G3)  [sprint Day 5/14]
	node scripts/bench.mjs

release-dry: ## local multi-arch build == CI                 [sprint Day 15]
	@echo "[make] release-dry stub — lands sprint Day 15"
