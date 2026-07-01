/**
 * Outbound service tests: drives one sequence step through draft → footer →
 * compliance → ordered gates, asserting the default approval path (no auto-send),
 * ineligibility short-circuits, and that a failing compliance verdict routes to
 * human review rather than sending.
 */
import { describe, it, expect } from 'vitest';
import { ProspectStatus, ResearchStatus, DraftStatus, EmailAutonomyMode } from '@app/shared';
import { readySettings } from '@app/compliance';
import type { SETTING_KEYS, AutonomySettingValue } from '@app/shared';
import { outboundSequenceService } from './outbound.js';
import { FakePrisma, makeDeps, FixedLlmProvider } from './test-helpers.js';
import type { ResearchOutput, ComplianceReview, OutreachDraft } from '@app/shared';

/** A ready, autonomous-send-enabled settings posture (all readiness flags on,
 * mode=limited_auto_send) with optional overrides. */
function autoSendSettings(
  over: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }> = {},
): ReturnType<typeof readySettings> {
  return readySettings({ emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND, ...over });
}

/** A clock inside business hours (12:00 ET = 16:00 UTC in summer EDT). */
const BUSINESS_HOURS_ISO = '2026-06-30T16:00:00.000Z';

const RESEARCH: ResearchOutput = {
  status: 'researched',
  summary: 'solid',
  companyInsights: 'insights',
  personalizationPoints: [],
  sources: [],
  dataGaps: [],
  confidence: 0.9,
  riskFlags: [],
};

const OUTREACH: OutreachDraft = {
  subject: 'Hello',
  body: 'Hi there, quick idea for your team.',
  personalizationUsed: [],
  callToAction: 'Open to a chat?',
  unsupportedClaims: [],
  confidence: 0.9,
  riskFlags: [],
};

/** A clean compliance verdict. */
function passReview(): ComplianceReview {
  return { decision: 'pass', issues: [], hasUnsupportedClaims: false, suggestedFixes: [], confidence: 0.95 };
}
/** A failing compliance verdict with one high-severity issue. */
function failReview(): ComplianceReview {
  return {
    decision: 'fail',
    issues: [{ code: 'X', severity: 'high', detail: 'bad' }],
    hasUnsupportedClaims: true,
    suggestedFixes: [],
    confidence: 0.9,
  };
}

/** Seed a READY prospect + a researched ResearchResult for the outbound flow. */
function seed(prisma: FakePrisma, opts: { researchStatus?: string } = {}): void {
  prisma.prospect.insert({
    id: 'p1',
    email: 'jane@acme.test',
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'VP',
    status: ProspectStatus.READY,
    companyId: null,
  });
  prisma.researchResult.insert({
    id: 'r1',
    prospectId: 'p1',
    status: opts.researchStatus ?? ResearchStatus.RESEARCHED,
    summary: 'solid',
    output: RESEARCH,
    confidence: 0.9,
    riskFlags: [],
    createdAt: 1,
  });
  prisma.outreachSequence.insert({ id: 's1', prospectId: 'p1', currentStep: 0, maxSteps: 5 });
}

function llm(review: ComplianceReview): FixedLlmProvider {
  return new FixedLlmProvider({
    outreach: OUTREACH,
    compliance: review,
  });
}

describe('outboundSequenceService', () => {
  it('auto-send OFF: creates DraftEmail + ApprovalItem, does NOT send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, { llmProvider: llm(passReview()) });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.draftEmail.rows).toHaveLength(1);
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.PENDING_REVIEW);
    expect(prisma.draftEmail.rows[0]!.sentAt).toBeUndefined();
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    // footer appended (unsubscribe url present)
    expect(String(prisma.draftEmail.rows[0]!.bodyText)).toContain(deps.config.unsubscribeBaseUrl);
    // No email.send audit.
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
    // Every gate decision audited.
    expect(prisma.auditLog.rows.filter((a) => String(a.action).startsWith('outbound.gate.')).length).toBeGreaterThan(5);
  });

  it('ineligible (suppressed): no draft created', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    prisma.suppressionEntry.insert({ id: 'sup1', email: 'jane@acme.test', domain: null, reason: 'unsubscribe' });
    const deps = makeDeps(prisma, { llmProvider: llm(passReview()) });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.SUPPRESSED);
    expect(prisma.auditLog.rows.some((a) => a.action === 'outbound.ineligible')).toBe(true);
  });

  it('ineligible (insufficient research): no draft created', async () => {
    const prisma = new FakePrisma();
    seed(prisma, { researchStatus: ResearchStatus.INSUFFICIENT });
    const deps = makeDeps(prisma, { llmProvider: llm(passReview()) });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });
    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
  });

  it('failing compliance review: draft persisted but blocked → approval, not sent', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(failReview()),
      config: { autoSendEnabled: true }, // even with env on, a failing gate blocks
    });
    // system setting on too
    prisma.systemSetting.insert({ id: 'set1', key: 'auto_send_enabled', value: true });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.PENDING_REVIEW);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
    const complianceGate = prisma.auditLog.rows.find((a) => a.action === 'outbound.gate.compliance_review');
    expect(complianceGate!.allowed).toBe(false);
  });

  it('LIMITED_AUTO_SEND + all policy gates pass: sends exactly once (idempotent)', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { autoSendEnabled: true, sendingEnabled: true, enableAutoSend: true },
      settings: autoSendSettings(),
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('sent');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.SENT);
    expect(prisma.draftEmail.rows[0]!.sentAt).toBeTruthy();
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.SEQUENCED);
    // policy allowed + succeeded audits present.
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.allowed')).toBe(true);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send.succeeded')).toHaveLength(1);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send')).toHaveLength(1);

    // Re-run is idempotent: same draft key, no second send.
    const again = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });
    expect(again.status).toBe('sent');
    expect(prisma.draftEmail.rows).toHaveLength(1);
    // CRITICAL: the rerun must NOT send again — exactly one succeeded audit.
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send.succeeded')).toHaveLength(1);
  });

  it('auto-send disabled by env (enableAutoSend=false): ApprovalItem, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { enableAutoSend: false, autoSendEnabled: true, sendingEnabled: true },
      settings: autoSendSettings(),
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.denied')).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'human_approval.fallback.created')).toBe(true);
  });

  it('auto-send disabled by SystemSetting (mode=approval_required): no send (default path)', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { enableAutoSend: true, sendingEnabled: true },
      // Default mode (approval_required) → never reaches the policy auto-send.
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    // The policy layer was never consulted (we are not in LIMITED_AUTO_SEND).
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.evaluated')).toBe(false);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
  });

  it('blocked by missing readiness: ApprovalItem + policy.denied', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { enableAutoSend: true, autoSendEnabled: true, sendingEnabled: true },
      // limited_auto_send mode but readiness NOT all-ready (default flags off).
      settings: { emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND },
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(denied).toBeTruthy();
    expect(String(denied!.reason)).toContain('readiness');
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
  });

  it('blocked by failed compliance review: ApprovalItem + policy.denied', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(failReview()),
      config: { enableAutoSend: true, autoSendEnabled: true, sendingEnabled: true },
      settings: autoSendSettings(),
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.denied')).toBe(true);
  });

  it('blocked by caps (per-sender daily cap reached): ApprovalItem + policy.denied', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { enableAutoSend: true, autoSendEnabled: true, sendingEnabled: true },
      settings: autoSendSettings({ maxAutoSendsPerSenderPerDay: 1 }),
      caps: { sender: { 'outreach@example.com': 5 } },
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('per-sender daily');
  });

  it('kill switch (pauseOutboundSending): blocked + killswitch.triggered + automation.paused', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { enableAutoSend: true, autoSendEnabled: true, sendingEnabled: true },
      settings: autoSendSettings({ pauseOutboundSending: true }),
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    expect(prisma.auditLog.rows.some((a) => a.action === 'killswitch.triggered')).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'automation.paused')).toBe(true);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
  });

  it('blocked by unsubscribe (prospect previously unsubscribed) is caught up front (ineligible)', async () => {
    // An unsubscribed prospect is ineligible BEFORE drafting (deterministic
    // eligibility), so the draft/approval flow is never reached — the safest
    // possible outcome. This documents the unsubscribe defense.
    const prisma = new FakePrisma();
    seed(prisma);
    prisma.prospect.rows[0]!.status = ProspectStatus.UNSUBSCRIBED;
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { enableAutoSend: true, sendingEnabled: true },
      settings: autoSendSettings(),
      clockIso: BUSINESS_HOURS_ISO,
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });
    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
  });
});
