import { createHash } from 'node:crypto';
import type {
  ComplianceReview,
  InboundClassification,
  OutreachDraft,
  ResearchOutput,
  SchedulingExtraction,
  SchedulingReplyDraft,
} from '@app/shared';
import type { LlmProvider, RawCompleteRequest, RawCompleteResult } from './types.js';

/** Default model id reported by the mock. */
const MOCK_MODEL = 'mock-1';

/**
 * Normalize the various agentType spellings into a canonical key. Accepts both
 * the shared `AgentType` values and the short aliases used by callers.
 */
function normalizeAgentType(agentType: string | undefined): string {
  switch ((agentType ?? '').toLowerCase()) {
    case 'research':
      return 'research';
    case 'outreach':
      return 'outreach';
    case 'compliance':
      return 'compliance';
    case 'inbound_classifier':
    case 'inbound_classify':
    case 'inbound':
      return 'inbound';
    case 'scheduling_extractor':
    case 'scheduling_extract':
      return 'scheduling_extract';
    case 'scheduling_reply':
      return 'scheduling_reply';
    default:
      return 'research';
  }
}

/** Deterministic 32-bit unsigned hash of the request input (no randomness). */
function hashInput(input: unknown): number {
  const json = stableStringify(input);
  const hex = createHash('sha256').update(json).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16);
}

/** Deterministic JSON stringify with sorted object keys. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Map a hash to a confidence in [0.7, 0.95] deterministically. */
function confidenceFromHash(hash: number): number {
  const span = 26; // 0.70 .. 0.95 in 0.01 steps (26 values)
  return Math.round((0.7 + (hash % span) / 100) * 100) / 100;
}

/** Deterministic ISO datetime offset from a fixed base by `hours` hours. */
function isoAt(baseEpochMs: number, hours: number): string {
  return new Date(baseEpochMs + hours * 3_600_000).toISOString();
}

function buildResearch(hash: number): ResearchOutput {
  return {
    status: 'researched',
    summary:
      'Mid-market company showing recent growth signals; a clear fit for our offering based on public hiring and product announcements.',
    companyInsights:
      'Recently expanded their engineering team and announced a new product line, suggesting investment in operational tooling.',
    personalizationPoints: [
      {
        point: 'Hiring for several platform engineering roles',
        evidence: 'Multiple open requisitions on their careers page',
        sourceUrl: 'https://example.com/careers',
      },
      {
        point: 'Launched a new product line this quarter',
        evidence: 'Company blog announcement',
        sourceUrl: null,
      },
    ],
    sources: [
      {
        title: 'Company careers page',
        url: 'https://example.com/careers',
        snippet: 'We are hiring across platform and infrastructure teams.',
      },
      {
        title: 'Product launch announcement',
        url: 'https://example.com/blog/launch',
        snippet: 'Introducing our newest product line to better serve customers.',
      },
    ],
    dataGaps: ['Exact headcount unknown', 'Budget authority not confirmed'],
    confidence: confidenceFromHash(hash),
    riskFlags: [],
  };
}

function buildOutreach(hash: number): OutreachDraft {
  return {
    subject: 'Quick idea for your platform team',
    body: 'Hi there,\n\nNoticed your team is scaling its platform engineering org and recently launched a new product line. Teams at that stage often hit operational bottlenecks we help eliminate.\n\nWould you be open to a brief chat next week?\n\nBest regards',
    personalizationUsed: [
      'Hiring for several platform engineering roles',
      'Launched a new product line this quarter',
    ],
    callToAction: 'Would you be open to a brief 15-minute call next week?',
    unsupportedClaims: [],
    confidence: confidenceFromHash(hash),
    riskFlags: [],
  };
}

function buildCompliance(hash: number): ComplianceReview {
  return {
    decision: 'pass',
    issues: [],
    hasUnsupportedClaims: false,
    suggestedFixes: [],
    confidence: confidenceFromHash(hash),
  };
}

function buildInbound(hash: number): InboundClassification {
  return {
    category: 'interested_schedule',
    requiresHuman: false,
    reasons: ['Recipient expressed interest and asked about availability'],
    confidence: confidenceFromHash(hash),
    riskFlags: [],
  };
}

function buildSchedulingExtraction(hash: number): SchedulingExtraction {
  // Fixed base so output is fully deterministic (no Date.now()).
  const base = Date.UTC(2026, 6, 1, 9, 0, 0); // 2026-07-01T09:00:00Z
  return {
    hasSchedulingIntent: true,
    proposedTimes: [
      { startIso: isoAt(base, 0), endIso: isoAt(base, 1) },
      { startIso: isoAt(base, 24), endIso: isoAt(base, 25) },
    ],
    timezone: 'America/New_York',
    timezoneAmbiguous: false,
    durationMinutes: 30,
    selectedSlotIndex: null,
    needsClarification: false,
    clarificationQuestion: null,
    confidence: confidenceFromHash(hash),
  };
}

function buildSchedulingReply(hash: number): SchedulingReplyDraft {
  const base = Date.UTC(2026, 6, 1, 9, 0, 0);
  return {
    action: 'propose',
    body: 'Thanks for your interest! Here are a couple of times that work on my end — let me know which suits you best, or suggest another slot.',
    proposedSlots: [
      { startIso: isoAt(base, 0), endIso: isoAt(base, 1) },
      { startIso: isoAt(base, 24), endIso: isoAt(base, 25) },
    ],
    confidence: confidenceFromHash(hash),
  };
}

/**
 * Build a deterministic, schema-valid payload object for the given agent type.
 * Exposed for testing and reuse.
 */
export function mockPayloadFor(agentType: string | undefined, input: unknown): unknown {
  const hash = hashInput(input);
  switch (normalizeAgentType(agentType)) {
    case 'research':
      return buildResearch(hash);
    case 'outreach':
      return buildOutreach(hash);
    case 'compliance':
      return buildCompliance(hash);
    case 'inbound':
      return buildInbound(hash);
    case 'scheduling_extract':
      return buildSchedulingExtraction(hash);
    case 'scheduling_reply':
      return buildSchedulingReply(hash);
    default:
      return buildResearch(hash);
  }
}

/**
 * A deterministic, offline LLM provider. Requires no API keys and makes no
 * network calls. Given `req.agentType` it returns canned-but-plausible JSON
 * that is valid against the corresponding shared schema. Identical input always
 * yields identical output.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model: string;

  constructor(model: string = MOCK_MODEL) {
    this.model = model;
  }

  rawComplete(req: RawCompleteRequest): Promise<RawCompleteResult> {
    const payload = mockPayloadFor(req.agentType, req.input);
    const text = JSON.stringify(payload);
    // Deterministic, plausible token counts derived from text length.
    const promptTokens = Math.ceil(JSON.stringify(req.input ?? '').length / 4) + 8;
    const completionTokens = Math.ceil(text.length / 4);
    const usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
    return Promise.resolve({ text, usage });
  }
}
