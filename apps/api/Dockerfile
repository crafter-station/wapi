# syntax=docker/dockerfile:1
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
# Every workspace manifest must be present before `bun install --frozen-lockfile`:
# the lockfile describes the whole workspace, so a missing package.json reads as drift
# and the install fails. Adding a new workspace means adding a COPY line here.
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/baileys-auth/package.json packages/baileys-auth/
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
# Only what `api` actually imports at runtime. The gateway is a separate service and its
# Baileys dependency has no business in this image.
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY apps/api ./apps/api

ARG GIT_COMMIT=dev
ENV GIT_COMMIT=$GIT_COMMIT
ENV PORT=3001
EXPOSE 3001

USER bun
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["bun", "apps/api/src/index.ts"]
