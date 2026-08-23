# syntax=docker/dockerfile:1
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
# Copy only manifests first so dependency install caches independently of source.
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api

ARG GIT_COMMIT=dev
ENV GIT_COMMIT=$GIT_COMMIT
ENV PORT=3001
EXPOSE 3001

# Run unprivileged; the bun image ships a `bun` user.
USER bun
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["bun", "apps/api/src/index.ts"]
