/**
 * Shared service-layer helpers: persisting `AgentRun` rows, writing `AuditLog`
 * rows, and mapping agent metadata/statuses to DB enum values. These keep every
 * service consistent about observability + audit without duplicating the Prisma
 * shapes.
 */

import {
  AgentRunStatus,
  ActorType,
  ProspectStatus,
  ResearchStatus,
  type AgentType,
} from '@app/shared';
import type { Prisma } from '@app/db';
import type { AgentMeta } from '@app/agents';
import type { ResearchOutput } from '@app/shared';
import type { Deps } from '../deps.js';

/** Map the shared short agent keys to the Prisma `AgentType` enum string. */
export type AgentTypeValue = AgentType;

/** Inputs to persist an AgentRun row. */
export interface PersistAgentRunInput {
  agentType: AgentTypeValue;
  status: AgentRunStatus;
  meta?: AgentMeta;
  prospectId?: string | null;
  threadId?: string | null;
  inputPayload: unknown;
  parsedOutput?: unknown;
  validationErrors?: unknown;
}

/** A minimal AgentRun row shape returned to callers (only `id` is relied on). */
export interface AgentRunRef {
  id: string;
}

/**
 * Persist an `AgentRun` row capturing provider/model/attempts/latency/usage plus
 * the redacted raw response, parsed output, and validation errors. Returns the
 * created row (id used to link `ResearchResult`/`DraftEmail`).
 */
export async function persistAgentRun(
  deps: Deps,
  input: PersistAgentRunInput,
): Promise<AgentRunRef> {
  const { meta } = input;
  const row = await deps.prisma.agentRun.create({
    data: {
      agentType: input.agentType,
      status: input.status,
      provider: meta?.provider ?? null,
      model: meta?.model ?? null,
      prospectId: input.prospectId ?? null,
      threadId: input.threadId ?? null,
      inputPayload: toJson(input.inputPayload),
      rawResponseRedacted: meta?.rawRedacted ?? null,
      parsedOutput: input.parsedOutput === undefined ? undefined : toJson(input.parsedOutput),
      validationErrors:
        input.validationErrors === undefined ? undefined : toJson(input.validationErrors),
      attempts: meta?.attempts ?? 0,
      latencyMs: meta?.latencyMs ?? 0,
      usage: meta?.usage ? toJson(meta.usage) : undefined,
    },
    select: { id: true },
  });
  return row;
}

/** Inputs to write an `AuditLog` row. */
export interface WriteAuditInput {
  action: string;
  actorType?: ActorType;
  actorId?: string;
  entityType: string;
  entityId: string;
  decision?: string;
  allowed?: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * Normalized (lowercased) recipient domain for send/reply/booking-related
   * audit rows (CORR-H3/H4). Optional: only send-lifecycle rows set this; it
   * mirrors (and is redundant with, for cap-counting purposes) the canonical
   * `recipientDomain` column stamped by the atomic reservation write in
   * `reservations.ts` — that reservation row, not these lifecycle rows, is what
   * the per-domain send cap counts. Populating it here too keeps every
   * send-related AuditLog row queryable/filterable by domain directly, without
   * relying on the `metadata` JSON blob.
   */
  recipientDomain?: string;
}

/** Write a single `AuditLog` row. Every external action + decision is audited. */
export async function writeAudit(deps: Deps, input: WriteAuditInput): Promise<void> {
  await deps.prisma.auditLog.create({
    data: {
      action: input.action,
      actorType: input.actorType ?? ActorType.SYSTEM,
      actorId: input.actorId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      decision: input.decision ?? null,
      allowed: input.allowed ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata === undefined ? undefined : toJson(input.metadata),
      idempotencyKey: input.idempotencyKey ?? null,
      recipientDomain: input.recipientDomain ?? null,
    },
  });
}

/**
 * Map a research agent's reported `status` onto the prospect lifecycle status.
 * The `Prospect.status` enum now mirrors the research verdict 1:1:
 *  - researched → `researched`
 *  - partial → `partial`
 *  - insufficient → `insufficient`
 *  - needs_review → `needs_review` (a human-review `ApprovalItem` is also
 *    raised separately to surface the case).
 * Exhaustive over `ResearchStatus` (a `never` check guards the default).
 */
export function prospectStatusFromResearch(status: ResearchOutput['status']): ProspectStatus {
  switch (status) {
    case ResearchStatus.RESEARCHED:
      return ProspectStatus.RESEARCHED;
    case ResearchStatus.PARTIAL:
      return ProspectStatus.PARTIAL;
    case ResearchStatus.INSUFFICIENT:
      return ProspectStatus.INSUFFICIENT;
    case ResearchStatus.NEEDS_REVIEW:
      return ProspectStatus.NEEDS_REVIEW;
    default: {
      const never: never = status;
      throw new Error(`unhandled research status: ${String(never)}`);
    }
  }
}

/**
 * Narrow an unknown value into a Prisma-acceptable JSON input. We round-trip
 * through `JSON.parse(JSON.stringify(...))` to drop `undefined`/functions and
 * guarantee a plain JSON value. Nullish input becomes an empty object so the
 * value is always a valid (non-null) `InputJsonValue`; callers that need an
 * explicit DB null pass `Prisma.JsonNull` themselves.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Read a boolean SystemSetting (e.g. `auto_send_enabled`); default false. */
export async function readBooleanSetting(
  deps: Deps,
  key: string,
  fallback = false,
): Promise<boolean> {
  const row = await deps.prisma.systemSetting.findUnique({ where: { key } });
  if (!row) return fallback;
  const value = row.value as unknown;
  if (typeof value === 'boolean') return value;
  if (value !== null && typeof value === 'object' && 'enabled' in value) {
    const inner = (value as { enabled?: unknown }).enabled;
    return typeof inner === 'boolean' ? inner : fallback;
  }
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return fallback;
}
