/**
 * Pure helper that builds an `AuditLog`-shaped payload. Writing the row is the
 * caller/workflow's responsibility (this package performs no I/O for audit).
 */

import type { ActorType } from '@app/shared';

/**
 * Structural shape matching the writable fields of the Prisma `AuditLog` model.
 * `Prisma.AuditLogCreateInput` would satisfy this; we keep a local shape so the
 * deterministic core stays free of Prisma input types.
 */
export interface AuditLogPayload {
  action: string;
  actorType: ActorType;
  actorId: string | null;
  entityType: string;
  entityId: string;
  decision: string | null;
  allowed: boolean | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  idempotencyKey: string | null;
}

/** Input for {@link buildAuditLogPayload}; optional fields default to null. */
export interface BuildAuditLogInput {
  action: string;
  actorType: ActorType;
  actorId?: string;
  entityType: string;
  entityId: string;
  decision?: string;
  allowed?: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** Build a normalized AuditLog payload (optional fields become explicit null). */
export function buildAuditLogPayload(input: BuildAuditLogInput): AuditLogPayload {
  return {
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    decision: input.decision ?? null,
    allowed: input.allowed ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}
