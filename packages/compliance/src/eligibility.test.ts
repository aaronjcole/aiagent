/** Tests for {@link checkEligibility}: prospect outreach eligibility rules. */
import { describe, it, expect } from 'vitest';
import { ResearchStatus } from '@app/shared';
import { checkEligibility } from './eligibility.js';
import type { CheckEligibilityInput } from './eligibility.js';

function base(): CheckEligibilityInput {
  return {
    prospect: { id: 'pros_1', email: 'good@example.com', status: 'ready' },
    research: { status: ResearchStatus.RESEARCHED },
    replyHistory: { unsubscribed: false, negativeReply: false },
    suppressionResult: { suppressed: false },
  };
}

describe('checkEligibility', () => {
  it('passes the happy path', () => {
    const r = checkEligibility(base());
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('accepts partial research', () => {
    const r = checkEligibility({ ...base(), research: { status: ResearchStatus.PARTIAL } });
    expect(r.eligible).toBe(true);
  });

  it('blocks when there is no prospect', () => {
    const r = checkEligibility({ ...base(), prospect: null });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('no prospect');
  });

  it('blocks an invalid email', () => {
    const r = checkEligibility({ ...base(), prospect: { id: 'p', email: 'not-an-email' } });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('no valid email');
  });

  it('blocks a suppressed prospect', () => {
    const r = checkEligibility({ ...base(), suppressionResult: { suppressed: true, matchedOn: 'domain' } });
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('suppressed'))).toBe(true);
  });

  it('blocks a prior unsubscribe', () => {
    const r = checkEligibility({ ...base(), replyHistory: { unsubscribed: true, negativeReply: false } });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('prior unsubscribe');
  });

  it('blocks a prior negative reply', () => {
    const r = checkEligibility({ ...base(), replyHistory: { unsubscribed: false, negativeReply: true } });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('prior negative reply');
  });

  it('blocks insufficient research', () => {
    const r = checkEligibility({ ...base(), research: { status: ResearchStatus.INSUFFICIENT } });
    expect(r.eligible).toBe(false);
    expect(r.reasons.some((x) => x.includes('research status not eligible'))).toBe(true);
  });

  it('blocks needs_review research', () => {
    const r = checkEligibility({ ...base(), research: { status: ResearchStatus.NEEDS_REVIEW } });
    expect(r.eligible).toBe(false);
  });

  it('blocks missing research', () => {
    const r = checkEligibility({ ...base(), research: null });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('research missing');
  });

  it('accumulates multiple reasons', () => {
    const r = checkEligibility({
      prospect: { id: 'p', email: 'bad' },
      research: { status: ResearchStatus.INSUFFICIENT },
      replyHistory: { unsubscribed: true, negativeReply: true },
      suppressionResult: { suppressed: true, matchedOn: 'email' },
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});
