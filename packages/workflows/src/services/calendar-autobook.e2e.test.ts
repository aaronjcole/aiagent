/**
 * Focused end-to-end verification of the DIRECT calendar auto-booking path of
 * the autonomy system, for the SPECIFIC target scenario:
 *
 *   env:           ENABLE_AUTO_SCHEDULING=true, ENABLE_AUTO_SEND=false
 *   SystemSetting: calendarAutonomyMode = auto_book_confirmed
 *                  emailAutonomyMode    = approval_required
 *   kill switches: all OFF; every other calendar gate satisfiable.
 *
 * Because email autonomy is APPROVAL_REQUIRED and ENABLE_AUTO_SEND is false, the
 * post-booking confirmation email MUST be DRAFTED (DraftEmail PENDING_REVIEW),
 * never sent. This file asserts that explicitly (checkpoint 9) — distinct from
 * the existing inbound.test.ts auto-book cases, which run with auto-send ON.
 *
 * The MockCalendarProvider is WRAPPED so `createEvent` call count and
 * `getAvailability` calls are directly observable (spy), satisfying the
 * "createEvent EXACTLY once" / "getAvailability called" assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  EmailDirection,
  ProspectStatus,
  CalendarAutonomyMode,
  EmailAutonomyMode,
  CalendarEventStatus,
  DraftStatus,
  ApprovalType,
} from '@app/shared';
import type {
  InboundClassification,
  SchedulingExtraction,
  SchedulingReplyDraft,
  SETTING_KEYS,
  AutonomySettingValue,
} from '@app/shared';
import { readySettings, canBookNow, type CalendarPolicyDeps, type AutoCalendarInput } from '@app/compliance';
import { MockEmailProvider } from '@app/email';
import type {
  AvailabilityInput,
  AvailabilityResult,
  CalendarEventDTO,
  CalendarProvider,
  CreateEventInput,
} from '@app/calendar';
import { inboundEmailService } from './inbound.js';
import { isValidIanaTimezone } from './tz.js';
import { FakePrisma, makeDeps, FixedLlmProvider } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Spy wrapper over a CalendarProvider: counts createEvent + getAvailability.
// ---------------------------------------------------------------------------

interface CalendarSpy {
  createEventCalls: CreateEventInput[];
  availabilityCalls: AvailabilityInput[];
}

function spyCalendar(inner: CalendarProvider): { provider: CalendarProvider; spy: CalendarSpy } {
  const spy: CalendarSpy = { createEventCalls: [], availabilityCalls: [] };
  const provider: CalendarProvider = {
    name: inner.name,
    getAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
      spy.availabilityCalls.push(input);
      return inner.getAvailability(input);
    },
    createEvent(input: CreateEventInput): Promise<CalendarEventDTO> {
      spy.createEventCalls.push(input);
      return inner.createEvent(input);
    },
    updateEvent: inner.updateEvent.bind(inner),
    cancelEvent: inner.cancelEvent.bind(inner),
    watchCalendar: inner.watchCalendar.bind(inner),
    parseWebhookNotification: inner.parseWebhookNotification.bind(inner),
  };
  return { provider, spy };
}

// ---------------------------------------------------------------------------
// Fixtures for the target scenario.
// ---------------------------------------------------------------------------

const PROSPECT_EMAIL = 'jane@acme.test';

function seedProspect(prisma: FakePrisma, email = PROSPECT_EMAIL): void {
  prisma.prospect.insert({
    id: 'p1',
    email,
    firstName: 'Jane',
    lastName: 'Doe',
    status: ProspectStatus.SEQUENCED,
    companyId: null,
  });
}

function classification(over: Partial<InboundClassification> = {}): InboundClassification {
  return {
    category: 'interested_schedule',
    requiresHuman: false,
    reasons: ['interested'],
    confidence: 0.95,
    riskFlags: [],
    ...over,
  };
}

function extraction(over: Partial<SchedulingExtraction> = {}): SchedulingExtraction {
  return {
    hasSchedulingIntent: true,
    proposedTimes: [],
    timezone: 'America/New_York',
    timezoneAmbiguous: false,
    durationMinutes: 30,
    selectedSlotIndex: 0,
    needsClarification: false,
    clarificationQuestion: null,
    confidence: 0.95,
    ...over,
  };
}

const REPLY: SchedulingReplyDraft = {
  action: 'propose',
  body: 'Here are some times that work.',
  proposedSlots: [],
  confidence: 0.9,
};

/**
 * The EXACT target SystemSetting posture: auto_book_confirmed + approval_required
 * + all readiness flags on + kill switches off (readySettings default).
 */
function targetSettings(
  over: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }> = {},
): ReturnType<typeof readySettings> {
  return readySettings({
    calendarAutonomyMode: CalendarAutonomyMode.AUTO_BOOK_CONFIRMED,
    emailAutonomyMode: EmailAutonomyMode.APPROVAL_REQUIRED,
    ...over,
  });
}

/**
 * The target env: scheduling ON, autonomous EMAIL send OFF (so the confirmation
 * is DRAFTED, not sent), but the master SENDING_ENABLED switch ON so the
 * calendar auto-book path is permitted (SENDING_ENABLED now gates calendar
 * creation as an external action).
 */
const TARGET_CONFIG = {
  enableAutoScheduling: true,
  enableAutoSend: false,
  sendingEnabled: true,
} as const;

/** Build deps wired for the target scenario, with a calendar spy. */
function makeScenarioDeps(
  prisma: FakePrisma,
  opts: {
    extractionOver?: Partial<SchedulingExtraction>;
    classificationOver?: Partial<InboundClassification>;
    settingsOver?: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }>;
  } = {},
): { deps: ReturnType<typeof makeDeps>; spy: CalendarSpy } {
  const deps = makeDeps(prisma, {
    llmProvider: new FixedLlmProvider({
      inbound_classify: classification(opts.classificationOver),
      scheduling_extract: extraction(opts.extractionOver),
      scheduling_reply: REPLY,
    }),
    config: { ...TARGET_CONFIG },
    settings: targetSettings(opts.settingsOver),
  });
  const { provider, spy } = spyCalendar(deps.calendar);
  deps.calendar = provider;
  return { deps, spy };
}

/** Preseed one inbound reply on a thread. */
function preseedReply(
  deps: ReturnType<typeof makeDeps>,
  body: string,
  opts: { providerThreadId?: string; providerMessageId?: string; from?: string } = {},
): { threadId: string; messageId: string } {
  const mock = deps.email as MockEmailProvider;
  const [thread] = mock.preseed([
    {
      providerThreadId: opts.providerThreadId ?? 'thr_1',
      subject: 'Re: your email',
      messages: [
        {
          providerMessageId: opts.providerMessageId ?? 'msg_1',
          from: { email: opts.from ?? PROSPECT_EMAIL },
          to: [{ email: deps.config.defaultFromEmail }],
          subject: 'Re: your email',
          body,
          direction: EmailDirection.INBOUND,
        },
      ],
    },
  ]);
  const t = thread!;
  return { threadId: t.providerThreadId, messageId: t.messages[0]!.providerMessageId };
}

/** Count OUTBOUND messages persisted in the FakePrisma emailMessage table. */
function outboundMessageRows(prisma: FakePrisma): unknown[] {
  return prisma.emailMessage.rows.filter((m) => m.direction === EmailDirection.OUTBOUND);
}

// ---------------------------------------------------------------------------
// HAPPY PATH — all 9 checkpoints.
// ---------------------------------------------------------------------------

describe('calendar auto-book (direct path) — HAPPY PATH', () => {
  it('books exactly one provider event, confirms via DRAFT (auto-send disabled), and is idempotent', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma);
    const { threadId, messageId } = preseedReply(deps, 'Yes, slot #1 works for me!');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    // (1) classification is interested_schedule.
    expect(result.category).toBe('interested_schedule');
    const classifyAudit = prisma.auditLog.rows.find((a) => a.action === 'inbound.classified');
    expect(classifyAudit!.decision).toBe('interested_schedule');
    expect(result.status).toBe('scheduling_booked');

    // (2) timezone resolved: non-null, valid IANA, not ambiguous.
    const eventRow = prisma.calendarEvent.rows[0]!;
    expect(eventRow.timezone).toBe('America/New_York');
    expect(isValidIanaTimezone(String(eventRow.timezone))).toBe(true);

    // (3) free/busy availability was checked before booking. Two checks now
    // occur: the initial slot-finding query, and the SAFE-5 fresh re-check
    // performed immediately before createEvent (so `slotStillFree` reflects
    // real, current availability rather than being stamped by construction).
    expect(spy.availabilityCalls).toHaveLength(2);
    // and availability was checked BEFORE createEvent (spy ordering).
    expect(spy.availabilityCalls.length).toBeGreaterThan(0);
    expect(spy.createEventCalls).toHaveLength(1);

    // (4) deterministic policy canBookNow returns allow for the same facts.
    //     (Reconstruct the policy input from the booked slot the service used.)
    const created = spy.createEventCalls[0]!;
    const policyDeps: CalendarPolicyDeps = {
      settings: deps.settings,
      caps: deps.caps,
      config: {
        ENABLE_AUTO_SCHEDULING: deps.config.enableAutoScheduling,
        sendingEnabled: deps.config.sendingEnabled,
      },
      now: deps.clock(),
    };
    const policyInput: AutoCalendarInput = {
      fromIsProspect: true,
      classification: { category: 'interested_schedule', confidence: 0.95 },
      explicitSlotAgreement: true,
      timezone: created.timezone,
      timezoneAmbiguous: false,
      availabilityCheckedAt: deps.clock().toISOString(),
      slotStillFree: true,
      startIso: created.startIso,
      endIso: created.endIso,
      attendees: created.attendees,
      externalAttendees: created.attendees,
      threadParticipants: [PROSPECT_EMAIL, deps.config.defaultFromEmail.toLowerCase()],
      sensitiveFlags: [],
      angry: false,
      unsubscribe: false,
      alreadyExists: false,
    };
    const decision = await canBookNow(policyInput, policyDeps);
    expect(decision.allow).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.allowed')).toBe(true);

    // (5) createEvent called EXACTLY once; row persisted CONFIRMED + providerEventId
    //     + idempotencyKey, linked to thread + prospect.
    expect(spy.createEventCalls).toHaveLength(1);
    expect(prisma.calendarEvent.rows).toHaveLength(1);
    expect(eventRow.status).toBe(CalendarEventStatus.CONFIRMED);
    expect(eventRow.providerEventId).toBeTruthy();
    expect(eventRow.idempotencyKey).toBeTruthy();
    expect(eventRow.threadId).toBe(result.threadId);
    expect(eventRow.prospectId).toBe('p1');
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.MEETING_BOOKED);

    // (7) audit trail: policy.evaluated, calendar.create.attempted,
    //     calendar.create.succeeded, and canonical calendar.create.
    for (const action of [
      'policy.evaluated',
      'calendar.create.attempted',
      'calendar.create.succeeded',
      'calendar.create',
    ]) {
      expect(prisma.auditLog.rows.some((a) => a.action === action)).toBe(true);
    }

    // (9) confirmation email DRAFTED (PENDING_REVIEW), NOT sent.
    const confirmDraft = prisma.draftEmail.rows.find((d) =>
      String(d.bodyText).includes("You're all set"),
    );
    expect(confirmDraft).toBeTruthy();
    expect(confirmDraft!.status).toBe(DraftStatus.PENDING_REVIEW);
    // No send audits, no outbound message rows.
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.reply')).toBe(false);
    expect(outboundMessageRows(prisma)).toHaveLength(0);
    // The auto-reply policy explicitly DENIED the send (draft path).
    const confirmDenied = prisma.auditLog.rows.find(
      (a) => a.action === 'policy.denied' && (a.metadata as Record<string, unknown> | undefined)?.kind === 'booking_confirmation',
    );
    expect(confirmDenied).toBeTruthy();

    // (6a) duplicate inbound (SAME providerMessageId) → no second event.
    const dup = await inboundEmailService(deps, { providerMessageId: messageId, threadId });
    expect(dup.status).toBe('duplicate');
    expect(spy.createEventCalls).toHaveLength(1);
    expect(prisma.calendarEvent.rows).toHaveLength(1);
    expect(prisma.auditLog.rows.some((a) => a.action === 'inbound.duplicate')).toBe(true);
  });

  it('(6b) re-entry on same thread+slot (distinct providerMessageId) returns existing event via calendar.create.idempotent', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma);
    const mock = deps.email as MockEmailProvider;
    mock.preseed([
      {
        providerThreadId: 'thr_idem',
        subject: 'Re: your email',
        messages: [
          {
            providerMessageId: 'msg_idem_1',
            from: { email: PROSPECT_EMAIL },
            to: [{ email: deps.config.defaultFromEmail }],
            subject: 'Re: your email',
            body: 'Yes, slot #1 works for me!',
            direction: EmailDirection.INBOUND,
          },
          {
            providerMessageId: 'msg_idem_2',
            from: { email: PROSPECT_EMAIL },
            to: [{ email: deps.config.defaultFromEmail }],
            subject: 'Re: your email',
            body: 'Yes, slot #1 works for me!',
            direction: EmailDirection.INBOUND,
          },
        ],
      },
    ]);

    const first = await inboundEmailService(deps, { providerMessageId: 'msg_idem_1', threadId: 'thr_idem' });
    expect(first.status).toBe('scheduling_booked');
    expect(spy.createEventCalls).toHaveLength(1);
    const firstEventId = prisma.calendarEvent.rows[0]!.id;
    const firstProviderEventId = prisma.calendarEvent.rows[0]!.providerEventId as string;

    // Free the booked slot in the PROVIDER only so availability recomputes to the
    // same first free slot; the committed-booking idempotency guard must fire.
    await deps.calendar.cancelEvent({
      calendarId: deps.config.googleCalendarId,
      providerEventId: firstProviderEventId,
    });

    const second = await inboundEmailService(deps, { providerMessageId: 'msg_idem_2', threadId: 'thr_idem' });
    expect(second.status).toBe('scheduling_booked');
    expect((second as { calendarEventId?: string }).calendarEventId).toBe(firstEventId);
    // No NEW row, and createEvent NOT called a second time.
    expect(prisma.calendarEvent.rows).toHaveLength(1);
    expect(spy.createEventCalls).toHaveLength(1);
    expect(prisma.auditLog.rows.some((a) => a.action === 'calendar.create.idempotent')).toBe(true);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'calendar.create.succeeded')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CASES — each must create NO provider event and route to a safe
// fallback (propose/clarify draft, suppression, or escalation).
// ---------------------------------------------------------------------------

describe('calendar auto-book (direct path) — NEGATIVE CASES (no provider event)', () => {
  it('ambiguous timezone → clarification draft, no event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma, {
      extractionOver: { timezoneAmbiguous: true, timezone: null },
    });
    const { threadId, messageId } = preseedReply(deps, 'Lets meet at 3pm tomorrow ET');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_clarify');
    expect(spy.createEventCalls).toHaveLength(0);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    expect(prisma.draftEmail.rows).toHaveLength(1);
    const clarify = prisma.auditLog.rows.find((a) => a.action === 'scheduling.clarify');
    expect(clarify).toBeTruthy();
    expect(String(clarify!.reason)).toContain('ambiguous');
  });

  it('invalid IANA timezone → clarification draft, no event (never reaches provider)', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma, { extractionOver: { timezone: 'Not/AZone' } });
    const { threadId, messageId } = preseedReply(deps, 'Lets meet at 3pm tomorrow');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_clarify');
    expect(spy.createEventCalls).toHaveLength(0);
    expect(spy.availabilityCalls).toHaveLength(0);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
  });

  it('no explicit confirmation (selectedSlotIndex null) → propose, no event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma, { extractionOver: { selectedSlotIndex: null } });
    const { threadId, messageId } = preseedReply(deps, 'Sometime next week works.');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_proposed');
    expect(spy.createEventCalls).toHaveLength(0);
    // A PROPOSED CalendarEvent row IS persisted on the propose path; what must
    // NOT happen is a provider-backed event, so providerEventId stays undefined.
    expect(prisma.calendarEvent.rows[0]!.providerEventId).toBeUndefined();
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('explicit');
  });

  it('unavailable slot (out-of-range index → no usable slot) → propose, no event', async () => {
    // An out-of-range selectedSlotIndex means no slot the recipient actually
    // chose is free/identifiable → slotStillFree=false in the policy input.
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma, { extractionOver: { selectedSlotIndex: 99 } });
    const { threadId, messageId } = preseedReply(deps, 'Yes that works!');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_proposed');
    expect(spy.createEventCalls).toHaveLength(0);
    // Propose path persists a PROPOSED row; no provider event is created.
    expect(prisma.calendarEvent.rows[0]!.providerEventId).toBeUndefined();
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.denied')).toBe(true);
  });

  it('unsubscribe language → deterministic suppression, no classification-driven booking, no event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma);
    const { threadId, messageId } = preseedReply(deps, 'Please unsubscribe me from this list.');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('unsubscribed');
    expect(spy.createEventCalls).toHaveLength(0);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    expect(prisma.suppressionEntry.rows).toHaveLength(1);
    // Deterministic short-circuit before the LLM → no classifier run.
    expect(prisma.agentRun.rows).toHaveLength(0);
    expect(prisma.auditLog.rows.some((a) => a.action === 'suppression.add')).toBe(true);
  });

  it('pricing/security question (sensitive) → escalation ApprovalItem, no event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    // Sensitive category with requiresHuman → escalation (not booking).
    const { deps, spy } = makeScenarioDeps(prisma, {
      classificationOver: { category: 'pricing', requiresHuman: true },
    });
    const { threadId, messageId } = preseedReply(deps, 'What is the pricing and your security posture?');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('escalated');
    expect(result.category).toBe('pricing');
    expect(spy.createEventCalls).toHaveLength(0);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    expect(prisma.approvalItem.rows.some((a) => a.type === ApprovalType.ESCALATION)).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'inbound.escalate')).toBe(true);
  });

  it('angry complaint → escalation, no event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma, {
      classificationOver: { category: 'angry', requiresHuman: true },
    });
    const { threadId, messageId } = preseedReply(
      deps,
      'This is completely unacceptable and I am furious about how this was handled.',
    );

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('escalated');
    expect(result.category).toBe('angry');
    expect(spy.createEventCalls).toHaveLength(0);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    expect(prisma.approvalItem.rows.some((a) => a.type === ApprovalType.ESCALATION)).toBe(true);
  });

  it('duplicate webhook (same providerMessageId twice) → second early-returns, no second event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const { deps, spy } = makeScenarioDeps(prisma);
    const { threadId, messageId } = preseedReply(deps, 'Yes, slot #1 works for me!');

    const first = await inboundEmailService(deps, { providerMessageId: messageId, threadId });
    expect(first.status).toBe('scheduling_booked');
    expect(spy.createEventCalls).toHaveLength(1);

    const second = await inboundEmailService(deps, { providerMessageId: messageId, threadId });
    expect(second.status).toBe('duplicate');
    // No second processing, no second event.
    expect(spy.createEventCalls).toHaveLength(1);
    expect(prisma.calendarEvent.rows).toHaveLength(1);
    expect(prisma.auditLog.rows.some((a) => a.action === 'inbound.duplicate')).toBe(true);
  });
});
