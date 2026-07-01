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
  CalendarAutonomyMode,
  CalendarEventStatus,
  DraftStatus,
  EmailDirection,
  EscalationError,
  ProspectStatus,
  SuppressionReason,
  idempotencyKey,
  isAppError,
  type InboundClassification,
  type SchedulingExtraction,
  type TimeSlot,
} from '@app/shared';
import {
  classifyInbound,
  draftSchedulingReply,
  extractScheduling,
} from '@app/agents';
import {
  addSuppression,
  buildUnsubscribeHeaders,
  canAutoReplyInboundEmail,
  canBookNow,
  classifyUnsubscribe,
  createSuppressionRepo,
  type AutoCalendarInput,
  type AutoReplyInput,
  type CalendarPolicyDeps,
  type EmailPolicyDeps,
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
  | 'scheduling_booked'
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

/**
 * Deterministic escalation predicate shared by every inbound category branch:
 * a classification escalates to a human when the classifier asks for one OR its
 * confidence is below {@link LOW_CONFIDENCE}.
 */
function shouldEscalate(classification: InboundClassification): boolean {
  return classification.requiresHuman || classification.confidence < LOW_CONFIDENCE;
}

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
      if (shouldEscalate(classification)) {
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
      if (shouldEscalate(classification)) {
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
  // Audit the deterministic detection FIRST (the opt-out signal itself).
  await writeAudit(deps, {
    action: 'unsubscribe.detected',
    actorType: ActorType.SYSTEM,
    entityType: ENTITY,
    entityId: args.messageRowId,
    decision: 'unsubscribe',
    allowed: true,
    reason: args.matchedPhrase ? `matched "${args.matchedPhrase}"` : `via ${args.via}`,
    metadata: { fromEmail: args.fromEmail, via: args.via },
  });

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

  // Keep the existing `suppression.add` action AND emit the spec's
  // `suppression.added` action so downstream consumers can rely on either.
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
  await writeAudit(deps, {
    action: 'suppression.added',
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

  // --- CalendarAutonomyMode branch: attempt an autonomous booking when the
  // deterministic policy allows it; otherwise fall through to the default
  // PROPOSE_TIMES_ONLY behavior (draft + PROPOSED event, no provider event). ---
  if (deps.settings.calendarAutonomyMode() === CalendarAutonomyMode.AUTO_BOOK_CONFIRMED) {
    const booked = await tryAutoBook(deps, {
      ...args,
      extraction,
      timezone,
      durationMinutes,
      freeSlots,
    });
    if (booked) return booked;
    // Not booked (policy denied / no slot / provider error) → fall back to the
    // PROPOSE_TIMES_ONLY path below.
  }

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

/** Collect lowercased participant emails across all messages in a thread. */
function threadParticipantEmails(thread: EmailThreadDTO): string[] {
  const set = new Set<string>();
  for (const m of thread.messages) {
    if (m.from?.email) set.add(m.from.email.trim().toLowerCase());
    for (const t of m.to ?? []) if (t.email) set.add(t.email.trim().toLowerCase());
  }
  return [...set];
}

/**
 * AUTO_BOOK_CONFIRMED path: deterministically decide (via `canBookNow`) whether
 * to autonomously create a provider calendar event, then create it through the
 * {@link CalendarProvider} abstraction (NEVER Google directly). On allow it
 * computes the SPEC calendar idempotency key, short-circuits to the existing
 * event on a re-run, creates the event, links it, and (policy-permitting) sends
 * a confirmation email. On deny / no-slot / provider error it returns null so
 * the caller falls back to the PROPOSE_TIMES_ONLY behavior.
 */
async function tryAutoBook(
  deps: Deps,
  args: {
    threadRowId: string;
    messageRowId: string;
    prospectId: string | null;
    thread: EmailThreadDTO;
    inboundMsg: PersistedInboundMessage;
    classification: InboundClassification;
    extraction: SchedulingExtraction;
    timezone: string;
    durationMinutes: number;
    freeSlots: TimeSlot[];
  },
): Promise<InboundEmailResult | null> {
  // Pick the slot the recipient agreed to (selectedSlotIndex). The index must be
  // IN-RANGE of the available free slots to count as an explicit agreement — an
  // out-of-range index means we cannot identify a slot the recipient actually
  // chose, so we must NOT auto-confirm (and must NOT silently fall back to
  // slot 0). With no usable explicit slot we leave `chosen` undefined, which
  // drives the policy to deny and the caller to route to propose/clarify.
  const idx = args.extraction.selectedSlotIndex;
  const idxInRange =
    idx !== null && idx !== undefined && idx >= 0 && idx < args.freeSlots.length;
  const explicitSlotAgreement = idxInRange;
  const chosen = idxInRange ? args.freeSlots[idx] : undefined;

  // Sensitivity flags from the classifier's risk flags (pricing/legal/etc.).
  const sensitiveFlags = (args.classification.riskFlags ?? []).map((f) => String(f));
  const attendees = [args.inboundMsg.from.email];
  const threadParticipants = threadParticipantEmails(args.thread);

  // SPEC calendar idempotency key:
  //   idempotencyKey([email_thread_id, normalized_attendees_joined,
  //                   event_start, event_end, calendar_id])
  const normalizedAttendees = [...attendees].map((a) => a.trim().toLowerCase()).sort().join(',');
  const calendarId = deps.config.googleCalendarId;
  const eventKey = chosen
    ? idempotencyKey([
        args.thread.providerThreadId,
        normalizedAttendees,
        chosen.startIso,
        chosen.endIso,
        calendarId,
      ])
    : '';

  // Idempotency precheck: does an event with this key already exist?
  const existing = eventKey
    ? await deps.prisma.calendarEvent.findUnique({
        where: { idempotencyKey: eventKey },
        select: { id: true, providerEventId: true },
      })
    : null;

  // Idempotency short-circuit: a committed booking already exists for this exact
  // (thread + attendees + slot) key — e.g. a re-run / a later inbound message on
  // the same thread re-reaching this path. Return the existing event WITHOUT
  // re-evaluating the booking policy. (The policy would deny on `alreadyExists`
  // and the caller would fall back to PROPOSE_TIMES_ONLY, re-reporting an
  // already-confirmed booking as proposed and risking a duplicate PROPOSED row.)
  if (existing?.providerEventId) {
    await writeAudit(deps, {
      action: 'calendar.create.idempotent',
      actorType: ActorType.SYSTEM,
      entityType: 'calendar_event',
      entityId: existing.id,
      decision: 'idempotent',
      allowed: true,
      reason: 'event already exists for idempotency key',
      idempotencyKey: eventKey,
      metadata: { providerEventId: existing.providerEventId },
    });
    return {
      status: 'scheduling_booked',
      threadId: args.threadRowId,
      messageId: args.messageRowId,
      category: 'interested_schedule',
      calendarEventId: existing.id,
    };
  }

  // SAFE-5: RE-CHECK real availability immediately before booking. Do NOT stamp
  // `slotStillFree = Boolean(chosen)` / `availabilityCheckedAt = nowIso` by
  // construction. Re-query the provider for the SAME range and verify the chosen
  // slot is still free (not overlapped by any busy interval and still present as
  // a bookable free slot). The REAL check time + REAL free-ness drive the policy.
  let slotStillFree = false;
  let availabilityCheckedAt: string | undefined;
  if (chosen) {
    const recheckRangeStart = new Date(deps.clock().getTime() + 24 * 60 * 60 * 1000);
    const recheckRangeEnd = new Date(recheckRangeStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const fresh = await deps.calendar.getAvailability({
      calendarId,
      rangeStartIso: recheckRangeStart.toISOString(),
      rangeEndIso: recheckRangeEnd.toISOString(),
      durationMinutes: args.durationMinutes,
      timezone: args.timezone,
    });
    availabilityCheckedAt = deps.clock().toISOString();
    const chosenStart = new Date(chosen.startIso).getTime();
    const chosenEnd = new Date(chosen.endIso).getTime();
    // The slot is free iff it overlaps NO busy interval in the fresh result.
    const overlapsBusy = fresh.busy.some((b) => {
      const bStart = new Date(b.startIso).getTime();
      const bEnd = new Date(b.endIso).getTime();
      return chosenStart < bEnd && bStart < chosenEnd;
    });
    slotStillFree = !overlapsBusy;
  }

  const policyDeps: CalendarPolicyDeps = {
    settings: deps.settings,
    caps: deps.caps,
    config: {
      ENABLE_AUTO_SCHEDULING: deps.config.enableAutoScheduling,
      // SAFE-1: the master send switch must also gate calendar creation.
      sendingEnabled: deps.config.sendingEnabled,
    },
    now: deps.clock(),
  };

  const input: AutoCalendarInput = {
    fromIsProspect: args.prospectId !== null,
    classification: {
      category: args.classification.category,
      confidence: args.classification.confidence,
    },
    explicitSlotAgreement,
    timezone: args.timezone,
    timezoneAmbiguous: args.extraction.timezoneAmbiguous,
    availabilityCheckedAt,
    slotStillFree,
    startIso: chosen?.startIso ?? '',
    endIso: chosen?.endIso ?? '',
    attendees,
    externalAttendees: attendees,
    threadParticipants,
    sensitiveFlags,
    angry: args.classification.category === 'angry',
    unsubscribe: false,
    alreadyExists: Boolean(existing),
  };

  await writeAudit(deps, {
    action: 'policy.evaluated',
    actorType: ActorType.SYSTEM,
    entityType: 'calendar_event',
    entityId: existing?.id ?? args.threadRowId,
    decision: 'auto_book',
    reason: 'evaluating autonomous calendar-booking policy',
    metadata: { threadId: args.threadRowId, calendarId },
  });

  const decision = await canBookNow(input, policyDeps);

  if (!decision.allow) {
    const paused = decision.reasons.some((r) => r.toLowerCase().includes('kill switch'));
    await writeAudit(deps, {
      action: paused ? 'killswitch.triggered' : 'policy.denied',
      actorType: ActorType.SYSTEM,
      entityType: 'calendar_event',
      entityId: existing?.id ?? args.threadRowId,
      decision: 'denied',
      allowed: false,
      reason: decision.reasons.join('; '),
      metadata: { reasons: decision.reasons, threadId: args.threadRowId },
    });
    if (paused) {
      await writeAudit(deps, {
        action: 'automation.paused',
        actorType: ActorType.SYSTEM,
        entityType: 'calendar_event',
        entityId: existing?.id ?? args.threadRowId,
        decision: 'paused',
        allowed: false,
        reason: decision.reasons.join('; '),
        metadata: { reasons: decision.reasons },
      });
    }
    // Fall back to PROPOSE_TIMES_ONLY (caller continues to the propose path).
    return null;
  }

  await writeAudit(deps, {
    action: 'policy.allowed',
    actorType: ActorType.SYSTEM,
    entityType: 'calendar_event',
    entityId: existing?.id ?? args.threadRowId,
    decision: 'allowed',
    allowed: true,
    reason: 'all autonomous-booking policy gates passed',
    metadata: { threadId: args.threadRowId, calendarId },
  });

  const slot = chosen as TimeSlot;

  // (The committed-event idempotency short-circuit ran before policy evaluation,
  // above; reaching here means no committed event exists for this key.)

  // --- CORR-2 (calendar): ATOMIC cap check-and-reserve immediately before the
  // provider create. Re-counts maxCalendarEventsPerDay AND writes the canonical
  // `calendar.create` reservation row inside one advisory-locked transaction, so
  // concurrent runs can never both pass the cap. On denial → NO create; fall
  // back to PROPOSE_TIMES_ONLY. ---
  const reservation = await deps.reserve({
    kind: 'calendar',
    idempotencyKey: eventKey,
    entityType: 'CalendarEvent',
    entityId: existing?.id ?? args.threadRowId,
  });
  if (!reservation.allowed) {
    await writeAudit(deps, {
      action: 'policy.denied',
      actorType: ActorType.SYSTEM,
      entityType: 'calendar_event',
      entityId: existing?.id ?? args.threadRowId,
      decision: 'denied',
      allowed: false,
      reason: reservation.reason ?? 'calendar reservation denied (cap reached)',
      idempotencyKey: eventKey,
      metadata: { threadId: args.threadRowId, calendarId, reservation: 'denied' },
    });
    // Fall back to PROPOSE_TIMES_ONLY (caller continues to the propose path).
    return null;
  }

  await writeAudit(deps, {
    action: 'calendar.create.attempted',
    actorType: ActorType.SYSTEM,
    entityType: 'calendar_event',
    entityId: existing?.id ?? args.threadRowId,
    decision: 'attempting',
    idempotencyKey: eventKey,
    metadata: { threadId: args.threadRowId, calendarId },
  });

  try {
    const providerEvent = await deps.calendar.createEvent({
      calendarId,
      title: `Intro call: ${args.inboundMsg.subject}`,
      startIso: slot.startIso,
      endIso: slot.endIso,
      timezone: args.timezone,
      attendees,
      idempotencyKey: eventKey,
    });

    // Persist the CalendarEvent row (CREATED/CONFIRMED) linked to the thread +
    // prospect, carrying providerEventId + payload + idempotencyKey.
    const row = await deps.prisma.calendarEvent.upsert({
      where: { idempotencyKey: eventKey },
      create: {
        idempotencyKey: eventKey,
        prospectId: args.prospectId ?? null,
        threadId: args.threadRowId,
        title: `Intro call: ${args.inboundMsg.subject}`,
        status: CalendarEventStatus.CONFIRMED,
        providerEventId: providerEvent.providerEventId,
        startTime: new Date(slot.startIso),
        endTime: new Date(slot.endIso),
        timezone: args.timezone,
        attendees: toJson(attendees.map((email) => ({ email }))) as object,
      },
      update: {
        status: CalendarEventStatus.CONFIRMED,
        providerEventId: providerEvent.providerEventId,
      },
      select: { id: true },
    });

    if (args.prospectId) {
      await deps.prisma.prospect.update({
        where: { id: args.prospectId },
        data: { status: ProspectStatus.MEETING_BOOKED },
      });
    }

    await writeAudit(deps, {
      action: 'calendar.create.succeeded',
      actorType: ActorType.SYSTEM,
      entityType: 'calendar_event',
      entityId: row.id,
      decision: 'created',
      allowed: true,
      reason: 'autonomous booking policy allowed; provider event created',
      idempotencyKey: eventKey,
      metadata: { providerEventId: providerEvent.providerEventId, threadId: args.threadRowId },
    });
    // NOTE: the canonical `calendar.create` cap row is written by the atomic
    // reservation (deps.reserve) BEFORE this create — writing a second one here
    // would DOUBLE-COUNT the calendar/day cap (countCalendarEventsToday counts
    // rows, not distinct keys). The reservation row is the single source of
    // truth the CapRepo counts against.

    // --- Confirmation email, gated by the inbound auto-reply policy ---
    // The provider event + CalendarEvent row are now committed; the booking has
    // SUCCEEDED. The confirmation is a SEPARATE side effect — wrap it in its own
    // try/catch so a confirmation/draft/audit failure cannot flip the booking
    // outcome to "proposed" (which would also risk a duplicate PROPOSED row). A
    // confirmation failure is logged but does not change the returned status.
    try {
      await sendOrDraftConfirmation(deps, {
        threadRowId: args.threadRowId,
        prospectId: args.prospectId,
        thread: args.thread,
        toEmail: args.inboundMsg.from.email,
        subject: args.inboundMsg.subject,
        slot,
        timezone: args.timezone,
        // SAFE-1: pass the REAL classification-derived escalation facts (not a
        // hardcoded false) so the confirmation reply is denied on a sensitive /
        // angry / unsubscribe thread.
        threadHasSensitiveFlag: sensitiveFlags.length > 0 || args.classification.category === 'angry',
        isUnsubscribe: args.classification.category === 'unsubscribe',
      });
    } catch (confirmErr) {
      await writeAudit(deps, {
        action: 'email.send.failed',
        actorType: ActorType.SYSTEM,
        entityType: 'email_thread',
        entityId: args.threadRowId,
        decision: 'failed',
        allowed: false,
        reason: confirmErr instanceof Error ? confirmErr.message : String(confirmErr),
        metadata: { kind: 'booking_confirmation', note: 'booking committed; confirmation failed' },
      });
    }

    return {
      status: 'scheduling_booked',
      threadId: args.threadRowId,
      messageId: args.messageRowId,
      category: 'interested_schedule',
      calendarEventId: row.id,
    };
  } catch (err) {
    await writeAudit(deps, {
      action: 'calendar.create.failed',
      actorType: ActorType.SYSTEM,
      entityType: 'calendar_event',
      entityId: existing?.id ?? args.threadRowId,
      decision: 'failed',
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
      idempotencyKey: eventKey,
      metadata: { threadId: args.threadRowId },
    });
    // Fall back to PROPOSE_TIMES_ONLY.
    return null;
  }
}

/**
 * Send a booking-confirmation email when the inbound auto-reply policy allows
 * it; otherwise draft it (never auto-sent). Reuses the deterministic policy
 * layer (`canAutoReplyInboundEmail`) — the LLM never decides this.
 */
async function sendOrDraftConfirmation(
  deps: Deps,
  args: {
    threadRowId: string;
    prospectId: string | null;
    thread: EmailThreadDTO;
    toEmail: string;
    subject: string;
    slot: TimeSlot;
    timezone: string;
    /** REAL classification-derived sensitive flag (SAFE-1). */
    threadHasSensitiveFlag: boolean;
    /** REAL classification-derived unsubscribe intent (SAFE-1). */
    isUnsubscribe: boolean;
  },
): Promise<void> {
  const body = `You're all set — I've booked us for ${args.slot.startIso} (${args.timezone}). Looking forward to it! If anything changes, just reply here.`;

  const replyInput: AutoReplyInput = {
    threadId: args.threadRowId,
    threadHasSensitiveFlag: args.threadHasSensitiveFlag,
    isUnsubscribe: args.isUnsubscribe,
    // A confirmation is a REAL send → subject to the same business-hours gate.
    sendAtIso: deps.clock().toISOString(),
  };
  const policyDeps: EmailPolicyDeps = {
    settings: deps.settings,
    caps: deps.caps,
    config: {
      ENABLE_AUTO_SEND: deps.config.enableAutoSend,
      // SAFE-1: the master send switch must also gate the confirmation reply.
      sendingEnabled: deps.config.sendingEnabled,
    },
    now: deps.clock(),
  };

  const decision = await canAutoReplyInboundEmail(replyInput, policyDeps);
  // Key the confirmation idempotency on the SPECIFIC booking (slot + timezone),
  // not just the thread. Multiple bookings can occur on the same thread; a
  // thread-only key would collide and reuse an old confirmation draft / skip a
  // new booking's confirmation.
  const confirmKey = idempotencyKey([
    args.thread.providerThreadId,
    'booking-confirm',
    args.slot.startIso,
    args.slot.endIso,
    args.timezone,
  ]);

  if (!decision.allow) {
    // Draft the confirmation instead of auto-sending it.
    if (args.prospectId) {
      await deps.prisma.draftEmail.upsert({
        where: { idempotencyKey: confirmKey },
        create: {
          idempotencyKey: confirmKey,
          prospectId: args.prospectId,
          threadId: args.threadRowId,
          fromEmail: deps.config.defaultFromEmail,
          fromName: deps.config.defaultFromName,
          toEmail: args.toEmail,
          subject: `Re: ${args.subject}`,
          bodyText: body,
          status: DraftStatus.PENDING_REVIEW,
          complianceStatus: 'pass',
        },
        update: {},
        select: { id: true },
      });
    }
    await writeAudit(deps, {
      action: 'policy.denied',
      actorType: ActorType.SYSTEM,
      entityType: 'email_thread',
      entityId: args.threadRowId,
      decision: 'denied',
      allowed: false,
      reason: decision.reasons.join('; '),
      idempotencyKey: confirmKey,
      metadata: { reasons: decision.reasons, kind: 'booking_confirmation' },
    });
    return;
  }

  // --- CORR-2 / SAFE-1 / CORR-N2: a booking confirmation is a REAL send, so it
  // must count toward the send caps. Route it through the SAME atomic
  // reservation as every other send, emitting the canonical `email.reply` action
  // (which both the send caps AND the per-thread reply cap count) with the
  // required SendAuditMetadata + idempotencyKey column. On denial → NO send;
  // fall back to drafting the confirmation for human review. ---
  const senderEmailNorm = deps.config.defaultFromEmail.trim().toLowerCase();
  const recipientDomain = args.toEmail.split('@')[1]?.trim().toLowerCase() ?? '';
  const reservation = await deps.reserve({
    kind: 'send',
    action: 'email.reply',
    senderEmail: senderEmailNorm,
    recipientEmail: args.toEmail.trim().toLowerCase(),
    idempotencyKey: confirmKey,
    // The per-thread reply cap counts `email.reply` rows keyed on
    // (entityType='EmailThread', entityId=threadId), so the reservation row must
    // carry that exact identity to be countable there too.
    entityType: 'EmailThread',
    entityId: args.threadRowId,
  });
  if (!reservation.allowed) {
    // Cap reached → draft the confirmation for human review instead of sending.
    if (args.prospectId) {
      await deps.prisma.draftEmail.upsert({
        where: { idempotencyKey: confirmKey },
        create: {
          idempotencyKey: confirmKey,
          prospectId: args.prospectId,
          threadId: args.threadRowId,
          fromEmail: deps.config.defaultFromEmail,
          fromName: deps.config.defaultFromName,
          toEmail: args.toEmail,
          subject: `Re: ${args.subject}`,
          bodyText: body,
          status: DraftStatus.PENDING_REVIEW,
          complianceStatus: 'pass',
        },
        update: {},
        select: { id: true },
      });
    }
    await writeAudit(deps, {
      action: 'policy.denied',
      actorType: ActorType.SYSTEM,
      entityType: 'email_thread',
      entityId: args.threadRowId,
      decision: 'denied',
      allowed: false,
      reason: reservation.reason ?? 'send cap reached',
      idempotencyKey: confirmKey,
      metadata: { reasons: [reservation.reason ?? 'send cap reached'], kind: 'booking_confirmation', reservation: 'denied' },
    });
    return;
  }

  const headers: Record<string, string> = buildUnsubscribeHeaders({
    settings: deps.settings,
    config: { unsubscribeBaseUrl: deps.config.unsubscribeBaseUrl },
    recipient: args.toEmail.trim().toLowerCase(),
  }) as Record<string, string>;

  await writeAudit(deps, {
    action: 'email.send.attempted',
    actorType: ActorType.SYSTEM,
    entityType: 'email_thread',
    entityId: args.threadRowId,
    decision: 'attempting',
    idempotencyKey: confirmKey,
    metadata: { kind: 'booking_confirmation' },
  });

  try {
    const sendResult = await deps.email.replyToThread({
      threadId: args.thread.providerThreadId,
      to: [{ email: args.toEmail }],
      from: { email: deps.config.defaultFromEmail, name: deps.config.defaultFromName },
      subject: `Re: ${args.subject}`,
      body,
      idempotencyKey: confirmKey,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    await writeAudit(deps, {
      action: 'email.send.succeeded',
      actorType: ActorType.SYSTEM,
      entityType: 'email_thread',
      entityId: args.threadRowId,
      decision: 'sent',
      allowed: true,
      reason: 'autonomous booking confirmation sent',
      idempotencyKey: confirmKey,
      metadata: {
        providerMessageId: sendResult.providerMessageId,
        kind: 'booking_confirmation',
        // Required SendAuditMetadata so the confirmation is visible to the send
        // counters (CORR-N2).
        senderEmail: senderEmailNorm,
        recipientDomain,
        idempotencyKey: confirmKey,
      },
    });
    // NOTE: the canonical `email.reply` cap row (counted by BOTH the send caps
    // and the per-thread reply cap) is written by the atomic reservation
    // (deps.reserve) BEFORE this send. Writing a second `email.reply` row here
    // would DOUBLE-COUNT the per-thread reply cap (countThreadAutoRepliesToday
    // counts rows, not distinct keys), so the reservation row is the single
    // canonical reply record.
  } catch (err) {
    await writeAudit(deps, {
      action: 'email.send.failed',
      actorType: ActorType.SYSTEM,
      entityType: 'email_thread',
      entityId: args.threadRowId,
      decision: 'failed',
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
      idempotencyKey: confirmKey,
      metadata: { kind: 'booking_confirmation' },
    });
  }
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
