import { describe, it, expect } from 'vitest';
import {
  ResearchOutputSchema,
  OutreachDraftSchema,
  ComplianceReviewSchema,
  InboundClassificationSchema,
  SchedulingExtractionSchema,
  SchedulingReplyDraftSchema,
} from './index.js';

describe('ResearchOutputSchema', () => {
  it('accepts a valid object', () => {
    const valid = {
      status: 'researched',
      summary: 'A summary.',
      companyInsights: 'Insights.',
      personalizationPoints: [
        { point: 'Recently raised Series B', evidence: 'TechCrunch article', sourceUrl: 'https://example.com/article' },
        { point: 'No public source', evidence: 'inference', sourceUrl: null },
      ],
      sources: [{ title: 'TechCrunch', url: 'https://techcrunch.com/x', snippet: '...' }],
      dataGaps: ['headcount'],
      confidence: 0.82,
      riskFlags: [],
    };
    expect(ResearchOutputSchema.parse(valid)).toEqual(valid);
  });

  it('rejects confidence > 1', () => {
    const bad = {
      status: 'researched',
      summary: 's',
      companyInsights: 'c',
      personalizationPoints: [],
      sources: [],
      dataGaps: [],
      confidence: 1.5,
      riskFlags: [],
    };
    expect(ResearchOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const bad = {
      status: 'researched',
      summary: 's',
      companyInsights: 'c',
      personalizationPoints: [],
      sources: [],
      dataGaps: [],
      confidence: 0.5,
      riskFlags: [],
      extra: 'nope',
    };
    expect(ResearchOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-url source url', () => {
    const bad = {
      status: 'researched',
      summary: 's',
      companyInsights: 'c',
      personalizationPoints: [],
      sources: [{ title: 't', url: 'not-a-url', snippet: 's' }],
      dataGaps: [],
      confidence: 0.5,
      riskFlags: [],
    };
    expect(ResearchOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('OutreachDraftSchema', () => {
  it('accepts a valid object', () => {
    const valid = {
      subject: 'Hi',
      body: 'Body',
      personalizationUsed: ['Series B'],
      callToAction: 'Book a call',
      unsupportedClaims: [],
      confidence: 0.7,
      riskFlags: [],
    };
    expect(OutreachDraftSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing required fields', () => {
    expect(OutreachDraftSchema.safeParse({ subject: 'Hi' }).success).toBe(false);
  });
});

describe('ComplianceReviewSchema', () => {
  it('accepts a valid object', () => {
    const valid = {
      decision: 'pass',
      issues: [{ code: 'MISSING_FOOTER', severity: 'high', detail: 'No address.' }],
      hasUnsupportedClaims: false,
      suggestedFixes: ['Add footer'],
      confidence: 0.9,
    };
    expect(ComplianceReviewSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an invalid severity', () => {
    const bad = {
      decision: 'pass',
      issues: [{ code: 'X', severity: 'critical', detail: 'd' }],
      hasUnsupportedClaims: false,
      suggestedFixes: [],
      confidence: 0.5,
    };
    expect(ComplianceReviewSchema.safeParse(bad).success).toBe(false);
  });
});

describe('InboundClassificationSchema', () => {
  it('accepts a valid object', () => {
    const valid = {
      category: 'interested_schedule',
      requiresHuman: false,
      reasons: ['mentioned a time'],
      confidence: 0.88,
      riskFlags: [],
    };
    expect(InboundClassificationSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown category', () => {
    const bad = {
      category: 'spam',
      requiresHuman: false,
      reasons: [],
      confidence: 0.5,
      riskFlags: [],
    };
    expect(InboundClassificationSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SchedulingExtractionSchema', () => {
  it('accepts a valid object', () => {
    const valid = {
      hasSchedulingIntent: true,
      proposedTimes: [
        { startIso: '2026-07-01T15:00:00.000Z', endIso: '2026-07-01T15:30:00.000Z' },
      ],
      timezone: 'America/New_York',
      timezoneAmbiguous: false,
      durationMinutes: 30,
      selectedSlotIndex: 0,
      needsClarification: false,
      clarificationQuestion: null,
      confidence: 0.75,
    };
    expect(SchedulingExtractionSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a non-iso datetime', () => {
    const bad = {
      hasSchedulingIntent: true,
      proposedTimes: [{ startIso: 'tomorrow', endIso: 'later' }],
      timezone: null,
      timezoneAmbiguous: false,
      durationMinutes: null,
      selectedSlotIndex: null,
      needsClarification: false,
      clarificationQuestion: null,
      confidence: 0.5,
    };
    expect(SchedulingExtractionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SchedulingReplyDraftSchema', () => {
  it('accepts a valid object', () => {
    const valid = {
      action: 'propose',
      body: 'How about these times?',
      proposedSlots: [
        { startIso: '2026-07-01T15:00:00.000Z', endIso: '2026-07-01T15:30:00.000Z' },
      ],
      confidence: 0.6,
    };
    expect(SchedulingReplyDraftSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown action', () => {
    const bad = {
      action: 'ignore',
      body: 'x',
      proposedSlots: [],
      confidence: 0.5,
    };
    expect(SchedulingReplyDraftSchema.safeParse(bad).success).toBe(false);
  });
});
