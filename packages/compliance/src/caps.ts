/**
 * Sending-cap enforcement over a rolling 24h window plus per-prospect sequence
 * step limits. All counts are read through {@link SendCountRepo} so tests need
 * no database.
 *
 * All failing reasons are returned, not just the first — callers/auditors want
 * the complete picture.
 */

import type {
  SendCountRepo,
  SendingCapConfig,
  SendingCapCounts,
} from './types.js';
import { extractDomain, normalizeEmail } from './email.js';

export interface CheckSendingCapsInput {
  fromEmail: string;
  /** Recipient domain. If omitted, derived from `recipientEmail`. */
  domain?: string;
  recipientEmail?: string;
  prospectId: string;
  sequenceId?: string;
  /**
   * Per-sequence step limit override (e.g. `OutreachSequence.maxSteps`).
   * Falls back to `config.sequenceMaxSteps` when undefined.
   */
  sequenceMaxSteps?: number;
}

export interface CheckSendingCapsResult {
  allowed: boolean;
  reasons: string[];
  counts: SendingCapCounts;
}

/**
 * Enforce, in parallel:
 *  - DAILY_SEND_CAP   — global sends in the last 24h,
 *  - PER_INBOX_DAILY_CAP — sends from this fromEmail in the last 24h,
 *  - PER_DOMAIN_DAILY_CAP — sends to this recipient domain in the last 24h,
 *  - sequence step limit — steps already sent for this prospect/sequence.
 *
 * A cap is breached when the *current* count is already >= the cap, i.e. one
 * more send would exceed (or merely meet) the limit. We treat >= as the breach
 * boundary so the cap is the maximum number permitted in the window.
 */
export async function checkSendingCaps(
  repo: SendCountRepo,
  config: SendingCapConfig,
  input: CheckSendingCapsInput,
): Promise<CheckSendingCapsResult> {
  const fromEmail = normalizeEmail(input.fromEmail);
  const domain = (
    input.domain ?? (input.recipientEmail ? extractDomain(input.recipientEmail) : undefined)
  )?.toLowerCase();

  const [global, inbox, domainCount, sequenceSteps] = await Promise.all([
    repo.countGlobalSentLast24h(),
    repo.countByInboxLast24h(fromEmail),
    domain ? repo.countByDomainLast24h(domain) : Promise.resolve(0),
    repo.countSequenceStepsSent(input.prospectId, input.sequenceId),
  ]);

  const counts: SendingCapCounts = { global, inbox, domain: domainCount, sequenceSteps };
  const reasons: string[] = [];

  const stepLimit = input.sequenceMaxSteps ?? config.sequenceMaxSteps;

  if (global >= config.dailySendCap) {
    reasons.push(
      `global daily send cap reached (${global}/${config.dailySendCap})`,
    );
  }
  if (inbox >= config.perInboxDailyCap) {
    reasons.push(
      `per-inbox daily cap reached for ${fromEmail} (${inbox}/${config.perInboxDailyCap})`,
    );
  }
  if (domain && domainCount >= config.perDomainDailyCap) {
    reasons.push(
      `per-domain daily cap reached for ${domain} (${domainCount}/${config.perDomainDailyCap})`,
    );
  }
  if (sequenceSteps >= stepLimit) {
    reasons.push(
      `sequence step limit reached (${sequenceSteps}/${stepLimit})`,
    );
  }

  return { allowed: reasons.length === 0, reasons, counts };
}
