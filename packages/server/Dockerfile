# syntax=docker/dockerfile:1
# Relay gateway image (data + control plane). Build context is the REPO ROOT (the server depends on the
# @relay/shared workspace package), so build with:  docker build -f packages/server/Dockerfile .
#
# Multi-stage: stage 1 builds the whole workspace slice, stage 2 runs `pnpm deploy` to produce a
# self-contained prod node_modules (with @relay/shared resolved from workspace:* to its built output),
# stage 3 is a minimal runtime carrying only dist + prod deps + the SQL migrations `relay migrate` reads.
FROM node:22-alpine AS build
WORKDIR /repo
# Pin pnpm to the repo's version (matches packageManager); floating to pnpm 11 would turn the esbuild
# build-script approval into a hard error. Same reasoning as the mockllm image.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Manifests first so the install layer caches across source-only edits.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @relay/server...

# Sources, then build shared first (server imports its published output) and the server.
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter=@relay/shared build && pnpm --filter=@relay/server build

# A self-contained production deployment: dist + prod deps only, @relay/shared inlined into node_modules.
RUN pnpm --filter=@relay/server --prod deploy /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The container runs as an unprivileged user; the migrations dir is read-only to it.
RUN addgroup -S relay && adduser -S relay -G relay
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/packages/server/dist ./dist
# `relay migrate` walks up from cwd to find db/migrations — ship them next to the app.
COPY db/migrations ./db/migrations
USER relay
# 3000 = data plane (/v1/*), 9090 = internal health/metrics.
EXPOSE 3000 9090
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
