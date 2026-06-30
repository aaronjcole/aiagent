# ---------------------------------------------------------------------------
# Temporal worker image. Build context = repo root (see docker-compose.yml).
#
#   docker build -f apps/worker/Dockerfile -t aiagent-worker .
#
# Same multi-stage build as the API: install the pnpm workspace, generate the
# Prisma client, build all packages + apps, then run the worker.
# ---------------------------------------------------------------------------

FROM node:22-slim AS builder
WORKDIR /app

# Prisma needs OpenSSL (libssl) + CA certs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @app/db exec prisma generate
RUN pnpm -r build

# ---------------------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY --from=builder /app /app

CMD ["node", "apps/worker/dist/index.js"]
