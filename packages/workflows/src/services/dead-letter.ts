/**
 * Dead-letter handling — the durable record of a TERMINAL workflow failure.
 *
 * A terminal failure is one that survived Temporal's retry policy (or was
 * non-retryable). When a workflow body's try/catch sees one, it calls
 * {@link recordTerminalFailure} which, in a single durable pass:
 *   1. writes a `workflow.terminal_failure` AuditLog (allowed:false),
 *   2. creates an `ESCALATION` ApprovalItem so a human reviews the case, and
 *   3. records a `DeadLetter` row (the queryable, resolvable durable record).
 *
 * The workflow then RETHROWS so Temporal still marks the run failed — the
 * durable record exists either way. Graceful agent `EscalationError` handling
 * inside the services is unchanged (that is NOT a terminal failure).
 */

import {
  ActorType,
  ApprovalStatus,
  ApprovalType,
  DeadLetterStatus,
} from '@app/shared';
import type { Deps } from '../deps.js';
import { toJson, writeAudit } from './shared.js';

/** Input to {@link recordTerminalFailure}: the failed workflow + its error. */
export interface RecordTerminalFailureInput {
  /** The workflow type that failed (e.g. `researchProspectWorkflow`). */
  workflowType: string;
  /** The deterministic workflow id, when known. */
  workflowId?: string;
  /** The workflow input that produced the failure. */
  input: unknown;
  /** The terminal error. */
  error: unknown;
}

/** Result: the ids of the durable DeadLetter row + ESCALATION ApprovalItem. */
export interface RecordTerminalFailureResult {
  deadLetterId: string;
  approvalItemId: string;
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Redact a stack trace to a bounded, secret-free string. We keep only the stack
 * (which is class/file/line oriented) and cap its length; we never persist a raw
 * provider body. Returns null when no stack is available.
 */
function redactStack(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === 'string') {
    return error.stack.slice(0, 2000);
  }
  return null;
}

/**
 * Durably record a terminal workflow failure: AuditLog + ESCALATION ApprovalItem
 * + DeadLetter row. Idempotency is NOT required here (Temporal calls this once
 * per terminal failure), but the writes are append-only and safe to repeat.
 */
export async function recordTerminalFailure(
  deps: Deps,
  input: RecordTerminalFailureInput,
): Promise<RecordTerminalFailureResult> {
  const message = errorMessage(input.error);
  const stackRedacted = redactStack(input.error);

  const deadLetter = await deps.prisma.deadLetter.create({
    data: {
      workflowType: input.workflowType,
      workflowId: input.workflowId ?? null,
      input: toJson(input.input) as object,
      error: message,
      stackRedacted,
      status: DeadLetterStatus.OPEN,
    },
    select: { id: true },
  });

  const approval = await deps.prisma.approvalItem.create({
    data: {
      type: ApprovalType.ESCALATION,
      status: ApprovalStatus.PENDING,
      payload: toJson({
        kind: 'workflow_terminal_failure',
        workflowType: input.workflowType,
        workflowId: input.workflowId ?? null,
        deadLetterId: deadLetter.id,
        error: message,
      }) as object,
      reason: `workflow ${input.workflowType} failed terminally: ${message}`,
    },
    select: { id: true },
  });

  await writeAudit(deps, {
    action: 'workflow.terminal_failure',
    actorType: ActorType.SYSTEM,
    entityType: 'workflow',
    entityId: input.workflowId ?? input.workflowType,
    decision: 'failed',
    allowed: false,
    reason: message,
    metadata: {
      workflowType: input.workflowType,
      workflowId: input.workflowId ?? null,
      deadLetterId: deadLetter.id,
      approvalItemId: approval.id,
    },
  });

  return { deadLetterId: deadLetter.id, approvalItemId: approval.id };
}
