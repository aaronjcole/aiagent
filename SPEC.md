# Agentic Email Automation — System Specification

This is the **single source of truth** for downstream workers. The foundation
(monorepo scaffold, `@app/shared`, `@app/db`) is fully implemented. Every other
package currently exists only as a placeholder (`package.json` + `tsconfig.json`
+ `src/index.ts` that `export {}`), and must be implemented to the contracts
below so the workspace compiles and links together.

---

## 1. Conventions

- **Package manager:** pnpm 10.33, workspaces under `apps/*` and `packages/*`.
- **Build orchestration:** Turbo (`turbo run build|typecheck|test|lint`).
- **Language:** TypeScript ~5.6, ESM only (`"type": "module"`), `NodeNext`
  module + resolution. **All relative imports in `.ts` source must use the
  `.js` extension** (e.g. `import { x } from './foo.js'`).
- **tsconfig:** every package extends `../../tsconfig.base.json`. `strict: true`,
  `noUncheckedIndexedAccess: true`, `composite: true`, `declaration: true`.
  Library packages set `rootDir: "src"`, `outDir: "dist"` and list their
  workspace deps under `references`. The Next.js `admin` app opts out of
  composite (`composite: false`, `noEmit: true`, `moduleResolution: "Bundler"`).
- **Path aliases** (from `tsconfig.base.json`): `@app/shared`, `@app/db`,
  `@app/llm`, `@app/email`, `@app/calendar`, `@app/compliance`, `@app/agents`,
  `@app/workflows`.
- **Workspace deps** are declared as `workspace:*`.
- **IDs:** `newId(prefix)` → `prefix_<uuid>`. **Idempotency keys:**
  `idempotencyKey(parts)` → sha256 hex of normalized, space-joined parts.
- **Errors:** throw the typed classes from `@app/shared` (never bare `Error`).
- **Secrets:** never log secret values. Use `redact()` / `redactedConfig()` /
  pino redaction. `.env` is git-ignored; only `.env.example` (placeholders) is
  committed.
- **Lint:** flat ESLint config; `@typescript-eslint/no-explicit-any` is a warn,
  `no-floating-promises` is off.

---

## 2. Packages & responsibilities

| Package | Name | Responsibility | Depends on |
|---|---|---|---|
| `packages/shared` | `@app/shared` | Env/config, logger, errors, ids, Zod agent-output schemas, shared enum constants. **No deps on db/providers.** | (none) |
| `packages/db` | `@app/db` | Prisma schema, generated client, singleton `prisma`. | `@app/shared` |
| `packages/llm` | `@app/llm` | `LlmProvider` interface + mock/openai/anthropic adapters, JSON-mode structured-output helper with Zod validation + repair/retry. | `@app/shared` |
| `packages/email` | `@app/email` | `EmailProvider` interface + mock/gmail adapters; thread/message persistence helpers. | `@app/shared`, `@app/db` |
| `packages/calendar` | `@app/calendar` | `CalendarProvider` interface + mock/google adapters; free/busy + event creation. | `@app/shared`, `@app/db` |
| `packages/compliance` | `@app/compliance` | Suppression, unsubscribe detection, send caps, eligibility, LLM compliance review, CAN-SPAM footer. | `@app/shared`, `@app/db` |
| `packages/agents` | `@app/agents` | The six agent functions that wrap `@app/llm` with the shared schemas and persist `AgentRun` rows. | `@app/shared`, `@app/db`, `@app/llm`, `@app/email`, `@app/calendar`, `@app/compliance` |
| `packages/workflows` | `@app/workflows` | Temporal workflow + activity definitions (outreach, inbound, scheduling). | `@app/shared`, `@app/db`, `@app/agents`, `@app/email`, `@app/calendar`, `@app/compliance`, `@temporalio/*` |
| `apps/api` | `@app/api` | Fastify HTTP API + `demo` script; starts workflows via Temporal client. | shared, db, agents, compliance, workflows |
| `apps/worker` | `@app/worker` | Temporal worker hosting workflows + activities. | shared, db, agents, email, calendar, compliance, workflows |
| `apps/admin` | `@app/admin` | Next.js 14 admin UI (approvals queue, runs, suppression). | shared, db |

> **Provider note:** `googleapis` is intentionally **not** installed. The
> `gmail` and `google` adapters are thin stubs that throw
> `new ProviderError('configure credentials')` until wired up. Mock adapters are
> the default (`*_PROVIDER=mock`).

---

## 3. `@app/shared` — implemented public API

Import from `@app/shared` (barrel) unless noted.

### env.ts
```ts
const ConfigSchema: z.ZodType<Config>;
type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'fatal'|'error'|'warn'|'info'|'debug'|'trace'|'silent';
  databaseUrl: string;
  temporalAddress: string;
  llmProvider: 'mock'|'openai'|'anthropic';
  openaiApiKey?: string; anthropicApiKey?: string;
  openaiModel: string; anthropicModel: string;
  emailProvider: 'mock'|'gmail';
  gmailClientId?: string; gmailClientSecret?: string; gmailRefreshToken?: string;
  gmailRedirectUri?: string; gmailUser?: string;
  calendarProvider: 'mock'|'google';
  googleClientId?: string; googleClientSecret?: string; googleRefreshToken?: string;
  googleRedirectUri?: string; googleCalendarId: string;
  researchProvider: 'mock'|'live';
  autoSendEnabled: boolean;   // default false
  sendingEnabled: boolean;    // default false
  dailySendCap: number; perInboxDailyCap: number; perDomainDailyCap: number;
  sequenceMaxSteps: number;
  defaultFromEmail: string; defaultFromName: string;
  companyAddress: string; unsubscribeBaseUrl: string;
  apiPort: number; adminPort: number;
};
function loadConfig(env?: NodeJS.ProcessEnv): Config;          // throws ZodError on invalid
function redactedConfig(config: Config): Record<keyof Config, unknown>; // safe to log
```

### logger.ts
```ts
function createLogger(name: string, options?: LoggerOptions): Logger; // pino
function redact<T>(value: T): T;   // deep-clones, replaces secret-keyed values with '[REDACTED]'
type Logger;                        // re-exported from pino
```
Secret key pattern: `/key|token|secret|password|authorization|cookie|refresh/i`.

### errors.ts
```ts
abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly details?: unknown;
  toJSON(): { name; code; httpStatus; message; details };
}
class ValidationError      // code 'VALIDATION_ERROR'  http 400
class PolicyViolationError // code 'POLICY_VIOLATION'  http 422
class EscalationError      // code 'ESCALATION'        http 409
class NotFoundError        // code 'NOT_FOUND'         http 404
class ProviderError        // code 'PROVIDER_ERROR'    http 502
class IdempotencyError     // code 'IDEMPOTENCY_ERROR' http 409
function isAppError(err: unknown): err is AppError;
type ErrorCode = 'APP_ERROR'|'VALIDATION_ERROR'|'POLICY_VIOLATION'|'ESCALATION'|'NOT_FOUND'|'PROVIDER_ERROR'|'IDEMPOTENCY_ERROR';
```
`name` is the discriminant (e.g. `'ValidationError'`), constructor signature is
`(message: string, details?: unknown)`.

### ids.ts
```ts
function newId(prefix: string): string;                 // `${prefix}_${randomUUID()}`
function idempotencyKey(parts: readonly string[]): string; // sha256 hex
```

### constants.ts
Each is a `const` object plus a same-named type (string-literal union). Values
match the Prisma enums exactly.
```
ProspectStatus      new|researching|ready|sequenced|engaged|meeting_booked|unsubscribed|bounced|suppressed|closed
ResearchStatus      researched|partial|insufficient|needs_review
DraftStatus         draft|pending_review|approved|rejected|scheduled|sent|failed|cancelled
ApprovalType        outreach_send|reply_send|schedule_meeting|escalation
ApprovalStatus      pending|approved|rejected|expired|auto_approved
CalendarEventStatus proposed|tentative|confirmed|cancelled|failed
SuppressionReason   unsubscribe|bounce|complaint|manual|global_block|competitor
AgentType           research|outreach|compliance|inbound_classifier|scheduling_extractor|scheduling_reply
AgentRunStatus      pending|running|succeeded|failed|invalid_output|escalated
EmailDirection      outbound|inbound
ActorType           system|agent|human|provider
```

### schemas/ (Zod, all `.strict()`, `confidence` ∈ [0,1], `riskFlags: string[]`)
Exported schemas + inferred types (also re-exported from `@app/shared`):
- `ResearchOutputSchema` → `ResearchOutput`
- `OutreachDraftSchema` → `OutreachDraft`
- `ComplianceReviewSchema` → `ComplianceReview`
- `InboundClassificationSchema` → `InboundClassification`
- `SchedulingExtractionSchema` → `SchedulingExtraction`
- `SchedulingReplyDraftSchema` → `SchedulingReplyDraft`
- helpers: `ConfidenceSchema`, `RiskFlagsSchema`, `IsoDateTimeSchema`,
  `TimeSlotSchema`→`TimeSlot` (`{ startIso, endIso }`), plus the per-schema enum
  schemas (`ResearchStatusEnum`, `ComplianceDecisionEnum`,
  `ComplianceSeverityEnum`, `InboundCategoryEnum`, `SchedulingActionEnum`).

Field shapes (abridged — see source for exact):
```
ResearchOutput        { status, summary, companyInsights,
                        personalizationPoints: { point, evidence, sourceUrl: url|null }[],
                        sources: { title, url, snippet }[], dataGaps: string[], confidence, riskFlags }
OutreachDraft         { subject, body, personalizationUsed[], callToAction, unsupportedClaims[], confidence, riskFlags }
ComplianceReview      { decision: pass|fail|needs_review,
                        issues: { code, severity: low|medium|high, detail }[],
                        hasUnsupportedClaims, suggestedFixes[], confidence }
InboundClassification { category, requiresHuman, reasons[], confidence, riskFlags }
SchedulingExtraction  { hasSchedulingIntent, proposedTimes: TimeSlot[], timezone|null,
                        timezoneAmbiguous, durationMinutes|null, selectedSlotIndex|null,
                        needsClarification, clarificationQuestion|null, confidence }
SchedulingReplyDraft  { action: propose|confirm|clarify|escalate, body, proposedSlots: TimeSlot[], confidence }
```

---

## 4. `@app/db` — implemented public API

```ts
import { prisma } from '@app/db';        // singleton PrismaClient (hot-reload safe)
export * from '@prisma/client';          // all model types + enums re-exported
```

- **Datasource:** postgresql, `env("DATABASE_URL")`. Generator: `prisma-client-js`.
- **Models:** `Company`, `Prospect`, `ResearchResult`, `EmailThread`,
  `EmailMessage`, `OutreachSequence`, `SequenceStep`, `DraftEmail`,
  `ApprovalItem`, `CalendarEvent`, `SuppressionEntry`, `AgentRun`, `AuditLog`,
  `SystemSetting`, `IdempotencyKey`.
- **Prisma enum names** (use these in TS): `ProspectStatus`, `ResearchStatus`,
  `DraftStatus`, `ApprovalType`, `ApprovalStatus`, `CalendarEventStatus`,
  `SuppressionReason`, `AgentType`, `AgentRunStatus`, `EmailDirection`,
  `ActorType`. Values are identical to the `@app/shared` constants.
- **Idempotency / dedup:**
  - `DraftEmail.idempotencyKey @unique`, `CalendarEvent.idempotencyKey @unique`.
  - `CalendarEvent.providerEventId @unique`, `EmailThread.providerThreadId @unique`.
  - Inbound dedup: `EmailMessage.providerMessageId @unique`.
  - Generic external-action dedup: `IdempotencyKey { key @unique, scope, resultJson Json?, createdAt }`.
- **Key JSON columns:** `ResearchResult.output` (a `ResearchOutput`),
  `DraftEmail.complianceFlags`, `CalendarEvent.attendees` (`{email,name?,responseStatus?}[]`),
  `AgentRun.{inputPayload,parsedOutput,validationErrors,usage}`,
  `ApprovalItem.payload`, `AuditLog.metadata`, `SystemSetting.value`.
- **AgentRun** stores `rawResponseRedacted` (string, secrets/PII removed),
  never the raw body.
- **AuditLog** is indexed by `createdAt`, `entityType`, `(entityType, entityId)`.
- **Migration:** offline init SQL at `prisma/migrations/0_init/migration.sql`
  (generated via `prisma migrate diff`), with `migration_lock.toml`. No DB was
  contacted; run `prisma migrate deploy` against a real Postgres to apply.

> **Offline Prisma engines:** the CLI needs its engine binaries. In this
> environment they are cached under `~/.cache/prisma/master/<hash>/debian-openssl-3.0.x/`.
> Run prisma commands with `PRISMA_SCHEMA_ENGINE_BINARY`,
> `PRISMA_QUERY_ENGINE_LIBRARY`, `PRISMA_ENGINES_MIRROR=file://~/.cache/prisma/master`,
> `CHECKPOINT_DISABLE=1`, `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` to avoid
> network fetches.

---

## 5. Provider interfaces (to implement)

These are the contracts the rest of the system codes against. Implementers
should export the interface + a `create<X>Provider(config: Config)` factory that
picks the adapter by `config.*Provider`.

### LlmProvider (`@app/llm`)
```ts
interface LlmMessage { role: 'system'|'user'|'assistant'; content: string }
interface LlmCompleteOptions {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;            // request structured JSON
}
interface LlmUsage { promptTokens: number; completionTokens: number; totalTokens: number }
interface LlmResult { text: string; usage?: LlmUsage; model: string; provider: string }

interface LlmProvider {
  readonly name: 'mock'|'openai'|'anthropic';
  readonly model: string;
  complete(opts: LlmCompleteOptions): Promise<LlmResult>;
}

// Structured-output helper: prompts, parses JSON, validates with a Zod schema,
// repairs/retries on failure, throws ValidationError after `maxAttempts`.
function generateStructured<T>(args: {
  provider: LlmProvider;
  schema: import('zod').ZodType<T>;
  messages: LlmMessage[];
  maxAttempts?: number;          // default 2
}): Promise<{ value: T; usage?: LlmUsage; rawRedacted: string; attempts: number }>;

function createLlmProvider(config: Config): LlmProvider;
```

### EmailProvider (`@app/email`)
```ts
interface OutboundEmail {
  fromEmail: string; fromName?: string;
  toEmail: string; cc?: string[];
  subject: string; bodyText: string; bodyHtml?: string;
  threadProviderId?: string;     // reply within a thread
  headers?: Record<string,string>;
  idempotencyKey: string;
}
interface SendResult { providerMessageId: string; providerThreadId: string; sentAt: string }
interface InboundEmail {
  providerMessageId: string; providerThreadId: string;
  fromEmail: string; toEmail: string; cc?: string[];
  subject?: string; bodyText?: string; bodyHtml?: string;
  headers?: Record<string,string>; receivedAt: string;
}
interface EmailProvider {
  readonly name: 'mock'|'gmail';
  send(email: OutboundEmail): Promise<SendResult>;
  fetchInbound(opts?: { since?: string; max?: number }): Promise<InboundEmail[]>;
}
function createEmailProvider(config: Config): EmailProvider;
```

### CalendarProvider (`@app/calendar`)
```ts
interface CalendarAttendee { email: string; name?: string; responseStatus?: string }
interface FreeBusyQuery { startIso: string; endIso: string; timezone: string }
interface BusyInterval { startIso: string; endIso: string }
interface CreateEventInput {
  title: string; description?: string;
  startIso: string; endIso: string; timezone: string;
  attendees: CalendarAttendee[]; location?: string;
  idempotencyKey: string;
}
interface CalendarEventResult { providerEventId: string; meetingUrl?: string; status: string }
interface CalendarProvider {
  readonly name: 'mock'|'google';
  getFreeBusy(q: FreeBusyQuery): Promise<BusyInterval[]>;
  createEvent(input: CreateEventInput): Promise<CalendarEventResult>;
  cancelEvent(providerEventId: string): Promise<void>;
}
function createCalendarProvider(config: Config): CalendarProvider;
```

### ResearchProvider (`@app/agents` or `@app/llm`-adjacent; default mock)
```ts
interface ResearchQuery { prospectEmail: string; companyDomain?: string; name?: string; title?: string }
interface ResearchDoc { title: string; url: string; snippet: string }
interface ResearchProvider {
  readonly name: 'mock'|'live';
  gather(q: ResearchQuery): Promise<ResearchDoc[]>;   // raw sources; the agent synthesizes ResearchOutput
}
function createResearchProvider(config: Config): ResearchProvider;
```

---

## 6. Agent functions (`@app/agents`)

Each agent: builds a prompt, calls `generateStructured` with the matching shared
schema, writes an `AgentRun` row (status, provider, model, input, redacted raw,
parsed output, validation errors, attempts, latencyMs, usage), and returns the
validated output. On repeated invalid output → set `AgentRun.status =
invalid_output` and throw `ValidationError`; when human handoff is required →
throw `EscalationError`.

```ts
interface AgentContext { provider: LlmProvider; logger: Logger; config: Config; prospectId?: string; threadId?: string }

function runResearchAgent(ctx: AgentContext, input: { query: ResearchQuery; docs: ResearchDoc[] }): Promise<ResearchOutput>;
function runOutreachAgent(ctx: AgentContext, input: { research: ResearchOutput; prospect: Prospect; sequenceStep?: number }): Promise<OutreachDraft>;
function runComplianceAgent(ctx: AgentContext, input: { draft: OutreachDraft | { subject: string; body: string }; research?: ResearchOutput }): Promise<ComplianceReview>;
function runInboundClassifier(ctx: AgentContext, input: { message: InboundEmail; threadContext?: string }): Promise<InboundClassification>;
function runSchedulingExtractor(ctx: AgentContext, input: { message: InboundEmail; nowIso: string; defaultTimezone?: string }): Promise<SchedulingExtraction>;
function runSchedulingReplyAgent(ctx: AgentContext, input: { extraction: SchedulingExtraction; availableSlots: TimeSlot[] }): Promise<SchedulingReplyDraft>;
```
(`Prosp​ect` is the Prisma model type from `@app/db`.)

---

## 7. Compliance service (`@app/compliance`)

```ts
interface SuppressionCheck { suppressed: boolean; reason?: SuppressionReason; matchedOn?: 'email'|'domain' }
function checkSuppression(email: string): Promise<SuppressionCheck>;

// Detect an unsubscribe request in inbound text (keywords / List-Unsubscribe).
function classifyUnsubscribe(input: { bodyText?: string; subject?: string; headers?: Record<string,string> }): { isUnsubscribe: boolean; confidence: number };

interface CapStatus { allowed: boolean; scope: 'global'|'inbox'|'domain'; used: number; cap: number }
function checkSendingCaps(input: { fromEmail: string; toEmail: string }): Promise<CapStatus[]>; // all caps; allowed = every entry allowed

interface EligibilityResult { eligible: boolean; reasons: string[] } // composes suppression + caps + status + sendingEnabled
function checkEligibility(input: { prospect: Prospect; fromEmail: string }): Promise<EligibilityResult>;

function runComplianceReview(ctx: AgentContext, input: { draft: OutreachDraft; research?: ResearchOutput }): Promise<ComplianceReview>; // wraps runComplianceAgent + deterministic checks

// Append CAN-SPAM footer (company postal address + unsubscribe link) if missing.
function ensureFooter(input: { bodyText: string; bodyHtml?: string; unsubscribeUrl: string; companyAddress: string }): { bodyText: string; bodyHtml?: string; added: boolean };
```

---

## 8. Temporal workflows (`@app/workflows`)

Three workflows + their activity lists. Activities are the only place that
touches providers/db; workflows must stay deterministic.

```ts
// 1) Outreach: research → draft → compliance → (gate) → send → schedule next step.
function outreachWorkflow(input: { prospectId: string; sequenceId?: string }): Promise<{ status: 'sent'|'escalated'|'suppressed'|'skipped'; draftId?: string }>;
//   activities: loadProspect, gatherResearch, runResearchAgentActivity,
//   runOutreachAgentActivity, runComplianceActivity, checkEligibilityActivity,
//   ensureFooterActivity, persistDraftActivity, requestApprovalActivity,
//   sendEmailActivity, recordAuditActivity, scheduleNextStepActivity.

// 2) Inbound: classify → branch (unsubscribe/handoff/scheduling/auto-reply).
function inboundWorkflow(input: { messageId: string }): Promise<{ outcome: 'handled'|'escalated'|'unsubscribed'|'scheduling' }>;
//   activities: loadMessage, classifyInboundActivity, applyUnsubscribeActivity,
//   createApprovalActivity, startSchedulingActivity, recordAuditActivity.

// 3) Scheduling: extract intent → free/busy → reply draft → (gate) → create event.
function schedulingWorkflow(input: { threadId: string; messageId: string }): Promise<{ status: 'proposed'|'confirmed'|'clarify'|'escalated' }>;
//   activities: loadThread, extractSchedulingActivity, getFreeBusyActivity,
//   runSchedulingReplyActivity, ensureFooterActivity, requestApprovalActivity,
//   sendEmailActivity, createCalendarEventActivity, recordAuditActivity.
```
Task queue: `aiagent`. Workflow ids should be deterministic per entity
(`outreach-<prospectId>-<step>`, `inbound-<messageId>`, `scheduling-<threadId>`).

---

## 9. Safety gate order for outbound send

Every outbound send (outreach or reply) MUST pass these gates **in order**;
the first failure short-circuits, is recorded in `AuditLog`
(`allowed=false`, `reason`), and either escalates or skips:

1. **`config.sendingEnabled`** — master kill switch. If false → skip (no send).
2. **Suppression** — `checkSuppression(toEmail)` (email then domain). If
   suppressed → mark prospect `suppressed`, skip.
3. **Prospect status** — not `unsubscribed`/`bounced`/`closed`.
4. **Sequence bounds** — step ≤ `config.sequenceMaxSteps`.
5. **Send caps** — `checkSendingCaps` (global → per-inbox → per-domain). Any
   exceeded → defer/skip.
6. **Compliance review** — `runComplianceReview`. `fail` → escalate;
   `needs_review` → create `ApprovalItem`.
7. **Footer** — `ensureFooter` guarantees CAN-SPAM postal address + unsubscribe
   link before send.
8. **Approval gate** — if `config.autoSendEnabled` is false (or compliance said
   `needs_review`), create an `ApprovalItem` and wait; only an `approved`
   item proceeds.
9. **Idempotency** — `DraftEmail.idempotencyKey` / `IdempotencyKey` row prevents
   double-send; the provider call is keyed by `idempotencyKey`.
10. **Send + audit** — `EmailProvider.send`, persist `EmailMessage`, set draft
    `sent`, write `AuditLog`.

Both `SENDING_ENABLED` and `AUTO_SEND_ENABLED` default to **false** — the system
is safe (drafts only) out of the box.

---

## 10. Environment variables

See `.env.example` for the full annotated list (placeholders only). Categories:
core (`NODE_ENV`, `LOG_LEVEL`), `DATABASE_URL`, `TEMPORAL_ADDRESS`, LLM
(`LLM_PROVIDER`, `OPENAI_*`, `ANTHROPIC_*`), email (`EMAIL_PROVIDER`, `GMAIL_*`),
calendar (`CALENDAR_PROVIDER`, `GOOGLE_*`), `RESEARCH_PROVIDER`, safety
(`AUTO_SEND_ENABLED`, `SENDING_ENABLED`, `DAILY_SEND_CAP`,
`PER_INBOX_DAILY_CAP`, `PER_DOMAIN_DAILY_CAP`, `SEQUENCE_MAX_STEPS`), sender
identity (`DEFAULT_FROM_EMAIL`, `DEFAULT_FROM_NAME`, `COMPANY_ADDRESS`,
`UNSUBSCRIBE_BASE_URL`), services (`API_PORT`, `ADMIN_PORT`). Parse everything
through `loadConfig()`; never read `process.env` directly elsewhere.

---

## 11. Build / dev commands

```
pnpm install
pnpm db:generate      # prisma generate (see offline-engine note in §4)
pnpm build            # turbo run build
pnpm typecheck
pnpm test
pnpm lint
pnpm seed             # @app/db seed (placeholder)
pnpm demo             # @app/api demo (placeholder)
pnpm dev              # turbo run dev
```
