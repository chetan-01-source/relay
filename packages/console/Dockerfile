# syntax=docker/dockerfile:1
# Relay console image (Next.js app router). Build context is the REPO ROOT:
#   docker build -f packages/console/Dockerfile .
#
# Uses Next's `output: 'standalone'` (next.config.mjs): the build traces only the runtime deps into
# .next/standalone, so the runtime image is small and reproducible. In a monorepo the standalone root
# mirrors the workspace layout (server.js lives under packages/console), which the COPYs below preserve.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/console/package.json packages/console/
RUN pnpm install --frozen-lockfile --filter @relay/console...

COPY packages/console packages/console
RUN pnpm --filter=@relay/console build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S relay && adduser -S relay -G relay
# Standalone bundle (server + traced node_modules) + the static assets it serves.
COPY --from=build /repo/packages/console/.next/standalone ./
COPY --from=build /repo/packages/console/.next/static ./packages/console/.next/static
USER relay
# The console listens on 3100 (matches the dev + E2E config); Next reads PORT/HOSTNAME.
ENV PORT=3100 HOSTNAME=0.0.0.0
EXPOSE 3100
CMD ["node", "packages/console/server.js"]
