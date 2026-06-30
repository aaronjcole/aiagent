/**
 * Inbound service — the durable logic behind `inboundEmailWorkflow`.
 *
 * Order of operations is safety-first:
 *   1. dedup on providerMessageId (never double-process),
 *   2. persist the thread/message,
 *   3. DETERMINISTIC unsubscribe check FIRST (the LLM can never override an
 *      opt-out),
 *   4. otherwise classify (agent RECOMMENDS) and branch with an EXHAUSTIVE
 *      switch over the inbound category.
 *
 * For scheduling, an initial reply produces a PROPOSED `CalendarEvent` (never a
 * provider event) and a draft reply; a real event is only created via
 * `confirmAndCreateCalendarEvent` once the recipient confirms.
 */

import {
  ActorType,
  AgentRunStatus,
  AgentType,
  ApprovalStatus,
  ApprovalType,
  DraftStatus,
  EmailDirection,
  EscalationError,
  ProspectStatus,
  SuppressionReason,
  idempotencyKey,
  isAppError,
  type InboundClassification,
  type SchedulingExtraction,
} from '@app/shared';
import {
  classifyInbound,
  draftSchedulingReply,
  extractScheduling,
} from '@app/agents';
import {
  addSuppression,
  classifyUnsubscribe,
  createSuppressionRepo,
} from '@app/compliance';
import type { EmailThreadDTO } from '@app/email';
import type { Deps } from '../deps.js';
import { proposeCalendarEvent } from './calendar.js';
import { isValidIanaTimezone } from './tz.js';
import { persistAgentRun, toJson, writeAudit } from './shared.js';

/** Input to {@link inboundEmailService}: identifies the message/thread to process. */
export interface InboundEmailInput {
  providerMessageId?: string;
  threadId?: string;
}

/** Terminal outcome of processing one inbound email. */
export type InboundOutcome =
  | 'duplicate'
  | 'unsubscribed'
  | 'scheduling_proposed'
  | 'scheduling_clarify'
  | 'escalated'
  | 'handled';

/** Result of processing one inbound email: outcome plus the rows it touched. */
export interface InboundEmailResult {
  status: InboundOutcome;
  threadId?: string;
  messageId?: string;
  category?: InboundClassification['category'];
  draftId?: string;
  approvalItemId?: string;
  calendarEventId?: string;
}

const ENTITY = 'email_message';

/** Confidence below which a non-scheduling category is escalated. */
const LOW_CONFIDENCE = 0.6;

/** Process a single inbound email. */
export async function inboundEmailService(
  deps: Deps,
  input: InboundEmailInput,
): Promise<InboundEmailResult> {
  // --- Dedup ---
  if (input.providerMessageId) {
    const existing = await deps.prisma.emailMessage.findUnique({
      where: { providerMessageId: input.providerMessageId },
      select: { id: true, threadId: true },
    });
    if (existing) {
      await writeAudit(deps, {
        action: 'inbound.duplicate',
        entityType: ENTITY,
        entityId: existing.id,
        decision: 'skipped',
        allowed: false,
        reason: 'providerMessageId already processed',
        metadata: { providerMessageId: input.providerMessageId },
      });
      return { status: 'duplicate', messageId: existing.id, threadId: existing.threadId };
    }
  }

  if (!input.threadId) {
    await writeAudit(deps, {
      action: 'inbound.no_thread',
      entityType: ENTITY,
      entityId: input.providerMessageId ?? 'unknown',
      allowed: false,
      reason: 'no threadId provided',
    });
    return { status: 'handled' };
  }

  // --- Load the thread from the provider ---
  const thread = await deps.email.getThread(input.threadId);
  const inboundMsg = selectInboundMessage(thread, input.providerMessageId);

  // --- Persist EmailThread + EmailMessage ---
  const { threadRowId, prospectId } = await persistThreadAndMessage(deps, thread, inboundMsg);

  const bodyText = inboundMsg.body;
  const subject = inboundMsg.subject;
  const fromEmail = inboundMsg.from.email;

  // --- DETERMINISTIC unsubscribe check FIRST (never LLM-overridable) ---
  // Pass the subject too so a subject-line opt-out (e.g. "Subject: unsubscribe")
  // is caught, not just body phrases.
  const unsub = classifyUnsubscribe({ body: bodyText, subject });
  if (unsub.isUnsubscribe) {
    return suppressAndConfirm(deps, {
      threadRowId,
      messageRowId: inboundMsg.persistedId,
      prospectId,
      fromEmail,
      threadProviderId: thread.providerThreadId,
      subject,
      matchedPhrase: unsub.matchedPhrase,
      via: 'deterministic',
    });
  }

  // --- Classify (agent RECOMMENDS) ---
  let classification: InboundClassification;
  let classifyMeta;
  try {
    const result = await classifyInbound(
      { subject, body: bodyText, fromEmail, threadContext: threadContext(thread) },
      deps.llmClient,
    );
    classification = result.output;
    classifyMeta = result.meta;
  } catch (err) {
    if (err instanceof EscalationError) {
      // The classifier escalated WITHOUT reaching the success path, so no
      // AgentRun was persisted yet. Persist an escalated run here so the
      // escalation is observable (escalateInbound skips it for the classifier to
      // avoid a duplicate when a SUCCEEDED run already exists).
      await persistAgentRun(deps, {
        agentType: AgentType.INBOUND_CLASSIFIER,
        status: AgentRunStatus.ESCALATED,
        prospectId,
        threadId: threadRowId,
        inputPayload: { subject, fromEmail },
        validationErrors: err.details ?? { message: err.message },
      });
      return escalateInbound(deps, {
        threadRowId,
        messageRowId: inboundMsg.persistedId,
        prospectId,
        category: 'other',
        reason: `classifier escalated: ${err.message}`,
        details: isAppError(err) ? err.details : undefined,
        agentType: AgentType.INBOUND_CLASSIFIER,
      });
    }
    throw err;
  }

  await persistAgentRun(deps, {
    agentType: AgentType.INBOUND_CLASSIFIER,
    status: AgentRunStatus.SUCCEEDED,
    meta: classifyMeta,
    prospectId,
    threadId: threadRowId,
    inputPayload: { subject, fromEmail },
    parsedOutput: classification,
  });

  await writeAudit(deps, {
    action: 'inbound.classified',
    actorType: ActorType.AGENT,
    entityType: ENTITY,
    entityId: inboundMsg.persistedId,
    decision: classification.category,
    reason: classification.reasons.join('; '),
    metadata: { requiresHuman: classification.requiresHuman, confidence: classification.confidence },
  });

  // --- Exhaustive branch over the inbound category ---
  const category = classification.category;
  switch (category) {
    case 'interested_schedule': {
      // Only high-confidence, non-sensitive scheduling replies proceed to the
      // automated scheduling flow. If the classifier wants a human or is
      // low-confidence, escalate (same pattern as the other categories) rather
      // than auto-drafting / proposing a meeting.
      if (classification.requiresHuman || classification.confidence < LOW_CONFIDENCE) {
        return escalateInbound(deps, {
          threadRowId,
          messageRowId: inboundMsg.persistedId,
          prospectId,
          category,
          reason: classification.reasons.join('; ') || `low-confidence scheduling (${classification.confidence})`,
          agentType: AgentType.INBOUND_CLASSIFIER,
        });
      }
      return handleScheduling(deps, {
        threadRowId,
        messageRowId: inboundMsg.persistedId,
        prospectId,
        thread,
        inboundMsg,
        classification,
      });
    }

    case 'unsubscribe':
      // Defense in depth: classifier says unsubscribe even though the
      // deterministic check didn't fire — honor it.
      return suppressAndConfirm(deps, {
        threadRowId,
        messageRowId: inboundMsg.persistedId,
        prospectId,
        fromEmail,
        threadProviderId: thread.providerThreadId,
        subject,
        matchedPhrase: null,
        via: 'classifier',
      });

    case 'pricing':
    case 'legal':
    case 'security':
    case 'procurement':
    case 'angry':
    case 'not_interested':
    case 'question':
    case 'referral':
    case 'out_of_office':
    case 'other': {
      if (classification.requiresHuman || classification.confidence < LOW_CONFIDENCE) {
        return escalateInbound(deps, {
          threadRowId,
          messageRowId: inboundMsg.persistedId,
          prospectId,
          category,
          reason: classification.reasons.join('; ') || `category ${category}`,
          agentType: AgentType.INBOUND_CLASSIFIER,
        });
      }
      // High-confidence, non-sensitive: record handling; no automated action.
      await writeAudit(deps, {
        action: 'inbound.handled',
        entityType: ENTITY,
        entityId: inboundMsg.persistedId,
        decision: category,
        allowed: true,
        reason: 'no automated action required',
      });
      return { status: 'handled', threadId: threadRowId, messageId: inboundMsg.persistedId, category };
    }

    default: {
      const never: never = category;
      throw new Error(`unhandled inbound category: ${String(never)}`);
    }
  }
}

/** A persisted inbound message (the provider DTO plus our row id). */
interface PersistedInboundMessage {
  persistedId: string;
  providerMessageId: string;
  subject: string;
  body: string;
  from: { email: string; name?: string };
}

/** Pick the inbound message to process from the thread. */
function selectInboundMessage(
  thread: EmailThreadDTO,
  providerMessageId: string | undefined,
): PersistedInboundMessage {
  const byId = providerMessageId
    ? thread.messages.find((m) => m.providerMessageId === providerMessageId)
    : undefined;
  const inbound = [...thread.messages].reverse().find((m) => m.direction === EmailDirection.INBOUND);
  const chosen = byId ?? inbound ?? thread.messages[thread.messages.length - 1];
  if (!chosen) {
    throw new Error('thread has no messages to process');
  }
  return {
    persistedId: '', // filled after persistence
    providerMessageId: chosen.providerMessageId,
    subject: chosen.subject,
    body: chosen.body,
    from: { email: chosen.from.email, ...(chosen.from.name ? { name: chosen.from.name } : {}) },
  };
}

/** Upsert the thread and inbound message, returning their row ids + prospect. */
async function persistThreadAndMessage(
  deps: Deps,
  thread: EmailThreadDTO,
  inboundMsg: PersistedInboundMessage,
): Promise<{ threadRowId: string; prospectId: string | null }> {
  // Find the prospect by the inbound sender, if known.
  const prospect = await deps.prisma.prospect.findUnique({
    where: { email: inboundMsg.from.email.trim().toLowerCase() },
    select: { id: true },
  });
  const prospectId = prospect?.id ?? null;

  // Upsert the thread by provider thread id. The schema requires prospectId on
  // EmailThread; if we cannot resolve a prospect we cannot persist the thread,
  // so we fall back to a synthetic row only when a prospect exists.
  const existingThread = await deps.prisma.emailThread.findUnique({
    where: { providerThreadId: thread.providerThreadId },
    select: { id: true, prospectId: true },
  });

  let threadRowId: string;
  if (existingThread) {
    threadRowId = existingThread.id;
  } else if (prospectId) {
    const created = await deps.prisma.emailThread.create({
      data: {
        prospectId,
        subject: thread.subject,
        providerThreadId: thread.providerThreadId,
        lastMessageAt: deps.clock(),
      },
      select: { id: true },
    });
    threadRowId = created.id;
  } else {
    // No prospect: we still want to process (e.g. unsubscribe), but cannot tie a
    // thread row. Use a sentinel and skip the message row persistence below.
    inboundMsg.persistedId = `unpersisted_${thread.providerThreadId}`;
    return { threadRowId: `unpersisted_${thread.providerThreadId}`, prospectId };
  }

  const message = await deps.prisma.emailMessage.upsert({
    where: { providerMessageId: inboundMsg.providerMessageId },
    create: {
      threadId: threadRowId,
      direction: EmailDirection.INBOUND,
      providerMessageId: inboundMsg.providerMessageId,
      fromEmail: inboundMsg.from.email,
      toEmail: deps.config.defaultFromEmail,
      subject: inboundMsg.subject,
      bodyText: inboundMsg.body,
      receivedAt: deps.clock(),
    },
    update: {},
    select: { id: true },
  });
  inboundMsg.persistedId = message.id;
  return { threadRowId, prospectId };
}

/** Deterministically add a suppression entry + optional confirmation draft. */
async function suppressAndConfirm(
  deps: Deps,
  args: {
    threadRowId: string;
    messageRowId: string;
    prospectId: string | null;
    fromEmail: string;
    threadProviderId: string;
    subject: string;
    matchedPhrase: string | null;
    via: 'deterministic' | 'classifier';
  },
): Promise<InboundEmailResult> {
  const suppressionRepo = createSuppressionRepo(deps.prisma);
  await addSuppression(suppressionRepo, {
    email: args.fromEmail,
    reason: SuppressionReason.UNSUBSCRIBE,
    source: `inbound:${args.via}`,
    notes: args.matchedPhrase ? `matched "${args.matchedPhrase}"` : undefined,
  });

  if (args.prospectId) {
    await deps.prisma.prospect.update({
      where: { id: args.prospectId },
      data: { status: ProspectStatus.UNSUBSCRIBED },
    });
  }

  await writeAudit(deps, {
    action: 'suppression.add',
    actorType: ActorType.SYSTEM,
    entityType: ENTITY,
    entityId: args.messageRowId,
    decision: 'unsubscribe',
    allowed: true,
    reason: args.matchedPhrase ? `matched "${args.matchedPhrase}"` : `via ${args.via}`,
    metadata: { fromEmail: args.fromEmail, via: args.via },
  });

  // Optionally draft a confirmation reply (NEVER auto-sent).
  let draftId: string | undefined;
  if (args.prospectId) {
    const draftKey = idempotencyKey([args.threadProviderId, 'unsubscribe-confirm']);
    const draftRow = await deps.prisma.draftEmail.upsert({
      where: { idempotencyKey: draftKey },
      create: {
        idempotencyKey: draftKey,
        prospectId: args.prospectId,
        threadId: args.threadRowId,
        fromEmail: deps.config.defaultFromEmail,
        fromName: deps.config.defaultFromName,
        toEmail: args.fromEmail,
        subject: `Re: ${args.subject}`,
        bodyText:
          "You've been unsubscribed and will not receive further emails from us. If this was a mistake, just reply and let us know.",
        status: DraftStatus.PENDING_REVIEW,
        complianceStatus: 'pass',
      },
      update: {},
      select: { id: true },
    });
    draftId = draftRow.id;
  }

  return {
    status: 'unsubscribed',
    threadId: args.threadRowId,
    messageId: args.messageRowId,
    category: 'unsubscribe',
    draftId,
  };
}

/** Handle an `interested_schedule` reply: extract → (clarify | propose). */
async function handleScheduling(
  deps: Deps,
  args: {
    threadRowId: string;
    messageRowId: string;
    prospectId: string | null;
    thread: EmailThreadDTO;
    inboundMsg: PersistedInboundMessage;
    classification: InboundClassification;
  },
): Promise<InboundEmailResult> {
  const nowIso = deps.clock().toISOString();

  // --- Extract scheduling intent (agent RECOMMENDS) ---
  let extraction: SchedulingExtraction;
  let extractMeta;
  try {
    const result = await extractScheduling(
      {
        subject: args.inboundMsg.subject,
        body: args.inboundMsg.body,
        threadContext: threadContext(args.thread),
        nowIso,
        defaultTimezone: undefined,
      },
      deps.llmClient,
    );
    extraction = result.output;
    extractMeta = result.meta;
  } catch (err) {
    if (err instanceof EscalationError) {
      return escalateInbound(deps, {
        threadRowId: args.threadRowId,
        messageRowId: args.messageRowId,
        prospectId: args.prospectId,
        category: 'interested_schedule',
        reason: `scheduling extractor escalated: ${err.message}`,
        details: isAppError(err) ? err.details : undefined,
        agentType: AgentType.SCHEDULING_EXTRACTOR,
      });
    }
    throw err;
  }

  await persistAgentRun(deps, {
    agentType: AgentType.SCHEDULING_EXTRACTOR,
    status: AgentRunStatus.SUCCEEDED,
    meta: extractMeta,
    prospectId: args.prospectId,
    threadId: args.threadRowId,
    inputPayload: { subject: args.inboundMsg.subject, nowIso },
    parsedOutput: extraction,
  });

  // --- Ambiguous / absent / INVALID timezone, or needs clarification →
  // clarification draft, NO event. A non-IANA tz must never reach availability
  // or event creation (the provider builds an Intl.DateTimeFormat and would
  // throw a RangeError on a bad zone). ---
  const tzInvalid = !extraction.timezone || !isValidIanaTimezone(extraction.timezone);
  if (extraction.timezoneAmbiguous || extraction.needsClarification || tzInvalid) {
    const draftId = await draftSchedulingDraft(deps, {
      threadRowId: args.threadRowId,
      prospectId: args.prospectId,
      thread: args.thread,
      toEmail: args.inboundMsg.from.email,
      subject: args.inboundMsg.subject,
      body:
        extraction.clarificationQuestion ??
        'Happy to find a time! Could you share your timezone and a couple of windows that work for you?',
      tag: 'clarify',
    });

    await writeAudit(deps, {
      action: 'scheduling.clarify',
      entityType: ENTITY,
      entityId: args.messageRowId,
      decision: 'clarify',
      allowed: true,
      reason: extraction.timezoneAmbiguous
        ? 'timezone ambiguous'
        : tzInvalid
          ? 'timezone absent or invalid'
          : 'needs clarification',
      metadata: { draftId },
    });

    return {
      status: 'scheduling_clarify',
      threadId: args.threadRowId,
      messageId: args.messageRowId,
      category: 'interested_schedule',
      draftId,
    };
  }

  // --- Timezone known + valid (guard above returned otherwise) → availability ---
  const timezone: string = extraction.timezone as string;
  const durationMinutes = extraction.durationMinutes ?? 30;
  const rangeStart = new Date(deps.clock().getTime() + 24 * 60 * 60 * 1000);
  const rangeEnd = new Date(rangeStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const availability = await deps.calendar.getAvailability({
    calendarId: deps.config.googleCalendarId,
    rangeStartIso: rangeStart.toISOString(),
    rangeEndIso: rangeEnd.toISOString(),
    durationMinutes,
    timezone,
  });

  const freeSlots = availability.freeSlots.slice(0, 3);

  // --- Draft a scheduling reply (agent RECOMMENDS) ---
  let replyMeta;
  let replyBody: string;
  try {
    const result = await draftSchedulingReply(
      {
        classification: args.classification,
        extraction,
        availability: { freeSlots },
        nowIso,
      },
      deps.llmClient,
    );
    replyBody = result.output.body;
    replyMeta = result.meta;
  } catch (err) {
    if (err instanceof EscalationError) {
      return escalateInbound(deps, {
        threadRowId: args.threadRowId,
        messageRowId: args.messageRowId,
        prospectId: args.prospectId,
        category: 'interested_schedule',
        reason: `scheduling reply escalated: ${err.message}`,
        details: isAppError(err) ? err.details : undefined,
        agentType: AgentType.SCHEDULING_REPLY,
      });
    }
    throw err;
  }

  await persistAgentRun(deps, {
    agentType: AgentType.SCHEDULING_REPLY,
    status: AgentRunStatus.SUCCEEDED,
    meta: replyMeta,
    prospectId: args.prospectId,
    threadId: args.threadRowId,
    inputPayload: { freeSlots },
    parsedOutput: { body: replyBody },
  });

  const draftId = await draftSchedulingDraft(deps, {
    threadRowId: args.threadRowId,
    prospectId: args.prospectId,
    thread: args.thread,
    toEmail: args.inboundMsg.from.email,
    subject: args.inboundMsg.subject,
    body: replyBody,
    tag: 'propose',
  });

  // --- Create a PROPOSED CalendarEvent record only (no provider event yet) ---
  let calendarEventId: string | undefined;
  if (args.prospectId && freeSlots.length > 0) {
    const eventKey = idempotencyKey([args.thread.providerThreadId, 'propose', timezone]);
    const event = await proposeCalendarEvent(deps, {
      prospectId: args.prospectId,
      threadId: args.threadRowId,
      title: `Intro call: ${args.inboundMsg.subject}`,
      timezone,
      proposedSlots: freeSlots,
      attendees: [{ email: args.inboundMsg.from.email }],
      idempotencyKey: eventKey,
    });
    calendarEventId = event.calendarEventId;
  }

  await writeAudit(deps, {
    action: 'scheduling.proposed',
    entityType: ENTITY,
    entityId: args.messageRowId,
    decision: 'propose',
    allowed: true,
    reason: `offered ${freeSlots.length} slots`,
    metadata: { draftId, calendarEventId, timezone },
  });

  return {
    status: 'scheduling_proposed',
    threadId: args.threadRowId,
    messageId: args.messageRowId,
    category: 'interested_schedule',
    draftId,
    calendarEventId,
  };
}

/** Create a (never auto-sent) reply DraftEmail for scheduling. */
async function draftSchedulingDraft(
  deps: Deps,
  args: {
    threadRowId: string;
    prospectId: string | null;
    thread: EmailThreadDTO;
    toEmail: string;
    subject: string;
    body: string;
    tag: string;
  },
): Promise<string | undefined> {
  if (!args.prospectId) return undefined;
  const draftKey = idempotencyKey([args.thread.providerThreadId, 'scheduling', args.tag]);
  const row = await deps.prisma.draftEmail.upsert({
    where: { idempotencyKey: draftKey },
    create: {
      idempotencyKey: draftKey,
      prospectId: args.prospectId,
      threadId: args.threadRowId,
      fromEmail: deps.config.defaultFromEmail,
      fromName: deps.config.defaultFromName,
      toEmail: args.toEmail,
      subject: `Re: ${args.subject}`,
      bodyText: args.body,
      status: DraftStatus.PENDING_REVIEW,
      complianceStatus: 'pass',
    },
    update: { bodyText: args.body },
    select: { id: true },
  });
  return row.id;
}

/** Create an ESCALATION ApprovalItem + audit for an inbound case. */
async function escalateInbound(
  deps: Deps,
  args: {
    threadRowId: string;
    messageRowId: string;
    prospectId: string | null;
    category: InboundClassification['category'];
    reason: string;
    details?: unknown;
    agentType: AgentType;
  },
): Promise<InboundEmailResult> {
  if (args.agentType !== AgentType.INBOUND_CLASSIFIER) {
    await persistAgentRun(deps, {
      agentType: args.agentType,
      status: AgentRunStatus.ESCALATED,
      prospectId: args.prospectId,
      threadId: args.threadRowId,
      inputPayload: { category: args.category },
      validationErrors: args.details ?? { reason: args.reason },
    });
  }

  const approval = await deps.prisma.approvalItem.create({
    data: {
      type: ApprovalType.ESCALATION,
      status: ApprovalStatus.PENDING,
      prospectId: args.prospectId,
      payload: toJson({ kind: 'inbound_escalation', category: args.category, reason: args.reason }) as object,
      reason: args.reason,
    },
    select: { id: true },
  });

  await writeAudit(deps, {
    action: 'inbound.escalate',
    actorType: ActorType.AGENT,
    entityType: ENTITY,
    entityId: args.messageRowId,
    decision: args.category,
    allowed: false,
    reason: args.reason,
    metadata: { approvalItemId: approval.id, category: args.category },
  });

  return {
    status: 'escalated',
    threadId: args.threadRowId,
    messageId: args.messageRowId,
    category: args.category,
    approvalItemId: approval.id,
  };
}

/** Compact thread context string for agent prompts. */
function threadContext(thread: EmailThreadDTO): string {
  return thread.messages
    .map((m) => `[${m.direction}] ${m.from.email}: ${m.snippet}`)
    .join('\n');
}
