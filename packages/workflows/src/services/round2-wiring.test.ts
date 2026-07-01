/**
 * Round-2 safety-remediation wiring tests.
 *
 * Verifies that the Round-1 compliance primitives (master switch, kill switches,
 * business-hours, atomic caps, real per-sequence dedupe, real availability
 * re-check, correct SendAuditMetadata) are actually WIRED into all four
 * send/book paths:
 *   - outbound-auto  (outboundSequenceService, LIMITED_AUTO_SEND)
 *   - human-approved (sendApprovedDraft)
 *   - calendar-auto-book + inbound-confirmation (inboundEmailService)
 *
 * All in-memory: FakePrisma + MOCK providers + FakeSettingsReader +
 * FakeReservationStore. No Temporal, no DB, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ProspectStatus,
  ResearchStatus,
  DraftStatus,
  EmailAutonomyMode,
  CalendarAutonomyMode,
  EmailDirection,
} from '@app/shared';
import { readySettings, domainOf } from '@app/compliance';
import type {
  SETTING_KEYS,
  AutonomySettingValue,
  ResearchOutput,
  ComplianceReview,
  OutreachDraft,
  InboundClassification,
  SchedulingExtraction,
  SchedulingReplyDraft,
} from '@app/shared';
import { MockEmailProvider } from '@app/email';
import { outboundSequenceService } from './outbound.js';
import { sendApprovedDraft } from './send.js';
import { inboundEmailService } from './inbound.js';
import { FakePrisma, makeDeps, FixedLlmProvider } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BUSINESS_HOURS_ISO = '2026-06-30T16:00:00.000Z'; // 12:00 ET (EDT)
const OUTSIDE_HOURS_ISO = '2026-06-30T06:00:00.000Z'; // 02:00 ET — outside 9-17
const FROM_EMAIL = 'outreach@example.com';
const TO_EMAIL = 'jane@acme.test';
const TO_DOMAIN = domainOf(TO_EMAIL);

const RESEARCH: ResearchOutput = {
  status: 'researched',
  summary: 'solid',
  companyInsights: 'insights',
  personalizationPoints: [],
  sources: [],
  dataGaps: [],
  confidence: 0.9,
  riskFlags: [],
};

const OUTREACH: OutreachDraft = {
  subject: 'A quick idea for Acme',
  body: 'Hi Jane, quick idea for your team based on what we found.',
  personalizationUsed: [],
  callToAction: 'Open to a chat?',
  unsupportedClaims: [],
  confidence: 0.9,
  riskFlags: [],
};

function passReview(): ComplianceReview {
  return { decision: 'pass', issues: [], hasUnsupportedClaims: false, suggestedFixes: [], confidence: 0.95 };
}

function outboundLlm(): FixedLlmProvider {
  return new FixedLlmProvider({ outreach: OUTREACH, compliance: passReview() });
}

function outboundSettings(
  over: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }> = {},
): ReturnType<typeof readySettings> {
  return readySettings({
    emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
    maxAutoSendsPerDayGlobal: 100,
    maxAutoSendsPerSenderPerDay: 100,
    maxAutoSendsPerDomainPerDay: 100,
    maxAutoSendsPerProspectPerSequence: 1,
    minMinutesBetweenAutoSendsPerSender: 0,
    ...over,
  });
}

function seedOutbound(prisma: FakePrisma): void {
  prisma.prospect.insert({
    id: 'p1',
    email: TO_EMAIL,
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'VP',
    status: ProspectStatus.READY,
    companyId: null,
  });
  prisma.researchResult.insert({
    id: 'r1',
    prospectId: 'p1',
    status: ResearchStatus.RESEARCHED,
    summary: 'solid',
    output: RESEARCH,
    confidence: 0.9,
    riskFlags: [],
    createdAt: 1,
  });
  prisma.outreachSequence.insert({ id: 's1', prospectId: 'p1', currentStep: 0, maxSteps: 5 });
}

function makeOutboundDeps(
  prisma: FakePrisma,
  over: {
    settings?: ReturnType<typeof readySettings>;
    config?: Record<string, unknown>;
    clockIso?: string;
  } = {},
): ReturnType<typeof makeDeps> {
  return makeDeps(prisma, {
    llmProvider: outboundLlm(),
    config: { enableAutoSend: true, sendingEnabled: true, autoSendEnabled: true, ...over.config },
    settings: over.settings ?? outboundSettings(),
    clockIso: over.clockIso ?? BUSINESS_HOURS_ISO,
  });
}

// ---------------------------------------------------------------------------
// SAFE-2 — APPROVED-leak: a canSendNow DENY leaves the draft PENDING_REVIEW.
// ---------------------------------------------------------------------------

describe('SAFE-2 outbound APPROVED-leak', () => {
  it('canSendNow DENY (outside business hours) → DraftEmail stays PENDING_REVIEW, ApprovalItem created, not sendable', async () => {
    const prisma = new FakePrisma();
    seedOutbound(prisma);
    // Outside business hours → canSendNow denies; the draft must NOT be pre-marked APPROVED.
    const deps = makeOutboundDeps(prisma, { clockIso: OUTSIDE_HOURS_ISO });
    const sendSpy = vi.spyOn(deps.email, 'sendMessage');

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const draft = prisma.draftEmail.rows[0]!;
    // SAFE-2: never speculatively APPROVED.
    expect(draft.status).toBe(DraftStatus.PENDING_REVIEW);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('business hours');

    // The denied draft is NOT sendable via the human path (requires real APPROVED).
    await expect(
      sendApprovedDraft(deps, { draftId: String(draft.id) }),
    ).rejects.toThrow(/not APPROVED/);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SAFE-4 / CORR-3 — per-sequence cap: prior SENT step → canSendNow denies.
// ---------------------------------------------------------------------------

describe('SAFE-4/CORR-3 per-sequence cap', () => {
  it('prospect already received this step (prior SENT draft) → canSendNow denies, no send', async () => {
    const prisma = new FakePrisma();
    seedOutbound(prisma);
    // A prior SENT draft in this sequence → countSequenceStepsSent === 1, and
    // maxAutoSendsPerProspectPerSequence === 1 → per-sequence cap reached.
    prisma.draftEmail.insert({
      id: 'd_prior',
      idempotencyKey: 'prior-key',
      prospectId: 'p1',
      sequenceId: 's1',
      direction: EmailDirection.OUTBOUND,
      fromEmail: FROM_EMAIL,
      toEmail: TO_EMAIL,
      subject: 'prior',
      bodyText: 'prior',
      status: DraftStatus.SENT,
      sentAt: new Date(BUSINESS_HOURS_ISO),
    });
    const deps = makeOutboundDeps(prisma);
    const sendSpy = vi.spyOn(deps.email, 'sendMessage');

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(sendSpy).not.toHaveBeenCalled();
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('per-prospect-per-sequence cap');
    // The new draft is NOT SENT and NOT APPROVED.
    const newDraft = prisma.draftEmail.rows.find((d) => d.id !== 'd_prior')!;
    expect(newDraft.status).toBe(DraftStatus.PENDING_REVIEW);
  });
});

// ---------------------------------------------------------------------------
// Human-approved kill switch (SAFE-1): globalPauseAllAutomation stops the send.
// ---------------------------------------------------------------------------

describe('SAFE-1 human-approved kill switch', () => {
  function seedApprovedDraft(prisma: FakePrisma): string {
    prisma.prospect.insert({ id: 'p1', email: TO_EMAIL, status: ProspectStatus.SEQUENCED, companyId: null });
    const draft = prisma.draftEmail.insert({
      id: 'd1',
      idempotencyKey: 'draft-key-1',
      prospectId: 'p1',
      sequenceId: null,
      direction: EmailDirection.OUTBOUND,
      fromEmail: FROM_EMAIL,
      fromName: 'Outreach',
      toEmail: TO_EMAIL,
      subject: 'Hello',
      bodyText: 'Hi there. https://example.com/unsubscribe',
      status: DraftStatus.APPROVED,
      complianceStatus: 'pass',
    });
    return String(draft.id);
  }

  it('globalPauseAllAutomation=true → sendApprovedDraft does NOT send (blocked, automation.paused)', async () => {
    const prisma = new FakePrisma();
    const draftId = seedApprovedDraft(prisma);
    const deps = makeDeps(prisma, {
      config: { sendingEnabled: true },
      settings: readySettings({ globalPauseAllAutomation: true }),
      clockIso: BUSINESS_HOURS_ISO,
    });
    const sendSpy = vi.spyOn(deps.email, 'sendMessage');

    const result = await sendApprovedDraft(deps, { draftId });

    expect(result.status).toBe('blocked');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.APPROVED); // untouched
    expect(prisma.auditLog.rows.some((a) => a.action === 'automation.paused')).toBe(true);
    // No cap reservation happened and no send audit.
    expect(deps.reserveStore.rows).toHaveLength(0);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
  });

  it('happy human send is routed through reserveAutoAction (counts toward caps, writes SendAuditMetadata)', async () => {
    const prisma = new FakePrisma();
    const draftId = seedApprovedDraft(prisma);
    const deps = makeDeps(prisma, {
      config: { sendingEnabled: true },
      settings: readySettings(),
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await sendApprovedDraft(deps, { draftId });
    expect(result.status).toBe('sent');
    // The human send reserved a slot (visible to caps) with correct metadata.
    expect(deps.reserveStore.rows).toHaveLength(1);
    expect(deps.reserveStore.rows[0]).toMatchObject({
      kind: 'send',
      senderEmail: FROM_EMAIL,
      recipientDomain: TO_DOMAIN,
    });
    // Canonical email.send cap row exists with SendAuditMetadata.
    const sendRow = prisma.auditLog.rows.find((a) => a.action === 'email.send')!;
    expect(sendRow).toBeTruthy();
    expect(sendRow.metadata).toMatchObject({ senderEmail: FROM_EMAIL, recipientDomain: TO_DOMAIN });
    expect(sendRow.idempotencyKey).toBe('draft-key-1');
  });
});

// ---------------------------------------------------------------------------
// Calendar auto-book: master switch + availability re-check + confirmation caps.
// ---------------------------------------------------------------------------

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

function calendarLlm(over: { extraction?: Partial<SchedulingExtraction> } = {}): FixedLlmProvider {
  return new FixedLlmProvider({
    inbound_classify: classification(),
    scheduling_extract: extraction(over.extraction),
    scheduling_reply: REPLY,
  });
}

function seedCalProspect(prisma: FakePrisma): void {
  prisma.prospect.insert({
    id: 'p1',
    email: TO_EMAIL,
    firstName: 'Jane',
    lastName: 'Doe',
    status: ProspectStatus.SEQUENCED,
    companyId: null,
  });
}

function preseedReply(deps: ReturnType<typeof makeDeps>, body: string): { threadId: string; messageId: string } {
  const mock = deps.email as MockEmailProvider;
  const [thread] = mock.preseed([
    {
      providerThreadId: 'thr_1',
      subject: 'Re: your email',
      messages: [
        {
          providerMessageId: 'msg_1',
          from: { email: TO_EMAIL },
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

describe('calendar master switch (SAFE-1)', () => {
  it('sendingEnabled=false → no event even in AUTO_BOOK_CONFIRMED', async () => {
    const prisma = new FakePrisma();
    seedCalProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: calendarLlm(),
      // Scheduling env ON but master send switch OFF.
      config: { enableAutoScheduling: true, enableAutoSend: true, sendingEnabled: false },
      settings: readySettings({ calendarAutonomyMode: CalendarAutonomyMode.AUTO_BOOK_CONFIRMED }),
    });
    const { threadId, messageId } = preseedReply(deps, 'Yes, slot #1 works for me!');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    // No provider event created; fell back to propose.
    expect(result.status).toBe('scheduling_proposed');
    expect(prisma.calendarEvent.rows[0]?.providerEventId).toBeUndefined();
    const denied = prisma.auditLog.rows.find(
      (a) => a.action === 'policy.denied' && String(a.reason).includes('SENDING_ENABLED'),
    );
    expect(denied).toBeTruthy();
    // No calendar reservation was taken.
    expect(deps.reserveStore.rows.some((r) => r.kind === 'calendar')).toBe(false);
  });
});

describe('SAFE-5 availability re-check', () => {
  it('slot free at first check but TAKEN at the pre-create re-check → no event, propose', async () => {
    const prisma = new FakePrisma();
    seedCalProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: calendarLlm(),
      config: { enableAutoScheduling: true, enableAutoSend: false, sendingEnabled: true },
      settings: readySettings({ calendarAutonomyMode: CalendarAutonomyMode.AUTO_BOOK_CONFIRMED }),
    });

    // Wrap getAvailability: first call returns free slots; the SECOND call (the
    // SAFE-5 pre-create re-check) reports the chosen slot as BUSY.
    const inner = deps.calendar;
    let calls = 0;
    deps.calendar = {
      ...inner,
      name: inner.name,
      async getAvailability(input) {
        calls += 1;
        const res = await inner.getAvailability(input);
        if (calls >= 2 && res.freeSlots[0]) {
          // Mark the chosen (first) free slot busy on the re-check.
          return { busy: [...res.busy, res.freeSlots[0]], freeSlots: res.freeSlots };
        }
        return res;
      },
      createEvent: inner.createEvent.bind(inner),
      updateEvent: inner.updateEvent.bind(inner),
      cancelEvent: inner.cancelEvent.bind(inner),
      watchCalendar: inner.watchCalendar.bind(inner),
      parseWebhookNotification: inner.parseWebhookNotification.bind(inner),
    };
    const createSpy = vi.spyOn(deps.calendar, 'createEvent');
    const { threadId, messageId } = preseedReply(deps, 'Yes, slot #1 works for me!');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_proposed');
    expect(createSpy).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.rows[0]?.providerEventId).toBeUndefined();
    const denied = prisma.auditLog.rows.find(
      (a) => a.action === 'policy.denied' && String(a.reason).includes('slot is no longer free'),
    );
    expect(denied).toBeTruthy();
  });
});

describe('confirmation counts (SAFE-1 / CORR-N2)', () => {
  it('a booking confirmation reply reserves a slot + writes SendAuditMetadata + counts toward caps', async () => {
    const prisma = new FakePrisma();
    seedCalProspect(prisma);
    // Fully-autonomous email posture so the confirmation is SENT (not drafted):
    // LIMITED_AUTO_SEND + enableAutoSend + sendingEnabled + business hours.
    const deps = makeDeps(prisma, {
      llmProvider: calendarLlm(),
      config: { enableAutoScheduling: true, enableAutoSend: true, sendingEnabled: true },
      settings: readySettings({
        calendarAutonomyMode: CalendarAutonomyMode.AUTO_BOOK_CONFIRMED,
        emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
      }),
      clockIso: BUSINESS_HOURS_ISO,
    });
    const { threadId, messageId } = preseedReply(deps, 'Yes, slot #1 works for me!');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_booked');
    // A calendar reservation AND a send (email.reply) reservation were taken.
    expect(deps.reserveStore.rows.some((r) => r.kind === 'calendar')).toBe(true);
    const replyReservation = deps.reserveStore.rows.find((r) => r.kind === 'send');
    expect(replyReservation).toBeTruthy();
    expect(replyReservation).toMatchObject({
      kind: 'send',
      senderEmail: deps.config.defaultFromEmail.trim().toLowerCase(),
      recipientDomain: TO_DOMAIN,
    });
    // Canonical email.reply cap row carries SendAuditMetadata + keyed idempotency,
    // and is countable by the per-thread reply cap (entityType EmailThread).
    const replyRow = prisma.auditLog.rows.find((a) => a.action === 'email.reply')!;
    expect(replyRow).toBeTruthy();
    expect(replyRow.entityType).toBe('EmailThread');
    expect(replyRow.metadata).toMatchObject({
      senderEmail: deps.config.defaultFromEmail.trim().toLowerCase(),
      recipientDomain: TO_DOMAIN,
    });
    // Exactly ONE canonical email.reply row (no double-count).
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.reply')).toHaveLength(1);
    // The confirmation was actually sent (email.send.succeeded), not drafted.
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(true);
  });
});
