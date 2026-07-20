# Dev-only OpenAI-compatible mock provider. Standalone build (no workspace deps besides fastify).
# Pin pnpm to the repo's version: this image copies only mockllm's package.json (which has no
# `packageManager` field), so without the pin corepack floats to the latest pnpm — pnpm 11 turns
# unapproved build scripts (esbuild) into a hard ERR_PNPM_IGNORED_BUILDS failure. Pinning keeps the
# build reproducible and matches the pnpm used everywhere else.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json ./
RUN pnpm install --prod --no-frozen-lockfile --ignore-scripts
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]
