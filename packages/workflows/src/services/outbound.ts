/**
 * Outbound service — the durable logic behind `outboundSequenceWorkflow`.
 *
 * Loads prospect/company/research/sequence, runs the deterministic eligibility
 * check, drafts outreach (agent RECOMMENDS), ensures the CAN-SPAM footer
 * (deterministic), runs the LLM compliance review (agent RECOMMENDS), then runs
 * the deterministic ordered gate sequence. The DETERMINISTIC code decides
 * whether to auto-send or to require human approval — the default path is
 * approval. Every gate decision and external action is audited.
 */

import {
  ActorType,
  AgentRunStatus,
  AgentType,
  ApprovalStatus,
  ApprovalType,
  DraftStatus,
  EscalationError,
  ProspectStatus,
  ResearchStatus,
  idempotencyKey,
  type ComplianceReview,
  type ResearchOutput,
} from '@app/shared';
import { draftOutreach, reviewCompliance, type SenderProfile } from '@app/agents';
import {
  checkEligibility,
  checkSuppression,
  createReplyHistoryRepo,
  createSendCountRepo,
  createSuppressionRepo,
  ensureFooter,
  runOutboundGates,
  type ReplyHistorySnapshot,
} from '@app/compliance';
import type { Deps } from '../deps.js';
import { persistAgentRun, readBooleanSetting, toJson, writeAudit } from './shared.js';

export interface OutboundSequenceInput {
  prospectId: string;
  sequenceId: string;
}

export type OutboundOutcome = 'sent' | 'pending_approval' | 'ineligible' | 'escalated';

export interface OutboundSequenceResult {
  status: OutboundOutcome;
  prospectId: string;
  sequenceId: string;
  draftId?: string;
  approvalItemId?: string;
  reasons?: string[];
}

const ENTITY = 'prospect';

/** Run a single outbound sequence step for a prospect. */
export async function outboundSequenceService(
  deps: Deps,
  input: OutboundSequenceInput,
): Promise<OutboundSequenceResult> {
  const { prospectId, sequenceId } = input;

  const prospect = await deps.prisma.prospect.findUnique({
    where: { id: prospectId },
    include: { company: true },
  });
  if (!prospect) {
    await writeAudit(deps, {
      action: 'outbound.prospect_not_found',
      entityType: ENTITY,
      entityId: prospectId,
      allowed: false,
      reason: 'prospect not found',
    });
    return { status: 'ineligible', prospectId, sequenceId, reasons: ['prospect not found'] };
  }

  const sequence = await deps.prisma.outreachSequence.findUnique({
    where: { id: sequenceId },
  });
  // The sequence must exist AND belong to this prospect. A missing or
  // mismatched sequence is ineligible — never fall through to `currentStep = 0`
  // (which would silently treat it as a brand-new sequence for this prospect).
  if (!sequence || sequence.prospectId !== prospectId) {
    const reason = sequence
      ? 'sequence does not belong to prospect'
      : 'sequence not found';
    await writeAudit(deps, {
      action: 'outbound.sequence_not_found',
      entityType: ENTITY,
      entityId: prospectId,
      allowed: false,
      reason,
      metadata: { sequenceId },
    });
    return { status: 'ineligible', prospectId, sequenceId, reasons: [reason] };
  }
  const currentStep = sequence.currentStep ?? 0;
  const stepNumber = currentStep + 1;

  const research = await deps.prisma.researchResult.findFirst({
    where: { prospectId },
    orderBy: { createdAt: 'desc' },
  });

  // --- Eligibility (deterministic) ---
  const suppressionRepo = createSuppressionRepo(deps.prisma);
  const replyHistoryRepo = createReplyHistoryRepo(deps.prisma);

  const suppressionResult = await checkSuppression(suppressionRepo, {
    email: prospect.email,
    // Also check the recipient domain so a domain-suppressed prospect is blocked
    // up front (before any LLM drafting), not just on the later gate.
    domain: prospect.email?.split('@')[1]?.toLowerCase(),
  });
  const replyHistory: ReplyHistorySnapshot = {
    unsubscribed: await replyHistoryRepo.hasUnsubscribed(prospectId),
    negativeReply: await replyHistoryRepo.hasNegativeReply(prospectId),
  };

  const eligibility = checkEligibility({
    prospect: { id: prospect.id, email: prospect.email, status: prospect.status },
    research: research ? { status: research.status } : null,
    replyHistory,
    suppressionResult,
  });

  if (!eligibility.eligible) {
    await writeAudit(deps, {
      action: 'outbound.ineligible',
      entityType: ENTITY,
      entityId: prospectId,
      decision: 'ineligible',
      allowed: false,
      reason: eligibility.reasons.join('; '),
      metadata: { reasons: eligibility.reasons, sequenceId, stepNumber },
    });
    // If suppressed, reflect it on the prospect.
    if (suppressionResult.suppressed) {
      await deps.prisma.prospect.update({
        where: { id: prospectId },
        data: { status: ProspectStatus.SUPPRESSED },
      });
    }
    return { status: 'ineligible', prospectId, sequenceId, reasons: eligibility.reasons };
  }

  const researchOutput = (research?.output ?? null) as ResearchOutput | null;
  const senderProfile: SenderProfile = {
    name: deps.config.defaultFromName,
    email: deps.config.defaultFromEmail,
  };

  // --- Draft outreach (agent RECOMMENDS) ---
  let draft;
  let draftMeta;
  try {
    const result = await draftOutreach(
      {
        prospect: {
          email: prospect.email,
          name: [prospect.firstName, prospect.lastName].filter(Boolean).join(' ').trim() || undefined,
          title: prospect.title ?? undefined,
          companyName: prospect.company?.name ?? undefined,
        },
        company: prospect.company
          ? {
              name: prospect.company.name ?? undefined,
              domain: prospect.company.domain ?? undefined,
              industry: prospect.company.industry ?? undefined,
              description: prospect.company.description ?? undefined,
            }
          : undefined,
        research: researchOutput ?? emptyResearch(),
        sequenceStep: stepNumber,
        senderProfile,
      },
      deps.llmClient,
    );
    draft = result.output;
    draftMeta = result.meta;
  } catch (err) {
    if (err instanceof EscalationError) {
      return escalateOutbound(deps, prospectId, sequenceId, 'outreach', err);
    }
    throw err;
  }

  const draftAgentRun = await persistAgentRun(deps, {
    agentType: AgentType.OUTREACH,
    status: AgentRunStatus.SUCCEEDED,
    meta: draftMeta,
    prospectId,
    inputPayload: { sequenceStep: stepNumber, prospectEmail: prospect.email },
    parsedOutput: draft,
  });

  // --- Footer (deterministic) ---
  const footer = ensureFooter(draft.body, {
    unsubscribeBaseUrl: deps.config.unsubscribeBaseUrl,
    companyAddress: deps.config.companyAddress,
  });
  const bodyWithFooter = footer.body;

  // --- Compliance review (agent RECOMMENDS the verdict) ---
  let complianceReview: ComplianceReview;
  let complianceMeta;
  try {
    const result = await reviewCompliance(
      {
        draftSubject: draft.subject,
        draftBody: bodyWithFooter,
        prospect: {
          email: prospect.email,
          name: [prospect.firstName, prospect.lastName].filter(Boolean).join(' ').trim() || undefined,
          title: prospect.title ?? undefined,
          companyName: prospect.company?.name ?? undefined,
        },
        research: researchOutput ?? undefined,
        policySummary:
          'CAN-SPAM: truthful subject, physical postal address, working unsubscribe, no deceptive claims; respectful B2B tone.',
      },
      deps.llmClient,
    );
    complianceReview = result.output;
    complianceMeta = result.meta;
  } catch (err) {
    if (err instanceof EscalationError) {
      return escalateOutbound(deps, prospectId, sequenceId, 'compliance', err);
    }
    throw err;
  }

  await persistAgentRun(deps, {
    agentType: AgentType.COMPLIANCE,
    status: AgentRunStatus.SUCCEEDED,
    meta: complianceMeta,
    prospectId,
    inputPayload: { draftSubject: draft.subject },
    parsedOutput: complianceReview,
  });

  // --- Deterministic ordered gate sequence ---
  const sendCountRepo = createSendCountRepo(deps.prisma);
  const systemAutoSend = await readBooleanSetting(deps, 'auto_send_enabled', false);

  const gateResult = await runOutboundGates({
    prospect: { id: prospect.id, email: prospect.email, status: prospect.status },
    fromEmail: deps.config.defaultFromEmail,
    prospectId,
    sequenceId,
    sequenceMaxSteps: sequence.maxSteps ?? deps.config.sequenceMaxSteps,
    replyHistory,
    body: bodyWithFooter,
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
    hasHumanApproval: false,
  });

  // Audit EVERY gate decision.
  for (const decision of gateResult.decisions) {
    await writeAudit(deps, {
      action: `outbound.gate.${decision.gate}`,
      entityType: ENTITY,
      entityId: prospectId,
      decision: decision.passed ? 'pass' : 'fail',
      allowed: decision.passed,
      reason: decision.reason,
      metadata: { sequenceId, stepNumber },
    });
  }

  // --- Build + persist the DraftEmail with a stable idempotency key ---
  const draftKey = idempotencyKey([prospectId, sequenceId, String(stepNumber)]);
  const complianceFlags = {
    decision: complianceReview.decision,
    issues: complianceReview.issues,
    hasUnsupportedClaims: complianceReview.hasUnsupportedClaims,
    gateDecisions: gateResult.decisions,
  };

  const draftRow = await deps.prisma.draftEmail.upsert({
    where: { idempotencyKey: draftKey },
    create: {
      idempotencyKey: draftKey,
      prospectId,
      sequenceId,
      fromEmail: deps.config.defaultFromEmail,
      fromName: deps.config.defaultFromName,
      toEmail: prospect.email,
      subject: draft.subject,
      bodyText: bodyWithFooter,
      status: gateResult.canAutoSend ? DraftStatus.APPROVED : DraftStatus.PENDING_REVIEW,
      complianceStatus: complianceReview.decision,
      complianceFlags: toJson(complianceFlags) as object,
      agentRunId: draftAgentRun.id,
    },
    update: {
      subject: draft.subject,
      bodyText: bodyWithFooter,
      complianceStatus: complianceReview.decision,
      complianceFlags: toJson(complianceFlags) as object,
    },
  });

  // Short-circuit: this draft was already SENT on a prior run (e.g. a workflow
  // retry replaying after the send + status update committed). Return the sent
  // result WITHOUT calling sendMessage again — prevents a duplicate send.
  if (draftRow.status === DraftStatus.SENT) {
    return { status: 'sent', prospectId, sequenceId, draftId: draftRow.id };
  }

  // --- Auto-send vs. approval ---
  // Defense-in-depth: even though `canAutoSend` already accounts for the master
  // kill switch, re-check `config.sendingEnabled` at the actual send site so a
  // safety-critical action can never fire while the switch is off.
  if (gateResult.canAutoSend && deps.config.sendingEnabled) {
    const sendResult = await deps.email.sendMessage({
      to: [{ email: prospect.email }],
      from: { email: deps.config.defaultFromEmail, name: deps.config.defaultFromName },
      subject: draft.subject,
      body: bodyWithFooter,
      idempotencyKey: draftKey,
    });

    await deps.prisma.draftEmail.update({
      where: { id: draftRow.id },
      data: { status: DraftStatus.SENT, sentAt: deps.clock() },
    });

    await deps.prisma.prospect.update({
      where: { id: prospectId },
      data: { status: ProspectStatus.SEQUENCED },
    });

    await writeAudit(deps, {
      action: 'email.send',
      actorType: ActorType.SYSTEM,
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'sent',
      allowed: true,
      reason: 'all gates passed; auto-send enabled',
      idempotencyKey: draftKey,
      metadata: {
        providerMessageId: sendResult.providerMessageId,
        providerThreadId: sendResult.providerThreadId,
        sequenceId,
        stepNumber,
      },
    });

    return { status: 'sent', prospectId, sequenceId, draftId: draftRow.id };
  }

  // Default path: surface a human-review approval item and wait. Reuse an
  // existing PENDING OUTREACH_SEND item for this draft if one already exists
  // (e.g. a workflow rerun) so we never queue duplicate review entries.
  const existingApproval = await deps.prisma.approvalItem.findFirst({
    where: {
      draftId: draftRow.id,
      type: ApprovalType.OUTREACH_SEND,
      status: ApprovalStatus.PENDING,
    },
    select: { id: true },
  });
  const approval =
    existingApproval ??
    (await deps.prisma.approvalItem.create({
      data: {
        type: ApprovalType.OUTREACH_SEND,
        status: ApprovalStatus.PENDING,
        prospectId,
        draftId: draftRow.id,
        payload: toJson({
          subject: draft.subject,
          body: bodyWithFooter,
          complianceDecision: complianceReview.decision,
          gateDecisions: gateResult.decisions,
        }) as object,
        reason: gateResult.allowed
          ? 'auto-send disabled; human approval required'
          : 'blocked by a hard gate; human review required',
      },
      select: { id: true },
    }));

  await writeAudit(deps, {
    action: 'draft.created',
    entityType: 'draft_email',
    entityId: draftRow.id,
    decision: gateResult.allowed ? 'pending_approval' : 'blocked',
    allowed: false,
    reason: gateResult.allowed
      ? 'requires human approval'
      : 'blocked by a hard gate',
    idempotencyKey: draftKey,
    metadata: { approvalItemId: approval.id, sequenceId, stepNumber },
  });

  return {
    status: 'pending_approval',
    prospectId,
    sequenceId,
    draftId: draftRow.id,
    approvalItemId: approval.id,
  };
}

/** A neutral empty research output for the rare case research is missing but the
 * eligibility check (which would have blocked) was bypassed in a test. */
function emptyResearch(): ResearchOutput {
  return {
    status: ResearchStatus.PARTIAL,
    summary: '',
    companyInsights: '',
    personalizationPoints: [],
    sources: [],
    dataGaps: [],
    confidence: 0.5,
    riskFlags: [],
  };
}

/** Record an outbound escalation (agent EscalationError) + ApprovalItem. */
async function escalateOutbound(
  deps: Deps,
  prospectId: string,
  sequenceId: string,
  stage: 'outreach' | 'compliance',
  err: EscalationError,
): Promise<OutboundSequenceResult> {
  const agentType = stage === 'outreach' ? AgentType.OUTREACH : AgentType.COMPLIANCE;
  const agentRun = await persistAgentRun(deps, {
    agentType,
    status: AgentRunStatus.ESCALATED,
    prospectId,
    inputPayload: { stage, sequenceId },
    validationErrors: err.details ?? { message: err.message },
  });

  const approval = await deps.prisma.approvalItem.create({
    data: {
      type: ApprovalType.ESCALATION,
      status: ApprovalStatus.PENDING,
      prospectId,
      payload: toJson({ kind: `${stage}_escalation`, error: err.message }) as object,
      reason: `${stage} agent escalated`,
    },
    select: { id: true },
  });

  await writeAudit(deps, {
    action: `outbound.${stage}.escalated`,
    actorType: ActorType.AGENT,
    entityType: ENTITY,
    entityId: prospectId,
    decision: 'escalated',
    allowed: false,
    reason: err.message,
    metadata: { agentRunId: agentRun.id, approvalItemId: approval.id, sequenceId },
  });

  return { status: 'escalated', prospectId, sequenceId, approvalItemId: approval.id };
}
