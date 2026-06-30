import { describe, it, expect } from 'vitest';
import { EmailDirection, ProspectStatus } from '@app/shared';
import type { InboundClassification, SchedulingExtraction, SchedulingReplyDraft } from '@app/shared';
import { MockEmailProvider } from '@app/email';
import { inboundEmailService } from './inbound.js';
import { FakePrisma, makeDeps, FixedLlmProvider } from './test-helpers.js';

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
