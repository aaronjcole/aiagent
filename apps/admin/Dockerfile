# ---------------------------------------------------------------------------
# Admin UI (Next.js) image. Build context = repo root (see docker-compose.yml).
#
#   docker build -f apps/admin/Dockerfile -t aiagent-admin .
#
# Installs the pnpm workspace, builds the Next.js app, then runs `next start`
# on ADMIN_PORT.
# ---------------------------------------------------------------------------

FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
# The admin app depends on @app/shared; generate the Prisma client too in case a
# workspace dep pulls it in, then build the Next.js app (and its workspace deps).
RUN pnpm --filter @app/db exec prisma generate
RUN pnpm --filter @app/admin... build

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

COPY --from=builder --chown=node:node /app /app

# Run as the unprivileged bundled `node` user instead of root.
USER node

EXPOSE 3000
CMD ["pnpm", "--filter", "@app/admin", "start"]
