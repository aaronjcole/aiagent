/**
 * Pure eligibility check composed from already-resolved inputs. No I/O — the
 * caller resolves suppression / reply history / research and passes plain data.
 */

import { ResearchStatus } from '@app/shared';
import type {
  ProspectLike,
  ResearchLike,
  ReplyHistorySnapshot,
  SuppressionResult,
} from './types.js';
import { isValidEmail } from './email.js';

export interface CheckEligibilityInput {
  prospect: ProspectLike | null | undefined;
  research?: ResearchLike | null;
  replyHistory?: ReplyHistorySnapshot;
  suppressionResult?: SuppressionResult;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/** Research statuses that permit outreach. */
const ALLOWED_RESEARCH_STATUSES: ReadonlySet<string> = new Set([
  ResearchStatus.RESEARCHED,
  ResearchStatus.PARTIAL,
]);

/**
 * Determine whether a prospect is eligible for outreach. Accumulates ALL
 * blocking reasons (not just the first) for transparent auditing.
 *
 * Blocks when:
 *  - no prospect,
 *  - no valid email,
 *  - suppressed (email or domain),
 *  - prior unsubscribe,
 *  - prior negative / not-interested reply,
 *  - research status not in {researched, partial} (insufficient / needs_review
 *    block). Missing research is also blocking.
 */
export function checkEligibility(input: CheckEligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  const { prospect, research, replyHistory, suppressionResult } = input;

  if (!prospect) {
    return { eligible: false, reasons: ['no prospect'] };
  }

  if (!isValidEmail(prospect.email)) {
    reasons.push('no valid email');
  }

  if (suppressionResult?.suppressed) {
    const on = suppressionResult.matchedOn ? ` (matched ${suppressionResult.matchedOn})` : '';
    reasons.push(`suppressed${on}`);
  }

  if (replyHistory?.unsubscribed) {
    reasons.push('prior unsubscribe');
  }

  if (replyHistory?.negativeReply) {
    reasons.push('prior negative reply');
  }

  if (!research) {
    reasons.push('research missing');
  } else if (!ALLOWED_RESEARCH_STATUSES.has(research.status)) {
    reasons.push(`research status not eligible (${research.status})`);
  }

  return { eligible: reasons.length === 0, reasons };
}
