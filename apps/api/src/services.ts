/**
 * API services — the small read/write layer the route handlers delegate to.
 *
 * Routes stay thin: they parse/validate input and call one of these functions.
 * Domain orchestration (research/outbound/inbound) lives in `@app/workflows`
 * services + Temporal workflows, NOT here — these functions only do simple
 * reads, list queries, and the explicit human actions the admin UI performs
 * (approve/reject, suppression add/remove, settings toggles), each of which
 * writes an `AuditLog`.
 */

import {
  ActorType,
  ApprovalStatus,
  ApprovalType,
  DraftStatus,
  NotFoundError,
  ValidationError,
  SuppressionReason,
} from '@app/shared';
import type { Prisma, PrismaClient } from '@app/db';
import { addSuppression, createSuppressionRepo } from '@app/compliance';

/** JSON-safe coercion for AuditLog.metadata (drops undefined/functions). */
function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Shape of a single audit-log entry passed to {@link writeAudit}. */
interface AuditInput {
  action: string;
  actorType?: ActorType;
  actorId?: string;
  entityType: string;
  entityId: string;
  decision?: string;
  allowed?: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** Write a single AuditLog row (every state-changing route calls this). */
async function writeAudit(prisma: PrismaClient, input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
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
    },
  });
}

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

/** List all prospects, newest first, each with its related company. */
export async function listProspects(prisma: PrismaClient) {
  return prisma.prospect.findMany({
    orderBy: { createdAt: 'desc' },
    include: { company: true },
  });
}

/** Fetch one prospect (with company) by id; throws NotFoundError if missing. */
export async function getProspect(prisma: PrismaClient, id: string) {
  const prospect = await prisma.prospect.findUnique({
    where: { id },
    include: { company: true },
  });
  if (!prospect) throw new NotFoundError(`prospect not found: ${id}`, { id });
  return prospect;
}

/** Input accepted by {@link createProspect}. */
export interface CreateProspectInput {
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  companyName?: string;
  domain?: string;
}

/** Create a prospect, upserting a Company by domain when one is supplied. */
export async function createProspect(prisma: PrismaClient, input: CreateProspectInput) {
  const email = input.email.trim().toLowerCase();

  let companyId: string | undefined;
  if (input.domain || input.companyName) {
    const domain = input.domain?.trim().toLowerCase();
    const company = domain
      ? await prisma.company.upsert({
          where: { domain },
          create: { name: input.companyName ?? domain, domain },
          update: input.companyName ? { name: input.companyName } : {},
        })
      : await prisma.company.create({ data: { name: input.companyName as string } });
    companyId = company.id;
  }

  const prospect = await prisma.prospect.create({
    data: {
      email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      title: input.title ?? null,
      companyId: companyId ?? null,
      source: 'api',
    },
    include: { company: true },
  });

  await writeAudit(prisma, {
    action: 'prospect.create',
    actorType: ActorType.HUMAN,
    entityType: 'prospect',
    entityId: prospect.id,
    allowed: true,
    reason: 'created via API',
    metadata: { email },
  });

  return prospect;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

/** List research results, newest first, optionally filtered by prospect. */
export async function listResearch(prisma: PrismaClient, prospectId?: string) {
  return prisma.researchResult.findMany({
    where: prospectId ? { prospectId } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

/** Fetch one research result by id; throws NotFoundError if missing. */
export async function getResearch(prisma: PrismaClient, id: string) {
  const row = await prisma.researchResult.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(`research result not found: ${id}`, { id });
  return row;
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

/** List outreach sequences, newest first, each with its ordered steps. */
export async function listSequences(prisma: PrismaClient) {
  return prisma.outreachSequence.findMany({
    orderBy: { createdAt: 'desc' },
    include: { steps: { orderBy: { stepNumber: 'asc' } } },
  });
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** List draft emails, newest first, optionally filtered by status. */
export async function listDrafts(prisma: PrismaClient, status?: string) {
  return prisma.draftEmail.findMany({
    where: status ? { status: status as DraftStatus } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

/** Fetch one draft email by id; throws NotFoundError if missing. */
export async function getDraft(prisma: PrismaClient, id: string) {
  const row = await prisma.draftEmail.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(`draft not found: ${id}`, { id });
  return row;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** List approval items by status (default PENDING), newest first, with their draft. */
export async function listApprovals(
  prisma: PrismaClient,
  status: ApprovalStatus = ApprovalStatus.PENDING,
) {
  return prisma.approvalItem.findMany({
    where: { status: status as ApprovalStatus },
    orderBy: { createdAt: 'desc' },
    include: { draft: true },
  });
}

/** Decision metadata for approving/rejecting an approval item. */
export interface ApprovalDecisionInput {
  reason?: string;
  actor?: string;
}

/**
 * Approve an ApprovalItem. For an OUTREACH_SEND item the linked DraftEmail flips
 * to APPROVED — but we DO NOT auto-send here (auto-send is owned by the workflow
 * + the env/setting kill switches). Always writes an AuditLog.
 */
export async function approveApproval(
  prisma: PrismaClient,
  id: string,
  input: ApprovalDecisionInput,
) {
  const item = await prisma.approvalItem.findUnique({ where: { id } });
  if (!item) throw new NotFoundError(`approval item not found: ${id}`, { id });
  if (item.status !== ApprovalStatus.PENDING) {
    throw new ValidationError(`approval item is not pending (status=${item.status})`, { id });
  }

  const updated = await prisma.approvalItem.update({
    where: { id },
    data: {
      status: ApprovalStatus.APPROVED,
      decidedBy: input.actor ?? 'human',
      decisionNote: input.reason ?? null,
      decidedAt: new Date(),
    },
  });

  // For outreach/reply sends, flip the draft to APPROVED (no auto-send).
  if (
    item.draftId &&
    (item.type === ApprovalType.OUTREACH_SEND || item.type === ApprovalType.REPLY_SEND)
  ) {
    await prisma.draftEmail.update({
      where: { id: item.draftId },
      data: { status: DraftStatus.APPROVED },
    });
  }

  await writeAudit(prisma, {
    action: 'approval.approve',
    actorType: ActorType.HUMAN,
    actorId: input.actor ?? 'human',
    entityType: 'approval_item',
    entityId: id,
    decision: 'approved',
    allowed: true,
    reason: input.reason ?? 'approved by human',
    metadata: { approvalType: item.type, draftId: item.draftId },
  });

  return updated;
}

/** Reject an ApprovalItem; marks a linked draft REJECTED. Always audits. */
export async function rejectApproval(
  prisma: PrismaClient,
  id: string,
  input: ApprovalDecisionInput,
) {
  const item = await prisma.approvalItem.findUnique({ where: { id } });
  if (!item) throw new NotFoundError(`approval item not found: ${id}`, { id });
  if (item.status !== ApprovalStatus.PENDING) {
    throw new ValidationError(`approval item is not pending (status=${item.status})`, { id });
  }

  const updated = await prisma.approvalItem.update({
    where: { id },
    data: {
      status: ApprovalStatus.REJECTED,
      decidedBy: input.actor ?? 'human',
      decisionNote: input.reason ?? null,
      decidedAt: new Date(),
    },
  });

  if (item.draftId) {
    await prisma.draftEmail.update({
      where: { id: item.draftId },
      data: { status: DraftStatus.REJECTED },
    });
  }

  await writeAudit(prisma, {
    action: 'approval.reject',
    actorType: ActorType.HUMAN,
    actorId: input.actor ?? 'human',
    entityType: 'approval_item',
    entityId: id,
    decision: 'rejected',
    allowed: false,
    reason: input.reason ?? 'rejected by human',
    metadata: { approvalType: item.type, draftId: item.draftId },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/** List email threads, most-recently-active first, each with its prospect. */
export async function listThreads(prisma: PrismaClient) {
  return prisma.emailThread.findMany({
    orderBy: { lastMessageAt: 'desc' },
    include: { prospect: true },
  });
}

/** Fetch one thread (with its messages + prospect) by id; throws if missing. */
export async function getThread(prisma: PrismaClient, id: string) {
  const row = await prisma.emailThread.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } }, prospect: true },
  });
  if (!row) throw new NotFoundError(`thread not found: ${id}`, { id });
  return row;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/** List all suppression entries, newest first. */
export async function listSuppression(prisma: PrismaClient) {
  return prisma.suppressionEntry.findMany({ orderBy: { createdAt: 'desc' } });
}

/** Input accepted by {@link addSuppressionEntry} (email and/or domain). */
export interface AddSuppressionApiInput {
  email?: string;
  domain?: string;
  reason?: string;
  notes?: string;
}

/** Deterministically add a suppression entry via @app/compliance + audit. */
export async function addSuppressionEntry(prisma: PrismaClient, input: AddSuppressionApiInput) {
  const repo = createSuppressionRepo(prisma);
  await addSuppression(repo, {
    email: input.email,
    domain: input.domain,
    reason: (input.reason as SuppressionReason | undefined) ?? SuppressionReason.MANUAL,
    source: 'api',
    notes: input.notes,
  });

  // Re-read the persisted row to obtain its id (the compliance repo returns a
  // narrow `SuppressionEntryLike` without the row id).
  const email = input.email?.trim().toLowerCase();
  const domain = input.domain?.trim().toLowerCase();
  const entry = email
    ? await prisma.suppressionEntry.findUnique({ where: { email } })
    : await prisma.suppressionEntry.findUnique({ where: { domain: domain as string } });
  if (!entry) throw new NotFoundError('suppression entry not found after upsert');

  await writeAudit(prisma, {
    action: 'suppression.add',
    actorType: ActorType.HUMAN,
    entityType: 'suppression_entry',
    entityId: entry.id,
    decision: 'suppressed',
    allowed: true,
    reason: input.notes ?? `manual suppression (${entry.reason})`,
    metadata: { email: entry.email, domain: entry.domain, reason: entry.reason },
  });

  return entry;
}

/** Remove a suppression entry by id + audit. */
export async function removeSuppressionEntry(prisma: PrismaClient, id: string) {
  const existing = await prisma.suppressionEntry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError(`suppression entry not found: ${id}`, { id });

  await prisma.suppressionEntry.delete({ where: { id } });

  await writeAudit(prisma, {
    action: 'suppression.remove',
    actorType: ActorType.HUMAN,
    entityType: 'suppression_entry',
    entityId: id,
    decision: 'removed',
    allowed: true,
    reason: 'manual removal via API',
    metadata: { email: existing.email, domain: existing.domain },
  });

  return { id };
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

/** List audit logs (newest first), optionally by entityType; limit clamped to 1–500. */
export async function listAuditLogs(prisma: PrismaClient, entityType?: string, limit = 100) {
  return prisma.auditLog.findMany({
    where: entityType ? { entityType } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 500),
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** List all system settings, sorted by key. */
export async function listSettings(prisma: PrismaClient) {
  return prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
}

/**
 * Upsert a SystemSetting value + audit. NOTE: toggling `auto_send_enabled` here
 * only flips the DB setting; an actual auto-send ALSO requires the env flag
 * (`AUTO_SEND_ENABLED` / `SENDING_ENABLED`) — both gates must agree.
 */
export async function setSetting(prisma: PrismaClient, key: string, value: unknown) {
  const row = await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: toJson(value) },
    update: { value: toJson(value) },
  });

  await writeAudit(prisma, {
    action: 'setting.update',
    actorType: ActorType.HUMAN,
    entityType: 'system_setting',
    entityId: key,
    decision: 'updated',
    allowed: true,
    reason: `set ${key}`,
    metadata: { key, value: toJson(value) },
  });

  return row;
}
