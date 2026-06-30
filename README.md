# Agentic Email Automation

A safety-first agentic system for B2B email outreach. Three agent surfaces —
**research**, **outreach**, and **inbound scheduling** — propose actions, but
**deterministic code always decides**. Sending is OFF by default (drafts only),
unsubscribe handling is deterministic, and a human must approve any send in the
MVP.

> **Core safety rule:** the LLM *recommends*, deterministic code *decides*.
> `SENDING_ENABLED` and `AUTO_SEND_ENABLED` both default to **false**, so the
> system produces drafts and approval items but never sends mail out of the box.
> Unsubscribe detection and suppression are deterministic, and every action is
> written to an immutable audit log.

---

## What it does

- **Research agent** — synthesizes raw sources into a structured
  `ResearchOutput` (company insights, personalization points with evidence,
  data gaps, confidence, risk flags). Default research provider is a **mock**.
- **Outreach agent** — drafts a personalized message from the research, lists
  the personalization it actually used, and flags unsupported claims. A
  separate **compliance** review (LLM + deterministic checks) gates it.
- **Inbound scheduling agent** — classifies inbound replies (interested,
  unsubscribe, out-of-office, scheduling, …), and for scheduling intents
  extracts proposed times, checks free/busy, and drafts a reply / proposes a
  calendar event.

In every flow the LLM output is validated against a strict Zod schema, persisted
as an `AgentRun` for observability, and then **deterministic gates** decide what
(if anything) actually happens.

---

## Architecture

```text
                            ┌──────────────────────────────────────────┐
                            │                  apps/                    │
                            │                                           │
   HTTP / demo  ─────────►  │  api (Fastify, :3001)  admin (Next, :3000)│
                            │      │                        │           │
                            │      │ starts workflows       │ reads     │
                            │      ▼ (Temporal client)       ▼           │
                            │  worker (Temporal worker, queue "aiagent")│
                            └──────┬───────────────────────────┬────────┘
                                   │ activities                │
                                   ▼                            ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │                              packages/                              │
   │  shared   db   llm   email   calendar   compliance   agents   workflows
   │  (env,    (Prisma)(LLM   (Email  (Calendar (suppress, (6 agent (Temporal
   │   ids,            adapters)adapters)adapters) caps,     fns)     wf+act)
   │   schemas)                            review,footer)                │
   └───────────────────────────────────────────────────────────────────┘
                                   │                            │
                                   ▼                            ▼
                         ┌──────────────────┐        ┌────────────────────┐
                         │  Postgres :5432  │        │  Temporal :7233     │
                         │  (Prisma schema) │        │  (UI :8080)         │
                         └──────────────────┘        └────────────────────┘
```

- **apps/api** (`@app/api`) — Fastify HTTP API + the `demo` script; starts
  Temporal workflows via the client.
- **apps/worker** (`@app/worker`) — Temporal worker hosting the workflows +
  activities (the only layer that touches providers/db).
- **apps/admin** (`@app/admin`) — Next.js admin UI (approvals queue, runs,
  suppression).
- **packages/** — `shared`, `db`, `llm`, `email`, `calendar`, `compliance`,
  `agents`, `workflows` (see [SPEC.md](./SPEC.md) for each package's contract).

---

## Prerequisites

- **Node 22+**
- **pnpm 10** (`corepack enable` then `corepack prepare pnpm@10.33.0 --activate`)
- **Docker** + Docker Compose v2 (for the local stack)

### Prisma offline-engine note (from SPEC §4)

`pnpm db:generate` needs the Prisma engine binaries. In an offline/proxied
environment they are cached under
`~/.cache/prisma/master/<hash>/debian-openssl-3.0.x/`. To avoid network fetches,
run prisma commands with:

```bash
export PRISMA_ENGINES_MIRROR=file://$HOME/.cache/prisma/master
export PRISMA_SCHEMA_ENGINE_BINARY=$HOME/.cache/prisma/master/<hash>/debian-openssl-3.0.x/schema-engine
export PRISMA_QUERY_ENGINE_LIBRARY=$HOME/.cache/prisma/master/<hash>/debian-openssl-3.0.x/libquery_engine.so.node
export CHECKPOINT_DISABLE=1
export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
pnpm db:generate
```

On a normal machine with network access, plain `pnpm db:generate` just works.

---

## Quick start

```bash
# 1. Configure (placeholders only; .env is git-ignored)
cp .env.example .env

# 2. Install the workspace
pnpm install

# 3. Generate the Prisma client (see offline-engine note above if needed)
pnpm db:generate

# 4. Bring up the local stack: Postgres + Temporal (+ UI) + API + worker
docker compose up
#    The `api` container runs `prisma migrate deploy` on boot, so the schema is
#    applied automatically. Temporal UI is at http://localhost:8080.

# 5. (Local dev alternative to step 4's migrations) apply migrations yourself
pnpm db:migrate          # prisma migrate dev (local), or:
pnpm --filter @app/db exec prisma migrate deploy   # against a running Postgres

# 6. Seed sample prospects / settings
pnpm seed

# 7. Run the end-to-end demo through Temporal
pnpm demo

#    Fallback — run the services directly against Postgres, no Temporal:
pnpm demo -- --no-temporal
```

The compose stack and a local `pnpm dev` both read the same `.env`. Inside
compose, `DATABASE_URL` and `TEMPORAL_ADDRESS` are overridden to point at the
in-network `postgres` / `temporal` services (your `.env` can keep `localhost`
values for local, non-Docker runs).

---

## Workflows & safety gates

Three Temporal workflows (task queue **`aiagent`**, deterministic workflow ids):

1. **Outreach** — research → draft → compliance → *(safety gate)* → send →
   schedule next step.
2. **Inbound** — classify → branch (unsubscribe / human handoff / scheduling /
   auto-reply).
3. **Scheduling** — extract intent → free/busy → reply draft → *(safety gate)* →
   create calendar event.

### The 10-step outbound send gate (in order)

Every outbound send (outreach or reply) must pass these gates **in order**; the
first failure short-circuits, is recorded in `AuditLog` (`allowed=false`,
`reason`), and either escalates or skips:

1. **`SENDING_ENABLED`** — master kill switch. If false → skip (no send).
2. **Suppression** — `checkSuppression(toEmail)` (email then domain). If
   suppressed → mark prospect `suppressed`, skip.
3. **Prospect status** — not `unsubscribed` / `bounced` / `closed`.
4. **Sequence bounds** — step ≤ `SEQUENCE_MAX_STEPS`.
5. **Send caps** — global → per-inbox → per-domain. Any exceeded → defer/skip.
6. **Compliance review** — `fail` → escalate; `needs_review` → create an
   `ApprovalItem`.
7. **Footer** — CAN-SPAM postal address + unsubscribe link guaranteed present.
8. **Approval gate** — if `AUTO_SEND_ENABLED` is false (or compliance said
   `needs_review`), create an `ApprovalItem` and wait; only an `approved` item
   proceeds.
9. **Idempotency** — `DraftEmail.idempotencyKey` / `IdempotencyKey` row prevents
   double-send.
10. **Send + audit** — provider send, persist `EmailMessage`, set draft `sent`,
    write `AuditLog`.

### Enabling auto-send (do this deliberately)

Auto-send requires **both**:

1. The env flag `AUTO_SEND_ENABLED=true` (and `SENDING_ENABLED=true` to send at
   all), **and**
2. The corresponding `SystemSetting` row enabled in the database.

> ⚠️ **Both default to off and should stay off** outside a controlled test. With
> them off, the system only produces drafts + approval items — a human approves
> every send in the MVP.

---

## Environment variables

Full annotated list lives in [`.env.example`](./.env.example) (placeholders
only — **never commit real values**). Everything is parsed through
`loadConfig()`; nothing reads `process.env` directly elsewhere.

| Variable | Purpose | Default (example) |
|---|---|---|
| `NODE_ENV` | runtime mode | `development` |
| `LOG_LEVEL` | pino level | `info` |
| `DATABASE_URL` | Postgres connection | `postgresql://user:password@localhost:5432/aiagent?schema=public` |
| `TEMPORAL_ADDRESS` | Temporal frontend | `localhost:7233` |
| `LLM_PROVIDER` | `mock` \| `openai` \| `anthropic` | `mock` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | LLM creds | placeholder |
| `OPENAI_MODEL` / `ANTHROPIC_MODEL` | model ids | `gpt-4o-mini` / `claude-3-5-sonnet-latest` |
| `EMAIL_PROVIDER` | `mock` \| `gmail` | `mock` |
| `GMAIL_*` | Gmail OAuth creds | placeholder |
| `CALENDAR_PROVIDER` | `mock` \| `google` | `mock` |
| `GOOGLE_*` / `GOOGLE_CALENDAR_ID` | Google OAuth + calendar | placeholder / `primary` |
| `RESEARCH_PROVIDER` | `mock` \| `live` | `mock` |
| `AUTO_SEND_ENABLED` | auto-approve sends | `false` |
| `SENDING_ENABLED` | master send kill switch | `false` |
| `DAILY_SEND_CAP` / `PER_INBOX_DAILY_CAP` / `PER_DOMAIN_DAILY_CAP` | send caps | `200` / `50` / `10` |
| `SEQUENCE_MAX_STEPS` | max steps per sequence | `5` |
| `DEFAULT_FROM_EMAIL` / `DEFAULT_FROM_NAME` | sender identity | placeholder |
| `COMPANY_ADDRESS` / `UNSUBSCRIBE_BASE_URL` | CAN-SPAM footer | placeholder |
| `API_PORT` / `ADMIN_PORT` | service ports | `3001` / `3000` |

When running via Docker Compose, Postgres credentials come from
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` (dev defaults
`aiagent` / `aiagent` / `aiagent`).

---

## Local stack (Docker Compose)

| Service | Image | Port | Notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 | App DB + Temporal DBs; healthcheck via `pg_isready` |
| `temporal` | `temporalio/auto-setup:1.25.2` | 7233 | Server + auto schema setup against Postgres |
| `temporal-ui` | `temporalio/ui:2.31.2` | 8080 | Web UI — http://localhost:8080 |
| `api` | built from `apps/api/Dockerfile` | 3001 | Runs `prisma migrate deploy`, then the API |
| `worker` | built from `apps/worker/Dockerfile` | — | Temporal worker on queue `aiagent` |
| `admin` | built from `apps/admin/Dockerfile` | 3000 | Optional Next.js admin UI |

```bash
docker compose up            # foreground
docker compose up -d         # detached
docker compose down          # stop
docker compose down -v       # stop + wipe the postgres volume
docker compose config        # validate the compose file
```

The `admin` service is optional — comment it out if `apps/admin/Dockerfile`
isn't present yet.

---

## Development commands

```bash
pnpm install            # install the workspace
pnpm db:generate        # prisma generate (see offline-engine note)
pnpm build              # turbo run build
pnpm typecheck          # turbo run typecheck
pnpm test               # turbo run test (vitest)
pnpm lint               # turbo run lint (eslint)
pnpm db:migrate         # prisma migrate dev
pnpm seed               # seed sample data
pnpm demo               # end-to-end demo (add `-- --no-temporal` to skip Temporal)
pnpm dev                # turbo run dev (watch mode across packages)
```

### Admin UI

```bash
pnpm --filter @app/admin dev   # Next.js on http://localhost:3000 (ADMIN_PORT)
```

Pages: **approvals queue** (review/approve/reject pending sends), **agent runs**
(LLM call observability), and **suppression** (suppressed emails/domains).

---

## Providers

Provider adapters are chosen by the `*_PROVIDER` env vars and constructed via
`create<X>Provider(config)` factories:

- **Mock is the default** for LLM, email, calendar, and research — the whole
  system runs end-to-end with no external credentials.
- **OpenAI / Anthropic** LLM adapters activate when `LLM_PROVIDER` is set and
  the matching API key is present.
- **Gmail / Google** adapters are **thin stubs** — `googleapis` is intentionally
  not installed, so they throw `ProviderError('configure credentials')` until
  wired up.
- The **research `live` provider is a mock-shaped stub**; `mock` is the working
  default.

### Current limitations / TODOs

- Gmail (email) and Google (calendar) adapters are stubs, not yet implemented.
- The research provider has no real web/live source — `live` is a placeholder.
- Auto-send is gated behind both an env flag and a DB setting and is meant to
  stay off in the MVP; the supported flow is draft + human approval.

---

## Security

- **No secrets in the repo.** Only `.env.example` (placeholders) is committed;
  `.env` is git-ignored and is never baked into Docker images (see
  `.dockerignore`). Secret values are never logged — config is redacted via
  `redact()` / `redactedConfig()` and pino redaction.
- **Audit log on every action.** Each gate decision and side-effect writes an
  `AuditLog` row (`action`, `actorType`, `allowed`, `reason`, …), giving a full
  immutable trail of what the system did and why.
- **Deterministic safety.** Unsubscribe handling, suppression, send caps, and
  the kill switches are deterministic code, never left to the LLM.

---

See [SPEC.md](./SPEC.md) for the full package-by-package contract.
