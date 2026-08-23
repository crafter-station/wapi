# syntax=docker/dockerfile:1
#
# The gateway runs on NODE, not Bun (PLAN.md §2 / Q26). It is the one process expected to hold
# WhatsApp sockets open for days, and a runtime incompatibility there does not announce itself
# at startup — it surfaces as an unexplained day-three disconnect. Baileys declares
# `engines: node >= 20` and the `minio` client is Node-oriented.
#
# Dependencies are still installed with Bun so there is exactly one lockfile in the repo.

FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
# Every workspace manifest must be present or --frozen-lockfile reads the absence as drift.
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
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY packages/baileys-auth ./packages/baileys-auth
COPY apps/gateway ./apps/gateway

ENV PORT=3002
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3002/health || exit 1

# tsx rather than a build step: one less artifact, and the gateway is not latency-sensitive
# at startup. Invoked through node directly so the runtime is unambiguous.
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "apps/gateway/src/server.ts"]
