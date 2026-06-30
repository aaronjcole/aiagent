import { describe, it, expect } from 'vitest';
import { EmailDirection, ProspectStatus } from '@app/shared';
import type { InboundClassification, SchedulingExtraction, SchedulingReplyDraft } from '@app/shared';
import { MockEmailProvider } from '@app/email';
import { inboundEmailService } from './inbound.js';
import { FakePrisma, makeDeps, FixedLlmProvider, FailingLlmProvider } from './test-helpers.js';

function seedProspect(prisma: FakePrisma, email = 'jane@acme.test'): void {
  prisma.prospect.insert({
    id: 'p1',
    email,
    firstName: 'Jane',
    lastName: 'Doe',
    status: ProspectStatus.SEQUENCED,
    companyId: null,
  });
}

/** Preseed a thread with one inbound message into the deps' mock email provider. */
function preseedThread(
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
          from: { email: opts.from ?? 'jane@acme.test' },
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

function classification(over: Partial<InboundClassification> = {}): InboundClassification {
  return {
    category: 'interested_schedule',
    requiresHuman: false,
    reasons: ['interested'],
    confidence: 0.9,
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
    selectedSlotIndex: null,
    needsClarification: false,
    clarificationQuestion: null,
    confidence: 0.9,
    ...over,
  };
}

const REPLY: SchedulingReplyDraft = {
  action: 'propose',
  body: 'Here are some times that work.',
  proposedSlots: [],
  confidence: 0.9,
};

describe('inboundEmailService', () => {
  it('unsubscribe phrase: suppression added, no scheduling', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma);
    const { threadId, messageId } = preseedThread(deps, 'Please unsubscribe me from this list.');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('unsubscribed');
    expect(prisma.suppressionEntry.rows).toHaveLength(1);
    expect(prisma.suppressionEntry.rows[0]!.reason).toBe('unsubscribe');
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.UNSUBSCRIBED);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    // No classifier run — deterministic short-circuit before the LLM.
    expect(prisma.agentRun.rows).toHaveLength(0);
    expect(prisma.auditLog.rows.some((a) => a.action === 'suppression.add')).toBe(true);
  });

  it('interested_schedule (clear): availability checked, reply draft + PROPOSED event (not created)', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification(),
        scheduling_extract: extraction(),
        scheduling_reply: REPLY,
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'I am interested, can we meet next week?');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_proposed');
    expect(prisma.draftEmail.rows).toHaveLength(1);
    expect(prisma.calendarEvent.rows).toHaveLength(1);
    expect(prisma.calendarEvent.rows[0]!.status).toBe('proposed');
    // No provider event id yet (PROPOSED, not CREATED).
    expect(prisma.calendarEvent.rows[0]!.providerEventId).toBeUndefined();
    expect(prisma.auditLog.rows.some((a) => a.action === 'scheduling.proposed')).toBe(true);
  });

  it('timezone ambiguous: clarification draft, no event', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification(),
        scheduling_extract: extraction({ timezoneAmbiguous: true, timezone: null }),
        scheduling_reply: REPLY,
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'Lets meet at 3pm tomorrow');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_clarify');
    expect(prisma.draftEmail.rows).toHaveLength(1);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    expect(prisma.auditLog.rows.some((a) => a.action === 'scheduling.clarify')).toBe(true);
  });

  it('invalid IANA timezone: clarification draft, NO event (never reaches provider)', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification(),
        // A bogus tz string the LLM might emit — must NOT reach getAvailability /
        // createEvent (which build an Intl.DateTimeFormat and throw RangeError).
        scheduling_extract: extraction({ timezone: 'Not/AZone' }),
        scheduling_reply: REPLY,
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'Lets meet at 3pm tomorrow');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('scheduling_clarify');
    expect(prisma.draftEmail.rows).toHaveLength(1);
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    const clarify = prisma.auditLog.rows.find((a) => a.action === 'scheduling.clarify');
    expect(clarify).toBeTruthy();
    expect(String(clarify!.reason)).toContain('invalid');
  });

  it('interested_schedule but requiresHuman/low-confidence: escalates (no auto-scheduling)', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification({ requiresHuman: true }),
        scheduling_extract: extraction(),
        scheduling_reply: REPLY,
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'I am interested, can we meet next week?');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('escalated');
    expect(result.category).toBe('interested_schedule');
    // No scheduling side-effects: no event, no extractor run.
    expect(prisma.calendarEvent.rows).toHaveLength(0);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'escalation')).toBe(true);
  });

  it('subject-line unsubscribe (body neutral): suppression added via subject', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma);
    // Body has no opt-out phrase; the subject carries it.
    const mock = deps.email as MockEmailProvider;
    const [thread] = mock.preseed([
      {
        providerThreadId: 'thr_unsub',
        subject: 'unsubscribe',
        messages: [
          {
            providerMessageId: 'msg_unsub',
            from: { email: 'jane@acme.test' },
            to: [{ email: deps.config.defaultFromEmail }],
            subject: 'unsubscribe',
            body: 'Thanks for reaching out.',
            direction: EmailDirection.INBOUND,
          },
        ],
      },
    ]);
    const t = thread!;
    const result = await inboundEmailService(deps, {
      providerMessageId: t.messages[0]!.providerMessageId,
      threadId: t.providerThreadId,
    });

    expect(result.status).toBe('unsubscribed');
    expect(prisma.suppressionEntry.rows).toHaveLength(1);
    // Deterministic short-circuit: no classifier run.
    expect(prisma.agentRun.rows).toHaveLength(0);
  });

  it('classifier escalates (invalid output): persists an escalated AgentRun', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, { llmProvider: new FailingLlmProvider() });
    const { threadId, messageId } = preseedThread(deps, 'Some ambiguous message the classifier cannot parse.');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('escalated');
    // The escalation must be observable as a persisted (escalated) AgentRun.
    const run = prisma.agentRun.rows.find((r) => r.agentType === 'inbound_classifier');
    expect(run).toBeTruthy();
    expect(run!.status).toBe('escalated');
    expect(prisma.approvalItem.rows.some((a) => a.type === 'escalation')).toBe(true);
  });

  it('angry/sensitive: escalation ApprovalItem', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification({ category: 'angry', requiresHuman: true }),
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'This is completely unacceptable and I am furious about how this was handled.');

    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });

    expect(result.status).toBe('escalated');
    expect(result.category).toBe('angry');
    expect(prisma.approvalItem.rows.some((a) => a.type === 'escalation')).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'inbound.escalate')).toBe(true);
  });

  it('pricing with low confidence: escalation', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification({ category: 'pricing', requiresHuman: false, confidence: 0.4 }),
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'What does this cost?');
    const result = await inboundEmailService(deps, { providerMessageId: messageId, threadId });
    expect(result.status).toBe('escalated');
    expect(result.category).toBe('pricing');
  });

  it('duplicate providerMessageId: early return, no double-processing', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({
        inbound_classify: classification(),
        scheduling_extract: extraction(),
        scheduling_reply: REPLY,
      }),
    });
    const { threadId, messageId } = preseedThread(deps, 'I am interested, can we meet next week?');

    const first = await inboundEmailService(deps, { providerMessageId: messageId, threadId });
    expect(first.status).toBe('scheduling_proposed');
    const draftsAfterFirst = prisma.draftEmail.rows.length;
    const eventsAfterFirst = prisma.calendarEvent.rows.length;

    const second = await inboundEmailService(deps, { providerMessageId: messageId, threadId });
    expect(second.status).toBe('duplicate');
    // No new drafts/events from the duplicate.
    expect(prisma.draftEmail.rows).toHaveLength(draftsAfterFirst);
    expect(prisma.calendarEvent.rows).toHaveLength(eventsAfterFirst);
    expect(prisma.auditLog.rows.some((a) => a.action === 'inbound.duplicate')).toBe(true);
  });
});
