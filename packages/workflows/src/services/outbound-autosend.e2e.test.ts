/**
 * Focused end-to-end verification of the LIMITED_AUTO_SEND outbound auto-send
 * path, driving {@link outboundSequenceService} with the in-memory FakePrisma +
 * the deterministic MOCK providers + a ready FakeSettingsReader + a FakeCapRepo.
 *
 * The MOCK email provider's `sendMessage` is wrapped in a spy so we can count
 * EXACTLY how many sends occur. No real provider, no DB, no network.
 *
 * Target config (per the scenario):
 *  env:      ENABLE_AUTO_SEND=true, SENDING_ENABLED=true, EMAIL_PROVIDER=mock
 *  setting:  emailAutonomyMode=limited_auto_send; all 8 readiness flags true;
 *            caps: global=3, sender=3, domain=1, prospectPerSeq=1, minMin=10;
 *            kill switches off.
 */
import { describe, it, expect, vi, type MockInstance } from 'vitest';
import {
  ProspectStatus,
  ResearchStatus,
  DraftStatus,
  EmailAutonomyMode,
  idempotencyKey,
} from '@app/shared';
import { readySettings, domainOf } from '@app/compliance';
import type { SETTING_KEYS, AutonomySettingValue } from '@app/shared';
import type { ResearchOutput, ComplianceReview, OutreachDraft } from '@app/shared';
import { outboundSequenceService } from './outbound.js';
import { FakePrisma, makeDeps, FixedLlmProvider } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures matching the target config
// ---------------------------------------------------------------------------

/** A clock inside business hours (12:00 ET = 16:00 UTC in summer EDT). */
const BUSINESS_HOURS_ISO = '2026-06-30T16:00:00.000Z';

const FROM_EMAIL = 'outreach@example.com';
const TO_EMAIL = 'jane@acme.test';
const TO_DOMAIN = domainOf(TO_EMAIL); // acme.test

/** The five caps + min-minutes the scenario specifies. */
const TARGET_CAPS = {
  maxAutoSendsPerDayGlobal: 3,
  maxAutoSendsPerSenderPerDay: 3,
  maxAutoSendsPerDomainPerDay: 1,
  maxAutoSendsPerProspectPerSequence: 1,
  minMinutesBetweenAutoSendsPerSender: 10,
} satisfies Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }>;

/** Ready (all 8 readiness flags on) + limited_auto_send + target caps. */
function targetSettings(
  over: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }> = {},
): ReturnType<typeof readySettings> {
  return readySettings({
    emailAutonomyMode: EmailAutonomyMode.LIMITED_AUTO_SEND,
    ...TARGET_CAPS,
    ...over,
  });
}

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
  subject: 'A quick idea for Acme',
  body: 'Hi Jane, quick idea for your team based on what we found.',
  personalizationUsed: [],
  callToAction: 'Open to a chat?',
  unsupportedClaims: [],
  confidence: 0.9,
  riskFlags: [],
};

/** A clean, approving compliance verdict (confidence >= threshold, no claims). */
function passReview(): ComplianceReview {
  return { decision: 'pass', issues: [], hasUnsupportedClaims: false, suggestedFixes: [], confidence: 0.95 };
}
/** A failing compliance verdict. */
function failReview(): ComplianceReview {
  return {
    decision: 'fail',
    issues: [{ code: 'X', severity: 'high', detail: 'bad' }],
    hasUnsupportedClaims: false,
    suggestedFixes: [],
    confidence: 0.95,
  };
}
/** An approving verdict that nonetheless flags unsupported claims. */
function unsupportedClaimReview(): ComplianceReview {
  return {
    decision: 'pass',
    issues: [],
    hasUnsupportedClaims: true,
    suggestedFixes: [],
    confidence: 0.95,
  };
}

function llm(review: ComplianceReview): FixedLlmProvider {
  return new FixedLlmProvider({ outreach: OUTREACH, compliance: review });
}

/** Seed a COMPLETE-research, ready, valid prospect + a sequence step. */
function seed(
  prisma: FakePrisma,
  opts: { email?: string | null; status?: string; researchStatus?: string } = {},
): void {
  prisma.prospect.insert({
    id: 'p1',
    email: opts.email === undefined ? TO_EMAIL : opts.email,
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'VP',
    status: opts.status ?? ProspectStatus.READY,
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

/** Build deps with the target env + a sendMessage spy installed on the mock. */
function makeTargetDeps(
  prisma: FakePrisma,
  over: {
    review?: ComplianceReview;
    settings?: ReturnType<typeof readySettings>;
    caps?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
) {
  const deps = makeDeps(prisma, {
    llmProvider: llm(over.review ?? passReview()),
    // Target env: master kill switch on, autonomy env on, EMAIL_PROVIDER=mock
    // (the mock is what makeDeps always wires for `email`).
    config: { enableAutoSend: true, sendingEnabled: true, autoSendEnabled: true, ...over.config },
    settings: over.settings ?? targetSettings(),
    caps: over.caps ?? {},
    clockIso: BUSINESS_HOURS_ISO,
  });
  const sendSpy = vi.spyOn(deps.email, 'sendMessage');
  return { deps, sendSpy };
}

// ---------------------------------------------------------------------------
// PART 1 — HAPPY PATH (checkpoints 1-8)
// ---------------------------------------------------------------------------

describe('LIMITED_AUTO_SEND outbound — happy path (mock provider)', () => {
  it('sends exactly once and records the full audit/idempotency trail', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma);

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('sent');

    // (1) prospect + ResearchResult exist (complete research).
    expect(prisma.prospect.rows).toHaveLength(1);
    const research = prisma.researchResult.rows[0]!;
    expect(research.status).toBe(ResearchStatus.RESEARCHED);
    expect(Number(research.confidence)).toBeGreaterThanOrEqual(0.7);

    // (2) an outbound DraftEmail was generated.
    expect(prisma.draftEmail.rows).toHaveLength(1);
    const draft = prisma.draftEmail.rows[0]!;
    expect(draft.toEmail).toBe(TO_EMAIL);
    expect(draft.fromEmail).toBe(FROM_EMAIL);

    // (3) the compliance reviewer ran (verdict recorded on draft + AgentRun).
    expect(draft.complianceStatus).toBe('pass');
    expect(prisma.agentRun.rows.some((r) => r.agentType === 'compliance')).toBe(true);
    expect(prisma.agentRun.rows.some((r) => r.agentType === 'outreach')).toBe(true);

    // (4) deterministic policy evaluated every gate → allow; both
    //     policy.evaluated and policy.allowed audited; allow has no reasons.
    const evaluated = prisma.auditLog.rows.find((a) => a.action === 'policy.evaluated');
    const allowedAudit = prisma.auditLog.rows.find((a) => a.action === 'policy.allowed');
    expect(evaluated).toBeTruthy();
    expect(allowedAudit).toBeTruthy();
    expect(allowedAudit!.allowed).toBe(true);
    // No policy.denied was written (every gate passed).
    expect(prisma.auditLog.rows.some((a) => a.action === 'policy.denied')).toBe(false);
    // Every legacy gate decision was also audited.
    expect(
      prisma.auditLog.rows.filter((a) => String(a.action).startsWith('outbound.gate.')).length,
    ).toBeGreaterThan(5);

    // (5) EXACTLY ONE sendMessage call; DraftEmail flips to SENT.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(draft.status).toBe(DraftStatus.SENT);

    // (6) the send is persisted with a provider message id; sentAt set.
    const succeeded = prisma.auditLog.rows.find((a) => a.action === 'email.send.succeeded');
    expect(succeeded).toBeTruthy();
    expect((succeeded!.metadata as { providerMessageId?: string }).providerMessageId).toBeTruthy();
    expect(draft.sentAt).toBeTruthy();
    // The spy resolved a SendResult carrying the providerMessageId.
    const sendResult = await sendSpy.mock.results[0]!.value;
    expect(sendResult.providerMessageId).toBeTruthy();

    // (7) the full audit trail is present.
    expect(prisma.auditLog.rows.filter((a) => a.action === 'policy.evaluated')).toHaveLength(1);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send.attempted')).toHaveLength(1);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send.succeeded')).toHaveLength(1);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send')).toHaveLength(1);

    // The draft carries the SPEC idempotency key
    // [prospectId, sequenceId, stepNumber, senderIdentity, normalizedRecipient].
    const expectedKey = idempotencyKey(['p1', 's1', '1', FROM_EMAIL, TO_EMAIL]);
    expect(draft.idempotencyKey).toBe(expectedKey);

    // (8) DUPLICATE workflow execution (same prospect/sequence/step) does NOT
    //     send again: spy stays at 1, one draft, returns the existing SENT draft.
    const again = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });
    expect(again.status).toBe('sent');
    expect(again.draftId).toBe(draft.id);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(prisma.draftEmail.rows).toHaveLength(1);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send.succeeded')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PART 1 — NEGATIVE CASES (each: NO send + safe fallback + audit reason)
// ---------------------------------------------------------------------------

describe('LIMITED_AUTO_SEND outbound — negative cases (no send)', () => {
  /** Assert no send happened and no success audit was written. */
  function expectNoSend<T extends MockInstance>(prisma: FakePrisma, sendSpy: T) {
    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
    expect(prisma.draftEmail.rows.every((d) => d.status !== DraftStatus.SENT)).toBe(true);
  }

  it('suppressed prospect (email) → ineligible before drafting, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    prisma.suppressionEntry.insert({ id: 'sup1', email: TO_EMAIL, domain: null, reason: 'bounce' });
    const { deps, sendSpy } = makeTargetDeps(prisma);

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.SUPPRESSED);
    expect(prisma.auditLog.rows.some((a) => a.action === 'outbound.ineligible')).toBe(true);
    expectNoSend(prisma, sendSpy);
  });

  it('suppressed prospect (domain) → ineligible before drafting, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    prisma.suppressionEntry.insert({ id: 'sup1', email: null, domain: TO_DOMAIN, reason: 'bounce' });
    const { deps, sendSpy } = makeTargetDeps(prisma);

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
    expectNoSend(prisma, sendSpy);
  });

  it('unsubscribed prospect → ineligible before drafting, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma, { status: ProspectStatus.UNSUBSCRIBED });
    const { deps, sendSpy } = makeTargetDeps(prisma);

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
    expect(prisma.auditLog.rows.some((a) => a.action === 'outbound.ineligible')).toBe(true);
    expectNoSend(prisma, sendSpy);
  });

  it('missing email (prospect.email empty) → ineligible, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma, { email: '' });
    const { deps, sendSpy } = makeTargetDeps(prisma);

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('ineligible');
    expect(prisma.draftEmail.rows).toHaveLength(0);
    expectNoSend(prisma, sendSpy);
  });

  it('failed compliance review (decision=fail) → policy.denied + ApprovalItem, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, { review: failReview() });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(denied).toBeTruthy();
    expect(String(denied!.reason)).toContain('compliance review decision is fail');
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expectNoSend(prisma, sendSpy);
  });

  it('low compliance confidence (< threshold) → policy.denied, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, {
      review: { decision: 'pass', issues: [], hasUnsupportedClaims: false, suggestedFixes: [], confidence: 0.3 },
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('compliance confidence');
    expectNoSend(prisma, sendSpy);
  });

  it('unsupported claim flagged (hasUnsupportedClaims) → policy.denied, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, { review: unsupportedClaimReview() });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('unsupported claim');
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expectNoSend(prisma, sendSpy);
  });

  it('daily GLOBAL cap exceeded (countGlobalSentToday >= 3) → policy.denied, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, { caps: { global: 3 } });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('global daily auto-send cap');
    expectNoSend(prisma, sendSpy);
  });

  it('domain cap exceeded (countDomainSentToday >= 1) → policy.denied, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, { caps: { domain: { [TO_DOMAIN]: 1 } } });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('per-domain daily auto-send cap');
    expectNoSend(prisma, sendSpy);
  });

  it('per-sender cap exceeded (countSenderSentToday >= 3) → policy.denied, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, { caps: { sender: { [FROM_EMAIL]: 3 } } });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('per-sender daily auto-send cap');
    expectNoSend(prisma, sendSpy);
  });

  it('min-minutes-between-sends not met → policy.denied, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    // Last send 1 minute ago (< the 10-minute minimum).
    const lastAt = new Date(new Date(BUSINESS_HOURS_ISO).getTime() - 60 * 1000);
    const { deps, sendSpy } = makeTargetDeps(prisma, {
      caps: { lastSenderSendAt: { [FROM_EMAIL]: lastAt } },
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    const denied = prisma.auditLog.rows.find((a) => a.action === 'policy.denied');
    expect(String(denied!.reason)).toContain('min minutes between sends');
    expectNoSend(prisma, sendSpy);
  });

  it('global pause kill switch → killswitch.triggered + automation.paused, no send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, {
      settings: targetSettings({ globalPauseAllAutomation: true }),
    });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.auditLog.rows.some((a) => a.action === 'killswitch.triggered')).toBe(true);
    expect(prisma.auditLog.rows.some((a) => a.action === 'automation.paused')).toBe(true);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expectNoSend(prisma, sendSpy);
  });

  it('duplicate idempotency key already SENT → idempotent short-circuit, no second send', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    // Pre-insert a DraftEmail with the SAME spec idempotency key, already SENT.
    const key = idempotencyKey(['p1', 's1', '1', FROM_EMAIL, TO_EMAIL]);
    prisma.draftEmail.insert({
      id: 'd-pre',
      idempotencyKey: key,
      prospectId: 'p1',
      sequenceId: 's1',
      toEmail: TO_EMAIL,
      fromEmail: FROM_EMAIL,
      subject: OUTREACH.subject,
      bodyText: 'already sent body',
      status: DraftStatus.SENT,
      sentAt: new Date(BUSINESS_HOURS_ISO),
    });
    const { deps, sendSpy } = makeTargetDeps(prisma);

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    // Returns the existing SENT draft, no second send, no new draft row.
    expect(result.status).toBe('sent');
    expect(result.draftId).toBe('d-pre');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.draftEmail.rows).toHaveLength(1);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send.succeeded')).toBe(false);
  });

  it('SENDING_ENABLED=false (master switch off) → no send even when otherwise allowed', async () => {
    // Defense-in-depth: the runOutboundGates send-site `sendingEnabled` guard
    // must keep an otherwise-eligible prospect from auto-sending.
    const prisma = new FakePrisma();
    seed(prisma);
    const { deps, sendSpy } = makeTargetDeps(prisma, { config: { sendingEnabled: false } });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expectNoSend(prisma, sendSpy);
  });
});
