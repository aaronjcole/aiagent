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
  EmailAutonomyMode,
  EscalationError,
  ProspectStatus,
  ResearchStatus,
  idempotencyKey,
  type ComplianceReview,
  type ResearchOutput,
} from '@app/shared';
import { draftOutreach, reviewCompliance, type SenderProfile } from '@app/agents';
import {
  buildUnsubscribeHeaders,
  canSendNow,
  checkEligibility,
  checkSuppression,
  createReplyHistoryRepo,
  createSendCountRepo,
  createSuppressionRepo,
  ensureFooter,
  runOutboundGates,
  type AutoSendInput,
  type EmailPolicyDeps,
  type ReplyHistorySnapshot,
} from '@app/compliance';
import type { Deps } from '../deps.js';
import { persistAgentRun, readBooleanSetting, toJson, writeAudit } from './shared.js';

/** Input to {@link outboundSequenceService}: the prospect + sequence to step. */
export interface OutboundSequenceInput {
  prospectId: string;
  sequenceId: string;
}

/** Terminal outcome of one outbound step. */
export type OutboundOutcome = 'sent' | 'pending_approval' | 'ineligible' | 'escalated';

/** Result of one outbound step: outcome plus the draft/approval it produced. */
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

  // --- Resolve the SenderAccount (controlled-autonomy sending identity) ---
  // Look up by the configured from-email. When no row exists, the from-email
  // itself is the sender identity; `senderActive` then reflects the resolved
  // account's `active` flag (defaulting to active when no row constrains it).
  const fromEmail = deps.config.defaultFromEmail;
  const senderAccount = await deps.prisma.senderAccount.findUnique({
    where: { email: fromEmail.trim().toLowerCase() },
    select: { id: true, active: true },
  });
  const senderAccountId = (senderAccount?.id as string | undefined) ?? undefined;
  const senderActive = senderAccount ? senderAccount.active !== false : true;
  // The send/draft idempotency identity: the from-email when no row exists.
  const senderIdentity = senderAccountId ?? fromEmail.trim().toLowerCase();
  const normalizedRecipient = (prospect.email ?? '').trim().toLowerCase();

  // --- Build + persist the DraftEmail with the SPEC idempotency key ---
  // key = idempotencyKey([prospect_id, sequence_id, sequence_step_id,
  //                        sender_account_id, normalized_recipient_email])
  const draftKey = idempotencyKey([
    prospectId,
    sequenceId,
    String(stepNumber),
    senderIdentity,
    normalizedRecipient,
  ]);
  const complianceFlags = {
    decision: complianceReview.decision,
    issues: complianceReview.issues,
    hasUnsupportedClaims: complianceReview.hasUnsupportedClaims,
    gateDecisions: gateResult.decisions,
  };

  const mode = deps.settings.emailAutonomyMode();

  const draftRow = await deps.prisma.draftEmail.upsert({
    where: { idempotencyKey: draftKey },
    create: {
      idempotencyKey: draftKey,
      prospectId,
      sequenceId,
      ...(senderAccountId ? { senderAccountId } : {}),
      fromEmail,
      fromName: deps.config.defaultFromName,
      toEmail: prospect.email,
      subject: draft.subject,
      bodyText: bodyWithFooter,
      // Pre-mark APPROVED only when the legacy gate AND the autonomy mode both
      // clear auto-send; otherwise the conservative PENDING_REVIEW default holds.
      status:
        gateResult.canAutoSend && mode === EmailAutonomyMode.LIMITED_AUTO_SEND
          ? DraftStatus.APPROVED
          : DraftStatus.PENDING_REVIEW,
      complianceStatus: complianceReview.decision,
      complianceFlags: toJson(complianceFlags) as object,
      agentRunId: draftAgentRun.id,
    },
    update: {
      subject: draft.subject,
      bodyText: bodyWithFooter,
      complianceStatus: complianceReview.decision,
      complianceFlags: toJson(complianceFlags) as object,
      ...(senderAccountId ? { senderAccountId } : {}),
    },
  });

  // Short-circuit: this draft was already SENT on a prior run (e.g. a workflow
  // retry replaying after the send + status update committed). Return the sent
  // result WITHOUT calling sendMessage again — prevents a duplicate send.
  if (draftRow.status === DraftStatus.SENT) {
    return { status: 'sent', prospectId, sequenceId, draftId: draftRow.id };
  }

  // --- Branch on the deterministic email autonomy mode ---
  //  DISABLED / DRAFT_ONLY      → draft only, NEVER queue a send/approval-send
  //  APPROVAL_REQUIRED (default)→ draft + human-approval ApprovalItem
  //  LIMITED_AUTO_SEND          → policy-gated auto-send via `canSendNow`,
  //                               falling back to an ApprovalItem on deny.
  if (mode === EmailAutonomyMode.LIMITED_AUTO_SEND) {
    return autoSendBranch(deps, {
      prospectId,
      sequenceId,
      stepNumber,
      draftRow,
      draft,
      bodyWithFooter,
      complianceReview,
      research,
      gateResult,
      fromEmail,
      senderActive,
      senderAccountId,
      normalizedRecipient,
      draftKey,
      replyHistory,
      suppressionResult,
    });
  }

  if (mode === EmailAutonomyMode.DISABLED || mode === EmailAutonomyMode.DRAFT_ONLY) {
    // Draft-only: the DraftEmail exists; we never auto-send and never queue a
    // human-approval SEND item. This is strictly less autonomous than the
    // default approval path.
    await writeAudit(deps, {
      action: 'draft.created',
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'draft_only',
      allowed: false,
      reason: `email autonomy mode is ${mode}; draft only, no send/approval`,
      idempotencyKey: draftKey,
      metadata: { sequenceId, stepNumber, mode },
    });
    return { status: 'pending_approval', prospectId, sequenceId, draftId: draftRow.id };
  }

  // --- APPROVAL_REQUIRED (default + fallback): human-review approval item ---
  return approvalFallback(deps, {
    prospectId,
    sequenceId,
    stepNumber,
    draftRow,
    draft,
    bodyWithFooter,
    complianceReview,
    gateResult,
    draftKey,
    reasons: undefined,
  });
}

/**
 * LIMITED_AUTO_SEND branch: build the `AutoSendInput`, audit `policy.evaluated`,
 * consult `canSendNow` (the deterministic policy layer), and either send (with
 * RFC 8058 unsubscribe headers + the SPEC idempotency key) or fall back to a
 * human-approval ApprovalItem carrying the denial reasons.
 */
async function autoSendBranch(
  deps: Deps,
  args: {
    prospectId: string;
    sequenceId: string;
    stepNumber: number;
    draftRow: { id: string; status: unknown };
    draft: { subject: string };
    bodyWithFooter: string;
    complianceReview: ComplianceReview;
    research: { status?: unknown; confidence?: unknown } | null;
    gateResult: { allowed?: boolean; canAutoSend?: boolean };
    fromEmail: string;
    senderActive: boolean;
    senderAccountId?: string;
    normalizedRecipient: string;
    draftKey: string;
    replyHistory: ReplyHistorySnapshot;
    suppressionResult: { suppressed: boolean; matchedOn?: 'email' | 'domain' };
  },
): Promise<OutboundSequenceResult> {
  const {
    prospectId,
    sequenceId,
    stepNumber,
    draftRow,
    draft,
    bodyWithFooter,
    complianceReview,
    research,
    fromEmail,
    senderActive,
    draftKey,
    replyHistory,
    suppressionResult,
  } = args;

  const policyDeps: EmailPolicyDeps = {
    settings: deps.settings,
    caps: deps.caps,
    config: { ENABLE_AUTO_SEND: deps.config.enableAutoSend },
    now: deps.clock(),
  };

  const researchStatus = String(research?.status ?? 'missing');
  const researchConfidence =
    typeof research?.confidence === 'number' ? (research.confidence as number) : 0;

  const policyInput: AutoSendInput = {
    senderEmail: fromEmail,
    senderActive,
    recipientEmail: args.normalizedRecipient,
    prospectExists: true,
    emailSuppressed: suppressionResult.suppressed && suppressionResult.matchedOn === 'email',
    domainSuppressed: suppressionResult.suppressed && suppressionResult.matchedOn === 'domain',
    unsubscribed: replyHistory.unsubscribed,
    negativeReply: replyHistory.negativeReply,
    threadHasSensitiveFlag: false,
    researchStatus,
    researchConfidence,
    complianceReview: {
      decision: complianceReview.decision,
      confidence: complianceReview.confidence,
    },
    footerPresent: true,
    subject: draft.subject,
    unsupportedClaims: complianceReview.hasUnsupportedClaims ? ['compliance review flagged unsupported claims'] : [],
    prospectId,
    sequenceId,
    prospectSequenceSends: 0,
    sendAtIso: deps.clock().toISOString(),
  };

  // Audit the evaluation BEFORE deciding.
  await writeAudit(deps, {
    action: 'policy.evaluated',
    actorType: ActorType.SYSTEM,
    entityType: 'draft_email',
    entityId: draftRow.id,
    decision: 'auto_send',
    reason: 'evaluating autonomous send policy',
    idempotencyKey: draftKey,
    metadata: { sequenceId, stepNumber, mode: EmailAutonomyMode.LIMITED_AUTO_SEND },
  });

  const decision = await canSendNow(policyInput, policyDeps);

  if (!decision.allow) {
    // Distinguish a pause/kill-switch denial so it is auditable as such.
    const paused = decision.reasons.some((r) => r.toLowerCase().includes('kill switch'));
    await writeAudit(deps, {
      action: paused ? 'killswitch.triggered' : 'policy.denied',
      actorType: ActorType.SYSTEM,
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'denied',
      allowed: false,
      reason: decision.reasons.join('; '),
      idempotencyKey: draftKey,
      metadata: { reasons: decision.reasons, sequenceId, stepNumber },
    });
    if (paused) {
      await writeAudit(deps, {
        action: 'automation.paused',
        actorType: ActorType.SYSTEM,
        entityType: 'draft_email',
        entityId: draftRow.id,
        decision: 'paused',
        allowed: false,
        reason: decision.reasons.join('; '),
        idempotencyKey: draftKey,
        metadata: { reasons: decision.reasons },
      });
    }
    // Safe fallback to the human-approval flow, recording the denial reasons +
    // auto-send-eligibility=false on the ApprovalItem payload.
    return approvalFallback(deps, {
      prospectId,
      sequenceId,
      stepNumber,
      draftRow,
      draft,
      bodyWithFooter,
      complianceReview,
      gateResult: args.gateResult,
      draftKey,
      reasons: decision.reasons,
    });
  }

  await writeAudit(deps, {
    action: 'policy.allowed',
    actorType: ActorType.SYSTEM,
    entityType: 'draft_email',
    entityId: draftRow.id,
    decision: 'allowed',
    allowed: true,
    reason: 'all autonomous-send policy gates passed',
    idempotencyKey: draftKey,
    metadata: { sequenceId, stepNumber },
  });

  // Idempotency short-circuit: the draft already shows SENT (a prior run sent
  // it). Return the existing result without a second send.
  const fresh = await deps.prisma.draftEmail.findUnique({
    where: { idempotencyKey: draftKey },
    select: { id: true, status: true },
  });
  if (fresh?.status === DraftStatus.SENT) {
    return { status: 'sent', prospectId, sequenceId, draftId: draftRow.id };
  }

  await writeAudit(deps, {
    action: 'email.send.attempted',
    actorType: ActorType.SYSTEM,
    entityType: 'draft_email',
    entityId: draftRow.id,
    decision: 'attempting',
    idempotencyKey: draftKey,
    metadata: { sequenceId, stepNumber },
  });

  const headers: Record<string, string> = buildUnsubscribeHeaders({
    settings: deps.settings,
    config: { unsubscribeBaseUrl: deps.config.unsubscribeBaseUrl },
    recipient: args.normalizedRecipient,
  }) as Record<string, string>;

  try {
    const sendResult = await deps.email.sendMessage({
      to: [{ email: args.normalizedRecipient }],
      from: { email: fromEmail, name: deps.config.defaultFromName },
      subject: draft.subject,
      body: bodyWithFooter,
      idempotencyKey: draftKey,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });

    // Mirror the legacy auto-send path: mark SENT + advance prospect status.
    await deps.prisma.draftEmail.update({
      where: { id: draftRow.id },
      data: { status: DraftStatus.SENT, sentAt: deps.clock() },
    });
    await deps.prisma.prospect.update({
      where: { id: prospectId },
      data: { status: ProspectStatus.SEQUENCED },
    });

    await writeAudit(deps, {
      action: 'email.send.succeeded',
      actorType: ActorType.SYSTEM,
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'sent',
      allowed: true,
      reason: 'autonomous send policy allowed; sent',
      idempotencyKey: draftKey,
      metadata: {
        providerMessageId: sendResult.providerMessageId,
        providerThreadId: sendResult.providerThreadId,
        sequenceId,
        stepNumber,
        senderEmail: fromEmail.trim().toLowerCase(),
      },
    });
    // Also record the canonical `email.send` action the CapRepo counts against.
    await writeAudit(deps, {
      action: 'email.send',
      actorType: ActorType.SYSTEM,
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'sent',
      allowed: true,
      reason: 'autonomous send',
      idempotencyKey: draftKey,
      metadata: {
        senderEmail: fromEmail.trim().toLowerCase(),
        recipientDomain: args.normalizedRecipient.split('@')[1] ?? null,
        sequenceId,
        stepNumber,
      },
    });

    return { status: 'sent', prospectId, sequenceId, draftId: draftRow.id };
  } catch (err) {
    // Provider error → audit the failure and fall back to a human-approval item.
    await writeAudit(deps, {
      action: 'email.send.failed',
      actorType: ActorType.SYSTEM,
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'failed',
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
      idempotencyKey: draftKey,
      metadata: { sequenceId, stepNumber },
    });
    return approvalFallback(deps, {
      prospectId,
      sequenceId,
      stepNumber,
      draftRow,
      draft,
      bodyWithFooter,
      complianceReview,
      gateResult: args.gateResult,
      draftKey,
      reasons: ['provider send failed; human review required'],
    });
  }
}

/**
 * Create (or reuse) the human-review OUTREACH_SEND ApprovalItem — the DEFAULT
 * path and the safe fallback for every other branch. When `reasons` is present
 * (a policy denial / send failure) it is recorded with auto-send-eligibility =
 * false on the payload, and a `human_approval.fallback.created` audit is added.
 */
async function approvalFallback(
  deps: Deps,
  args: {
    prospectId: string;
    sequenceId: string;
    stepNumber: number;
    draftRow: { id: string };
    draft: { subject: string };
    bodyWithFooter: string;
    complianceReview: ComplianceReview;
    gateResult: { allowed?: boolean };
    draftKey: string;
    reasons?: string[];
  },
): Promise<OutboundSequenceResult> {
  const { prospectId, sequenceId, stepNumber, draftRow, draft, bodyWithFooter, complianceReview, draftKey, reasons } = args;
  const gateAllowed = args.gateResult.allowed ?? true;

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
          autoSendEligible: false,
          ...(reasons ? { denialReasons: reasons } : {}),
        }) as object,
        reason: reasons
          ? `autonomous send denied: ${reasons.join('; ')}`
          : gateAllowed
            ? 'auto-send disabled; human approval required'
            : 'blocked by a hard gate; human review required',
      },
      select: { id: true },
    }));

  await writeAudit(deps, {
    action: 'draft.created',
    entityType: 'draft_email',
    entityId: draftRow.id,
    decision: reasons ? 'fallback' : gateAllowed ? 'pending_approval' : 'blocked',
    allowed: false,
    reason: reasons
      ? 'autonomous send denied; human approval required'
      : gateAllowed
        ? 'requires human approval'
        : 'blocked by a hard gate',
    idempotencyKey: draftKey,
    metadata: { approvalItemId: approval.id, sequenceId, stepNumber },
  });

  if (reasons) {
    await writeAudit(deps, {
      action: 'human_approval.fallback.created',
      actorType: ActorType.SYSTEM,
      entityType: 'draft_email',
      entityId: draftRow.id,
      decision: 'fallback',
      allowed: false,
      reason: reasons.join('; '),
      idempotencyKey: draftKey,
      metadata: { approvalItemId: approval.id, sequenceId, stepNumber, reasons },
    });
  }

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
