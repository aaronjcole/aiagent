/**
 * The full ordered outbound safety gate sequence.
 *
 * This orchestrates the deterministic checks plus an *injected* LLM compliance
 * verdict (a parsed {@link ComplianceReview}; the LLM call itself happens in
 * `@app/agents`, never here). It is the single chokepoint every outbound send
 * must pass.
 *
 * Gate order (mirrors SPEC §9, adapted to the deterministic core):
 *   1. master send switch (SENDING_ENABLED) — recorded first; forces no
 *      auto-send when off, but does NOT block draft/approval creation
 *   2. prospect + valid email exists
 *   3. not suppressed (email/domain)
 *   4. not unsubscribed
 *   5. no prior negative reply
 *   6. sequence step limit ok
 *   7. daily / inbox / domain caps ok
 *   8. draft passed LLM compliance review (decision === 'pass')
 *   9. footer / unsubscribe present
 *  10. human approval requirement
 *  11. auto-send
 *
 * Gates 2-9 are SAFETY gates: any failure means `allowed = false`. The
 * governance/switch gates `sending_enabled` (gate 1), `human_approval`, and
 * `auto_send` govern *how* an allowed send proceeds (auto vs. human approval)
 * and never themselves set `allowed = false`. They drive `canAutoSend` and the
 * new `canSendWithApproval` (a human-approved send when auto-send is off, still
 * gated on the master SENDING_ENABLED switch).
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

/** All inputs, injected repos, and config for {@link runOutboundGates}. */
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

  /**
   * Subset of `Config` the gates read.
   * - `sendingEnabled` is the master kill switch (SPEC §9 gate 1): when false,
   *   no automatic send may occur (drafts/approvals are still created).
   * - `autoSendEnabled` governs whether auto-send is even permitted.
   */
  config: { autoSendEnabled: boolean; sendingEnabled: boolean };
  /** System-level kill switch read from SystemSetting; must be `true` to auto-send. */
  systemAutoSendSetting: boolean;
  /** Whether a human has already approved this specific send. */
  hasHumanApproval?: boolean;
}

/** Build a passing {@link GateDecision} for `gate`. */
function pass(gate: string, reason = 'ok'): GateDecision {
  return { gate, passed: true, reason };
}
/** Build a failing {@link GateDecision} for `gate` with the given reason. */
function fail(gate: string, reason: string): GateDecision {
  return { gate, passed: false, reason };
}

/**
 * Deterministic outbound safety-gate evaluator: the single chokepoint every
 * outbound send must pass. Runs the ordered gates (see file header) over the
 * injected repos/config plus the supplied {@link ComplianceReview}, and reports
 * the safety verdict plus whether the send may auto-send or needs human approval.
 */
export async function runOutboundGates(
  args: RunOutboundGatesArgs,
): Promise<OutboundGateResult> {
  const decisions: GateDecision[] = [];

  // --- Gate 1: master send kill switch (SENDING_ENABLED) ---
  // This is recorded as the first decision per SPEC §9 ordering. It does NOT
  // block draft/approval creation (it is not a hard gate); instead it forces
  // `canAutoSend = false` below so no automatic send can ever occur while the
  // master switch is off.
  const sendingEnabled = args.config.sendingEnabled === true;
  decisions.push(
    sendingEnabled
      ? pass('sending_enabled')
      : fail('sending_enabled', 'master send switch (SENDING_ENABLED) is off'),
  );

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

  // Safety gates determine the real safety verdict (`allowed`). These are ALL
  // gates EXCEPT the governance/switch gates `sending_enabled`,
  // `human_approval`, and `auto_send`, which govern *how* a safe send proceeds
  // (auto vs. human approval) and never themselves set `allowed = false`.
  const GOVERNANCE_GATES = new Set(['sending_enabled', 'human_approval', 'auto_send']);
  const safetyGatesPassed = decisions.every(
    (d) => GOVERNANCE_GATES.has(d.gate) || d.passed,
  );

  // --- Gate 9: human approval requirement ---
  // Auto-send is only permissible when the env flag AND the system setting are
  // both true. Otherwise this send requires human approval. NEVER default to
  // auto-send.
  // Auto-send additionally requires the master kill switch to be on.
  const autoSendPermitted =
    args.config.autoSendEnabled === true &&
    args.systemAutoSendSetting === true &&
    sendingEnabled;

  const hasHumanApproval = args.hasHumanApproval === true;

  // --- Gate 10: auto-send ---
  // Cleared for autonomous send: safety gates pass + master switch on + auto-send
  // permitted.
  const canAutoSend = safetyGatesPassed && autoSendPermitted && sendingEnabled;

  // Human approval authorizes a send when auto-send is off, but the master
  // SENDING_ENABLED switch is still required. With sendingEnabled=false this is
  // always false.
  const canSendWithApproval =
    safetyGatesPassed && sendingEnabled === true && hasHumanApproval === true;

  // Safe but not cleared for autonomous send → a human must approve.
  const requiresApproval = safetyGatesPassed && !canAutoSend;

  // --- Gate 9 decision (human_approval), audited but never blocks `allowed` ---
  if (!safetyGatesPassed) {
    // Blocked sends don't proceed at all; not an approvable item here.
    decisions.push(fail('human_approval', 'blocked by an earlier gate'));
  } else if (autoSendPermitted) {
    decisions.push(pass('human_approval', 'auto-send permitted; no approval required'));
  } else if (hasHumanApproval) {
    decisions.push(pass('human_approval', 'human approval present'));
  } else {
    decisions.push(
      fail('human_approval', 'human approval required (auto-send disabled)'),
    );
  }

  // --- Gate 10 decision (auto_send), audited ---
  decisions.push(
    canAutoSend
      ? pass('auto_send', 'eligible for automatic send')
      : fail(
          'auto_send',
          safetyGatesPassed
            ? 'auto-send disabled; requires human approval'
            : 'blocked by an earlier gate',
        ),
  );

  return {
    allowed: safetyGatesPassed,
    decisions,
    requiresApproval,
    canAutoSend,
    canSendWithApproval,
  };
}
