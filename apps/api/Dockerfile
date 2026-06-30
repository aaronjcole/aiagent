# ---------------------------------------------------------------------------
# API server image. Build context = repo root (see docker-compose.yml).
#
#   docker build -f apps/api/Dockerfile -t aiagent-api .
#
# Multi-stage: a `builder` installs the whole pnpm workspace from the lockfile,
# generates the Prisma client, and builds every package + app via turbo. The
# final `runner` stage carries the built workspace + node_modules and starts the
# Fastify server. The compose `api` service runs
# `pnpm --filter @app/db exec prisma migrate deploy` (so pnpm + the Prisma CLI
# must be present at runtime) before `node apps/api/dist/index.js`.
# ---------------------------------------------------------------------------

FROM node:22-slim AS builder
WORKDIR /app

# Prisma needs OpenSSL (libssl) + CA certs at generate/runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (pinned by package.json "packageManager").
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Copy the full workspace and install from the frozen lockfile.
COPY . .
RUN pnpm install --frozen-lockfile

# Generate the Prisma client, then build all packages + apps.
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

# Carry the built workspace (sources, dist, generated Prisma client, deps).
# Dev deps are retained so the compose `api` service can run the Prisma CLI for
# `prisma migrate deploy` at startup.
COPY --from=builder /app /app

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
