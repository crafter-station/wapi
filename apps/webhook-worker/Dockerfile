# syntax=docker/dockerfile:1
# Stateless consumer — safe to redeploy freely, unlike the gateway.
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/baileys-auth/package.json packages/baileys-auth/
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/webhook-worker/package.json apps/webhook-worker/
RUN bun install --frozen-lockfile

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY apps/webhook-worker ./apps/webhook-worker
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "apps/webhook-worker/src/index.ts"]
