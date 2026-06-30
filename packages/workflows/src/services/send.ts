/**
 * Send-approved-draft service — the deterministic, audited path that actually
 * SENDS a human-approved draft.
 *
 * This is the human-in-the-loop SEND flow (auto-send stays off). It requires
 * BOTH the master `SENDING_ENABLED` switch AND a human approval (the draft is in
 * status APPROVED). It re-runs the full ordered outbound gate sequence with
 * `hasHumanApproval: true` and only sends when `canSendWithApproval` holds.
 *
 * Idempotency: the send reuses the draft's existing idempotency key, and a draft
 * already in status SENT short-circuits — a rerun never sends twice.
 */

import {
  ActorType,
  DraftStatus,
  ProspectStatus,
  ValidationError,
  idempotencyKey,
  type ComplianceReview,
} from '@app/shared';
import {
  buildUnsubscribeHeaders,
  createReplyHistoryRepo,
  createSendCountRepo,
  createSuppressionRepo,
  runOutboundGates,
  type ReplyHistorySnapshot,
} from '@app/compliance';
import type { Deps } from '../deps.js';
import { readBooleanSetting, writeAudit } from './shared.js';

/** Input to {@link sendApprovedDraft}: the approved draft to send. */
export interface SendApprovedDraftInput {
  draftId: string;
}

/** Whether the approved draft was actually sent or blocked by a gate/switch. */
export type SendApprovedDraftOutcome = 'sent' | 'blocked';

/** Result of the human-approved send path. */
export interface SendApprovedDraftResult {
  status: SendApprovedDraftOutcome;
  draftId: string;
  prospectId?: string;
  reasons?: string[];
}

const ENTITY = 'draft_email';

/**
 * Send a human-APPROVED draft, gated on SENDING_ENABLED + human approval.
 * Throws {@link ValidationError} when the draft is missing or not APPROVED (and
 * not already SENT). Returns `blocked` (with a blocked audit) when a safety gate
 * or the master switch prevents the send. Idempotent on rerun.
 */
export async function sendApprovedDraft(
  deps: Deps,
  input: SendApprovedDraftInput,
): Promise<SendApprovedDraftResult> {
  const { draftId } = input;

  const draftRow = await deps.prisma.draftEmail.findUnique({
    where: { id: draftId },
  });
  if (!draftRow) {
    await writeAudit(deps, {
      action: 'email.send_blocked',
      actorType: ActorType.HUMAN,
      entityType: ENTITY,
      entityId: draftId,
      decision: 'blocked',
      allowed: false,
      reason: 'draft not found',
    });
    throw new ValidationError(`draft not found: ${draftId}`, { draftId });
  }

  // Idempotent short-circuit: already sent → return success, do NOT resend.
  if (draftRow.status === DraftStatus.SENT) {
    return { status: 'sent', draftId, prospectId: draftRow.prospectId as string };
  }

  // Only an APPROVED draft may be sent through this path.
  if (draftRow.status !== DraftStatus.APPROVED) {
    await writeAudit(deps, {
      action: 'email.send_blocked',
      actorType: ActorType.HUMAN,
      entityType: ENTITY,
      entityId: draftId,
      decision: 'blocked',
      allowed: false,
      reason: `draft is not APPROVED (status=${String(draftRow.status)})`,
    });
    throw new ValidationError(
      `draft ${draftId} is not APPROVED (status=${String(draftRow.status)})`,
      { draftId, status: draftRow.status },
    );
  }

  const prospectId = draftRow.prospectId as string;
  const prospect = await deps.prisma.prospect.findUnique({
    where: { id: prospectId },
    include: { company: true },
  });
  if (!prospect) {
    await writeAudit(deps, {
      action: 'email.send_blocked',
      actorType: ActorType.HUMAN,
      entityType: ENTITY,
      entityId: draftId,
      decision: 'blocked',
      allowed: false,
      reason: 'prospect not found',
    });
    throw new ValidationError(`prospect not found for draft ${draftId}`, { draftId, prospectId });
  }

  const sequenceId = (draftRow.sequenceId as string | null) ?? undefined;
  const sequence = sequenceId
    ? await deps.prisma.outreachSequence.findUnique({ where: { id: sequenceId } })
    : null;

  // Reuse the draft's stored compliance verdict so the gate re-runs against the
  // SAME decision a human approved. Fall back to a pass when (legacy) absent.
  const complianceReview: ComplianceReview = {
    decision: (draftRow.complianceStatus as ComplianceReview['decision']) ?? 'pass',
    issues: [],
    hasUnsupportedClaims: false,
    suggestedFixes: [],
    confidence: 1,
  };

  const suppressionRepo = createSuppressionRepo(deps.prisma);
  const replyHistoryRepo = createReplyHistoryRepo(deps.prisma);
  const sendCountRepo = createSendCountRepo(deps.prisma);

  const replyHistory: ReplyHistorySnapshot = {
    unsubscribed: await replyHistoryRepo.hasUnsubscribed(prospectId),
    negativeReply: await replyHistoryRepo.hasNegativeReply(prospectId),
  };

  const systemAutoSend = await readBooleanSetting(deps, 'auto_send_enabled', false);

  const gateResult = await runOutboundGates({
    prospect: { id: prospect.id, email: prospect.email as string | null, status: prospect.status as string },
    toEmail: draftRow.toEmail as string,
    fromEmail: (draftRow.fromEmail as string) ?? deps.config.defaultFromEmail,
    prospectId,
    sequenceId,
    sequenceMaxSteps: (sequence?.maxSteps as number | undefined) ?? deps.config.sequenceMaxSteps,
    replyHistory,
    body: draftRow.bodyText as string,
    complianceReview,
    suppressionRepo,
    sendCountRepo,
    capConfig: {
      dailySendCap: deps.config.dailySendCap,
      perInboxDailyCap: deps.config.perInboxDailyCap,
      perDomainDailyCap: deps.config.perDomainDailyCap,
      sequenceMaxSteps: deps.config.sequenceMaxSteps,
      perProspectMaxSends: deps.config.perProspectMaxSends,
    },
    footerConfig: {
      unsubscribeBaseUrl: deps.config.unsubscribeBaseUrl,
      companyAddress: deps.config.companyAddress,
    },
    config: {
      autoSendEnabled: deps.config.autoSendEnabled,
      sendingEnabled: deps.config.sendingEnabled,
    },
    systemAutoSendSetting: systemAutoSend,
    // This is the human-approved send path.
    hasHumanApproval: true,
  });

  // Reuse the draft's existing idempotency key (idempotent at the provider).
  const sendKey =
    (draftRow.idempotencyKey as string) ?? idempotencyKey([draftId, 'send-approved']);

  // Block: a safety gate failed OR the master switch is off (no human approval
  // can authorize a send while SENDING_ENABLED is off).
  if (!gateResult.canSendWithApproval) {
    const reasons = gateResult.decisions.filter((d) => !d.passed).map((d) => `${d.gate}: ${d.reason}`);
    await writeAudit(deps, {
      action: 'email.send_blocked',
      actorType: ActorType.HUMAN,
      entityType: ENTITY,
      entityId: draftId,
      decision: 'blocked',
      allowed: false,
      reason: gateResult.allowed
        ? 'sending disabled (SENDING_ENABLED off); not sent'
        : `blocked by a safety gate: ${reasons.join('; ')}`,
      idempotencyKey: sendKey,
      metadata: { gateDecisions: gateResult.decisions, sequenceId },
    });
    return { status: 'blocked', draftId, prospectId, reasons };
  }

  // Cleared: safety gates pass + SENDING_ENABLED on + human approval.
  // Attach RFC 8058 / List-Unsubscribe headers when configured (reusing the
  // SPEC idempotency key the draft already carries — idempotent at the provider).
  const headers: Record<string, string> = buildUnsubscribeHeaders({
    settings: deps.settings,
    config: { unsubscribeBaseUrl: deps.config.unsubscribeBaseUrl },
    recipient: (draftRow.toEmail as string).trim().toLowerCase(),
  }) as Record<string, string>;

  const sendResult = await deps.email.sendMessage({
    to: [{ email: draftRow.toEmail as string }],
    from: {
      email: (draftRow.fromEmail as string) ?? deps.config.defaultFromEmail,
      name: (draftRow.fromName as string | null) ?? deps.config.defaultFromName,
    },
    subject: draftRow.subject as string,
    body: draftRow.bodyText as string,
    idempotencyKey: sendKey,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });

  await deps.prisma.draftEmail.update({
    where: { id: draftId },
    data: { status: DraftStatus.SENT, sentAt: deps.clock() },
  });

  // CR fix: advance the prospect lifecycle status the SAME way the autonomous
  // `outboundSequenceService` send path does (ProspectStatus.SEQUENCED), so a
  // human-approved send and an autonomous send leave the prospect consistent.
  await deps.prisma.prospect.update({
    where: { id: prospectId },
    data: { status: ProspectStatus.SEQUENCED },
  });

  await writeAudit(deps, {
    action: 'email.send',
    actorType: ActorType.HUMAN,
    entityType: ENTITY,
    entityId: draftId,
    decision: 'sent',
    allowed: true,
    reason: 'human-approved send; all safety gates passed; sending enabled',
    idempotencyKey: sendKey,
    metadata: {
      providerMessageId: sendResult.providerMessageId,
      providerThreadId: sendResult.providerThreadId,
      sequenceId,
    },
  });

  return { status: 'sent', draftId, prospectId };
}
