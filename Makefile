SHELL := /bin/bash
COMPOSE := docker compose -f deploy/compose/compose.yaml
ENV_FILE := deploy/compose/.env

.DEFAULT_GOAL := help
.PHONY: help bootstrap up dev down migrate seed-auth seed-demo generate lint test e2e bench release-dry

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

migrate: ## apply SQL migrations (advisory-locked)          [sprint Day 2]
	pnpm --filter @relay/server exec relay migrate

seed-auth: ## idempotent Logto bootstrap                     [sprint Day 5]
	pnpm --filter @relay/server exec relay seed

seed-demo: ## demo org+app+key+route -> prints working curl  [sprint Day 5]
	@echo "[make] seed-demo stub — lands sprint Day 5"

generate: ## kysely-codegen + zod->openapi + client types    [sprint Day 2+]
	@echo "[make] generate stub — lands sprint Day 2+"

lint: ## eslint + prettier + dependency-cruiser + RLS gate
	pnpm turbo lint
	pnpm exec prettier --check .
	pnpm run dep-check
	scripts/check-rls.sh

test: ## vitest unit + integration (testcontainers)
	pnpm turbo test

e2e: ## conformance (real SDKs) + Playwright                 [sprint Day 13-14]
	@echo "[make] e2e stub — lands sprint Day 13-14"

bench: ## k6 vs mockllm -> overhead histogram               [sprint Day 5/14]
	@echo "[make] bench stub — lands sprint Day 5"

release-dry: ## local multi-arch build == CI                 [sprint Day 15]
	@echo "[make] release-dry stub — lands sprint Day 15"
