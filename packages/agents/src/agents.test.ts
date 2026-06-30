/**
 * Agent tests: each agent returns schema-valid output and populated metadata
 * against the mock provider, forwards the correct `agentType`, and propagates
 * `EscalationError` rather than swallowing it.
 */
import { describe, expect, it } from 'vitest';
import {
  ComplianceReviewSchema,
  EscalationError,
  InboundClassificationSchema,
  OutreachDraftSchema,
  ResearchOutputSchema,
  SchedulingExtractionSchema,
  SchedulingReplyDraftSchema,
  type ResearchOutput,
} from '@app/shared';
import { LlmClient, MockLlmProvider } from '@app/llm';
import type {
  LlmProvider,
  RawCompleteRequest,
  RawCompleteResult,
} from '@app/llm';
import {
  classifyInbound,
  draftOutreach,
  draftSchedulingReply,
  extractScheduling,
  researchProspect,
  reviewCompliance,
  type AgentMeta,
} from './index.js';

/** A client backed by the deterministic mock provider. */
function mockClient(): LlmClient {
  return new LlmClient(new MockLlmProvider());
}

/** Assert the metadata block is populated and internally consistent. */
function expectMeta(meta: AgentMeta): void {
  expect(meta.provider).toBe('mock');
  expect(meta.model).toBe('mock-1');
  expect(meta.attempts).toBeGreaterThanOrEqual(1);
  expect(meta.repaired).toBe(false);
  expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  expect(typeof meta.rawRedacted).toBe('string');
  expect(meta.rawRedacted.length).toBeGreaterThan(0);
  expect(meta.usage).not.toBeNull();
  expect(meta.usage?.totalTokens).toBeGreaterThan(0);
}

const research: ResearchOutput = {
  status: 'researched',
  summary: 's',
  companyInsights: 'c',
  personalizationPoints: [],
  sources: [],
  dataGaps: [],
  confidence: 0.8,
  riskFlags: [],
};

describe('agents return schema-valid output and populated meta against the mock', () => {
  it('researchProspect → ResearchOutput', async () => {
    const { output, meta } = await researchProspect(
      { prospect: { email: 'a@b.com', name: 'Ada' }, signals: [] },
      mockClient(),
    );
    expect(ResearchOutputSchema.safeParse(output).success).toBe(true);
    expectMeta(meta);
  });

  it('draftOutreach → OutreachDraft', async () => {
    const { output, meta } = await draftOutreach(
      {
        prospect: { email: 'a@b.com' },
        research,
        sequenceStep: 1,
        senderProfile: { name: 'Rep', email: 'rep@us.com' },
      },
      mockClient(),
    );
    expect(OutreachDraftSchema.safeParse(output).success).toBe(true);
    expectMeta(meta);
  });

  it('reviewCompliance → ComplianceReview', async () => {
    const { output, meta } = await reviewCompliance(
      {
        draftSubject: 'Hi',
        draftBody: 'Hello',
        prospect: { email: 'a@b.com' },
        policySummary: 'CAN-SPAM applies.',
      },
      mockClient(),
    );
    expect(ComplianceReviewSchema.safeParse(output).success).toBe(true);
    expectMeta(meta);
  });

  it('classifyInbound → InboundClassification', async () => {
    const { output, meta } = await classifyInbound(
      { subject: 'Re: hi', body: 'Sounds good, when can we talk?', fromEmail: 'a@b.com' },
      mockClient(),
    );
    expect(InboundClassificationSchema.safeParse(output).success).toBe(true);
    expectMeta(meta);
  });

  it('extractScheduling → SchedulingExtraction', async () => {
    const { output, meta } = await extractScheduling(
      { subject: 'Re: hi', body: 'How about Tuesday 2pm?', nowIso: '2026-06-30T12:00:00.000Z' },
      mockClient(),
    );
    expect(SchedulingExtractionSchema.safeParse(output).success).toBe(true);
    expectMeta(meta);
  });

  it('draftSchedulingReply → SchedulingReplyDraft', async () => {
    const extraction = SchedulingExtractionSchema.parse({
      hasSchedulingIntent: true,
      proposedTimes: [],
      timezone: null,
      timezoneAmbiguous: false,
      durationMinutes: null,
      selectedSlotIndex: null,
      needsClarification: false,
      clarificationQuestion: null,
      confidence: 0.8,
    });
    const classification = InboundClassificationSchema.parse({
      category: 'interested_schedule',
      requiresHuman: false,
      reasons: [],
      confidence: 0.8,
      riskFlags: [],
    });
    const { output, meta } = await draftSchedulingReply(
      { classification, extraction, nowIso: '2026-06-30T12:00:00.000Z' },
      mockClient(),
    );
    expect(SchedulingReplyDraftSchema.safeParse(output).success).toBe(true);
    expectMeta(meta);
  });
});

/** A provider that records the agentType it was asked for. */
class CapturingProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-1';
  readonly seen: string[] = [];
  constructor(private readonly inner = new MockLlmProvider()) {}
  /** Record the requested `agentType`, then delegate to the inner mock. */
  rawComplete(req: RawCompleteRequest): Promise<RawCompleteResult> {
    this.seen.push(req.agentType ?? '');
    return this.inner.rawComplete(req);
  }
}

describe('agents pass the correct agentType so the mock yields the right shape', () => {
  it('forwards each agentType verbatim to the provider', async () => {
    const provider = new CapturingProvider();
    const client = new LlmClient(provider);

    await researchProspect({ prospect: { email: 'a@b.com' } }, client);
    await draftOutreach(
      { prospect: { email: 'a@b.com' }, research, sequenceStep: 1, senderProfile: { name: 'R', email: 'r@b.com' } },
      client,
    );
    await reviewCompliance(
      { draftSubject: 's', draftBody: 'b', prospect: { email: 'a@b.com' }, policySummary: 'p' },
      client,
    );
    await classifyInbound({ subject: 's', body: 'b', fromEmail: 'a@b.com' }, client);
    await extractScheduling({ subject: 's', body: 'b', nowIso: '2026-06-30T12:00:00.000Z' }, client);
    const extraction = SchedulingExtractionSchema.parse({
      hasSchedulingIntent: false,
      proposedTimes: [],
      timezone: null,
      timezoneAmbiguous: false,
      durationMinutes: null,
      selectedSlotIndex: null,
      needsClarification: false,
      clarificationQuestion: null,
      confidence: 0.5,
    });
    const classification = InboundClassificationSchema.parse({
      category: 'question',
      requiresHuman: false,
      reasons: [],
      confidence: 0.5,
      riskFlags: [],
    });
    await draftSchedulingReply({ classification, extraction, nowIso: '2026-06-30T12:00:00.000Z' }, client);

    expect(provider.seen).toEqual([
      'research',
      'outreach',
      'compliance',
      'inbound_classify',
      'scheduling_extract',
      'scheduling_reply',
    ]);
  });
});

/** A provider that always returns un-parseable text, forcing escalation. */
class BadJsonProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'bad';
  /** Always return un-parseable text so the repair loop exhausts and escalates. */
  rawComplete(_req: RawCompleteRequest): Promise<RawCompleteResult> {
    return Promise.resolve({ text: 'definitely not json {{{', usage: null });
  }
}

describe('agents propagate EscalationError (do not swallow it)', () => {
  it('researchProspect throws EscalationError when the client exhausts repairs', async () => {
    const client = new LlmClient(new BadJsonProvider());
    await expect(researchProspect({ prospect: { email: 'a@b.com' } }, client)).rejects.toBeInstanceOf(
      EscalationError,
    );
  });

  it('classifyInbound throws EscalationError too', async () => {
    const client = new LlmClient(new BadJsonProvider());
    await expect(
      classifyInbound({ subject: 's', body: 'b', fromEmail: 'a@b.com' }, client),
    ).rejects.toBeInstanceOf(EscalationError);
  });
});
