/**
 * The full ordered outbound safety gate sequence.
 *
 * This orchestrates the deterministic checks plus an *injected* LLM compliance
 * verdict (a parsed {@link ComplianceReview}; the LLM call itself happens in
 * `@app/agents`, never here). It is the single chokepoint every outbound send
 * must pass.
 *
 * Gate order (mirrors SPEC §9, adapted to the deterministic core):
 *   1. prospect + valid email exists
 *   2. not suppressed (email/domain)
 *   3. not unsubscribed
 *   4. no prior negative reply
 *   5. sequence step limit ok
 *   6. daily / inbox / domain caps ok
 *   7. draft passed LLM compliance review (decision === 'pass')
 *   8. footer / unsubscribe present
 *   9. human approval requirement
 *  10. auto-send
 *
 * The first eight are HARD gates: any failure means `allowed = false`. Gates 9
 * and 10 govern *how* an allowed send proceeds (auto vs. human approval) and
 * never themselves set `allowed = false`.
 */

import type { ComplianceReview } from '@app/shared';
import type {
  GateDecision,
  OutboundGateResult,
  ProspectLike,
  ReplyHistorySnapshot,
  SendCountRepo,
  SendingCapConfig,
  SuppressionRepo,
  FooterConfig,
} from './types.js';
import { isValidEmail, normalizeEmail, extractDomain } from './email.js';
import { checkSuppression } from './suppression.js';
import { checkSendingCaps } from './caps.js';
import { ensureFooter } from './footer.js';

export interface RunOutboundGatesArgs {
  prospect: ProspectLike | null | undefined;
  /** Recipient email; defaults to `prospect.email` when omitted. */
  toEmail?: string;
  fromEmail: string;
  prospectId: string;
  sequenceId?: string;
  sequenceMaxSteps?: number;

  replyHistory?: ReplyHistorySnapshot;

  /** Draft body the footer gate inspects. */
  body: string;

  /** Parsed LLM compliance verdict (decision pass/fail/needs_review). */
  complianceReview: ComplianceReview;

  // Injected dependencies / configuration.
  suppressionRepo: SuppressionRepo;
  sendCountRepo: SendCountRepo;
  capConfig: SendingCapConfig;
  footerConfig: FooterConfig;

  /** From `Config.autoSendEnabled`. */
  config: { autoSendEnabled: boolean };
  /** System-level kill switch read from SystemSetting; must be `true` to auto-send. */
  systemAutoSendSetting: boolean;
  /** Whether a human has already approved this specific send. */
  hasHumanApproval?: boolean;
}

function pass(gate: string, reason = 'ok'): GateDecision {
  return { gate, passed: true, reason };
}
function fail(gate: string, reason: string): GateDecision {
  return { gate, passed: false, reason };
}

export async function runOutboundGates(
  args: RunOutboundGatesArgs,
): Promise<OutboundGateResult> {
  const decisions: GateDecision[] = [];

  const toEmail = (args.toEmail ?? args.prospect?.email ?? undefined) ?? undefined;
  const normalizedTo = toEmail ? normalizeEmail(toEmail) : undefined;
  const domain = normalizedTo ? extractDomain(normalizedTo) ?? undefined : undefined;

  // --- Gate 1: prospect + valid email exists ---
  if (!args.prospect) {
    decisions.push(fail('prospect_exists', 'no prospect'));
  } else if (!isValidEmail(normalizedTo)) {
    decisions.push(fail('prospect_exists', 'no valid recipient email'));
  } else {
    decisions.push(pass('prospect_exists'));
  }

  // --- Gate 2: not suppressed (email/domain) ---
  if (normalizedTo) {
    const sup = await checkSuppression(args.suppressionRepo, {
      email: normalizedTo,
      domain,
    });
    decisions.push(
      sup.suppressed
        ? fail('not_suppressed', `suppressed (matched ${sup.matchedOn ?? 'email'})`)
        : pass('not_suppressed'),
    );
  } else {
    decisions.push(fail('not_suppressed', 'no recipient email to check'));
  }

  // --- Gate 3: not unsubscribed ---
  decisions.push(
    args.replyHistory?.unsubscribed
      ? fail('not_unsubscribed', 'prospect previously unsubscribed')
      : pass('not_unsubscribed'),
  );

  // --- Gate 4: no prior negative reply ---
  decisions.push(
    args.replyHistory?.negativeReply
      ? fail('no_negative_reply', 'prospect previously replied negatively')
      : pass('no_negative_reply'),
  );

  // --- Gates 5 & 6: sequence limit + daily/inbox/domain caps ---
  const caps = await checkSendingCaps(args.sendCountRepo, args.capConfig, {
    fromEmail: args.fromEmail,
    domain,
    recipientEmail: normalizedTo,
    prospectId: args.prospectId,
    sequenceId: args.sequenceId,
    sequenceMaxSteps: args.sequenceMaxSteps,
  });

  const sequenceReason = caps.reasons.find((r) => r.startsWith('sequence step limit'));
  decisions.push(
    sequenceReason
      ? fail('sequence_limit', sequenceReason)
      : pass('sequence_limit'),
  );

  const capReasons = caps.reasons.filter((r) => !r.startsWith('sequence step limit'));
  decisions.push(
    capReasons.length > 0
      ? fail('sending_caps', capReasons.join('; '))
      : pass('sending_caps'),
  );

  // --- Gate 7: LLM compliance review verdict ---
  decisions.push(
    args.complianceReview.decision === 'pass'
      ? pass('compliance_review')
      : fail(
          'compliance_review',
          `compliance review decision = ${args.complianceReview.decision}`,
        ),
  );

  // --- Gate 8: footer / unsubscribe present (enforced via ensureFooter) ---
  const footer = ensureFooter(args.body, args.footerConfig);
  decisions.push(
    footer.hasUnsubscribe
      ? pass('footer_present', footer.added ? 'footer appended' : 'footer already present')
      : fail('footer_present', 'unable to ensure unsubscribe footer'),
  );

  // Hard gates 1-8 determine `allowed`.
  const hardGatesPassed = decisions.every((d) => d.passed);

  // --- Gate 9: human approval requirement ---
  // Auto-send is only permissible when the env flag AND the system setting are
  // both true. Otherwise this send requires human approval. NEVER default to
  // auto-send.
  const autoSendPermitted = args.config.autoSendEnabled === true && args.systemAutoSendSetting === true;

  let requiresApproval: boolean;
  if (!hardGatesPassed) {
    // Blocked sends don't proceed at all; not an approvable item here.
    requiresApproval = false;
    decisions.push(fail('human_approval', 'blocked by an earlier gate'));
  } else if (autoSendPermitted) {
    requiresApproval = false;
    decisions.push(pass('human_approval', 'auto-send permitted; no approval required'));
  } else if (args.hasHumanApproval === true) {
    requiresApproval = false;
    decisions.push(pass('human_approval', 'human approval present'));
  } else {
    requiresApproval = true;
    decisions.push(
      fail('human_approval', 'human approval required (auto-send disabled)'),
    );
  }

  // --- Gate 10: auto-send ---
  const canAutoSend = hardGatesPassed && autoSendPermitted;
  decisions.push(
    canAutoSend
      ? pass('auto_send', 'eligible for automatic send')
      : fail(
          'auto_send',
          hardGatesPassed
            ? 'auto-send disabled; requires human approval'
            : 'blocked by an earlier gate',
        ),
  );

  return {
    allowed: hardGatesPassed,
    decisions,
    requiresApproval,
    canAutoSend,
  };
}
