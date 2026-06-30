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

import { createHash } from 'node:crypto';
import {
  ActorType,
  ApprovalStatus,
  ApprovalType,
  DeadLetterStatus,
} from '@app/shared';
import type { Deps } from '../deps.js';
import { toJson } from './shared.js';

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
 * Scrub secret-like substrings from a single line: API keys (`sk-`, `sk-ant-`),
 * bearer tokens, and long opaque tokens. Replaces the secret with `[REDACTED]`
 * so neither the message nor the stack persists a credential.
 */
function scrubSecrets(text: string): string {
  return (
    text
      // Authorization: Bearer <token>  /  bearer <token>
      .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
      // Anthropic / OpenAI style keys: sk-ant-..., sk-...
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9._-]{8,}/g, '[REDACTED]')
      // Long opaque tokens (>= 24 chars of base64/hex-ish): redact conservatively.
      .replace(/\b[A-Za-z0-9._\-+/=]{24,}\b/g, '[REDACTED]')
  );
}

/**
 * Redact an error MESSAGE: scrub secret-like substrings and cap its length. We
 * never persist a raw provider body / credential.
 */
function redactMessage(message: string): string {
  return scrubSecrets(message).slice(0, 2000);
}

/**
 * Redact a stack trace to a bounded, secret-free string. We scrub secret-like
 * substrings from EVERY line (not just truncate) and cap the total length; we
 * never persist a raw provider body. Returns null when no stack is available.
 */
function redactStack(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === 'string') {
    const scrubbed = error.stack
      .split('\n')
      .map((line) => scrubSecrets(line))
      .join('\n');
    return scrubbed.slice(0, 2000);
  }
  return null;
}

/**
 * Stable, deterministic dedupe key for a terminal failure. Derived from the
 * workflowType + workflowId so a Temporal RETRY of the recording activity maps
 * to the SAME key (and thus the same DeadLetter row). Falls back to a SHA-256
 * digest of the FULL serialized input when no workflowId is known, so distinct
 * failures never collide (a truncated prefix could map two different inputs to
 * the same key).
 */
function deriveDedupeKey(input: RecordTerminalFailureInput): string {
  if (input.workflowId) return `${input.workflowType}:${input.workflowId}`;
  let serialized: string;
  try {
    serialized = JSON.stringify(input.input ?? null);
  } catch {
    serialized = String(input.input);
  }
  const digest = createHash('sha256').update(serialized).digest('hex');
  return `${input.workflowType}:${digest}`;
}

/** True when a thrown error is a Prisma unique-constraint (P2002) violation. */
function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (code === 'P2002') return true;
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && /unique/i.test(msg)) return true;
  }
  return false;
}

/**
 * Durably record a terminal workflow failure: AuditLog + ESCALATION ApprovalItem
 * + DeadLetter row.
 *
 * IDEMPOTENT + TRANSACTIONAL. A stable `dedupeKey` (workflowType + workflowId)
 * guards against a Temporal RETRY of this recording: if a DeadLetter with the
 * key already exists, we return its ids WITHOUT creating duplicates. The three
 * writes (DeadLetter + ApprovalItem + audit) happen in a single
 * `prisma.$transaction` so a partial record can never be observed. A concurrent
 * racing insert is caught via the unique constraint and resolved by re-reading.
 */
export async function recordTerminalFailure(
  deps: Deps,
  input: RecordTerminalFailureInput,
): Promise<RecordTerminalFailureResult> {
  const message = redactMessage(errorMessage(input.error));
  const stackRedacted = redactStack(input.error);
  const dedupeKey = deriveDedupeKey(input);

  // Idempotency guard: a prior recording for this terminal failure already
  // exists → reuse it (find the linked ESCALATION ApprovalItem from its payload).
  const existing = await findExistingByDedupeKey(deps, dedupeKey);
  if (existing) return existing;

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const deadLetter = await tx.deadLetter.create({
        data: {
          dedupeKey,
          workflowType: input.workflowType,
          workflowId: input.workflowId ?? null,
          input: toJson(input.input) as object,
          error: message,
          stackRedacted,
          status: DeadLetterStatus.OPEN,
        },
        select: { id: true },
      });

      const approval = await tx.approvalItem.create({
        data: {
          type: ApprovalType.ESCALATION,
          status: ApprovalStatus.PENDING,
          payload: toJson({
            kind: 'workflow_terminal_failure',
            workflowType: input.workflowType,
            workflowId: input.workflowId ?? null,
            deadLetterId: deadLetter.id,
            dedupeKey,
            error: message,
          }) as object,
          reason: `workflow ${input.workflowType} failed terminally: ${message}`,
        },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          action: 'workflow.terminal_failure',
          actorType: ActorType.SYSTEM,
          actorId: null,
          entityType: 'workflow',
          entityId: input.workflowId ?? input.workflowType,
          decision: 'failed',
          allowed: false,
          reason: message,
          metadata: toJson({
            workflowType: input.workflowType,
            workflowId: input.workflowId ?? null,
            deadLetterId: deadLetter.id,
            approvalItemId: approval.id,
            dedupeKey,
          }),
          idempotencyKey: dedupeKey,
        },
      });

      return { deadLetterId: deadLetter.id, approvalItemId: approval.id };
    });
  } catch (err) {
    // A concurrent recording won the race on the unique dedupeKey: re-read and
    // return the winner's ids rather than surfacing a spurious failure.
    if (isUniqueViolation(err)) {
      const winner = await findExistingByDedupeKey(deps, dedupeKey);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Resolve an already-recorded terminal failure by its dedupe key. Returns the
 * DeadLetter id + the linked ESCALATION ApprovalItem id, or null when none.
 */
async function findExistingByDedupeKey(
  deps: Deps,
  dedupeKey: string,
): Promise<RecordTerminalFailureResult | null> {
  const dl = await deps.prisma.deadLetter.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  if (!dl) return null;
  // The audit row carries approvalItemId in metadata; re-read it to return a
  // complete result. Fall back to empty when (legacy) absent.
  const audit = await deps.prisma.auditLog.findFirst({
    where: { idempotencyKey: dedupeKey, action: 'workflow.terminal_failure' },
    select: { metadata: true },
  });
  const meta = (audit?.metadata ?? {}) as { approvalItemId?: string };
  return { deadLetterId: dl.id, approvalItemId: meta.approvalItemId ?? '' };
}
