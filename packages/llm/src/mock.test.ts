import { describe, expect, it } from 'vitest';
import {
  ComplianceReviewSchema,
  InboundClassificationSchema,
  OutreachDraftSchema,
  ResearchOutputSchema,
  SchedulingExtractionSchema,
  SchedulingReplyDraftSchema,
} from '@app/shared';
import { z } from 'zod';
import { MockLlmProvider } from './mock.js';
import { LlmClient } from './client.js';

const cases: { agentType: string; schema: z.ZodTypeAny }[] = [
  { agentType: 'research', schema: ResearchOutputSchema },
  { agentType: 'outreach', schema: OutreachDraftSchema },
  { agentType: 'compliance', schema: ComplianceReviewSchema },
  { agentType: 'inbound_classify', schema: InboundClassificationSchema },
  { agentType: 'scheduling_extract', schema: SchedulingExtractionSchema },
  { agentType: 'scheduling_reply', schema: SchedulingReplyDraftSchema },
];

describe('MockLlmProvider', () => {
  it.each(cases)('returns schema-valid output for $agentType', async ({ agentType, schema }) => {
    const client = new LlmClient(new MockLlmProvider());
    const res = await client.structured({
      system: 'You are a helpful agent.',
      input: { agentType, prospect: 'acme.com' },
      schema,
      agentType,
    });
    expect(res.attempts).toBe(1);
    expect(res.repaired).toBe(false);
    expect(res.provider).toBe('mock');
    // Re-validate explicitly against the real shared schema.
    expect(() => schema.parse(res.parsed)).not.toThrow();
    expect(res.usage).not.toBeNull();
  });

  it('also accepts the shared AgentType spellings', async () => {
    const provider = new MockLlmProvider();
    const r = await provider.rawComplete({
      model: 'mock-1',
      system: 's',
      input: { x: 1 },
      agentType: 'inbound_classifier',
    });
    expect(() => InboundClassificationSchema.parse(JSON.parse(r.text))).not.toThrow();
  });

  it('is deterministic: same input twice yields identical output', async () => {
    const provider = new MockLlmProvider();
    const input = { prospect: 'acme.com', name: 'Jane', step: 2 };
    const a = await provider.rawComplete({ model: 'mock-1', system: 's', input, agentType: 'outreach' });
    const b = await provider.rawComplete({ model: 'mock-1', system: 's', input, agentType: 'outreach' });
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
  });

  it('varies confidence deterministically by input', async () => {
    const provider = new MockLlmProvider();
    const a = await provider.rawComplete({ model: 'mock-1', system: 's', input: { a: 1 }, agentType: 'research' });
    const b = await provider.rawComplete({ model: 'mock-1', system: 's', input: { a: 2 }, agentType: 'research' });
    const ca = (JSON.parse(a.text) as { confidence: number }).confidence;
    const cb = (JSON.parse(b.text) as { confidence: number }).confidence;
    expect(ca).toBeGreaterThanOrEqual(0.7);
    expect(ca).toBeLessThanOrEqual(0.95);
    // Different inputs are allowed to differ; both must stay in range.
    expect(cb).toBeGreaterThanOrEqual(0.7);
    expect(cb).toBeLessThanOrEqual(0.95);
  });
});
