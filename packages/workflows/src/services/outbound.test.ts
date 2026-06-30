import { describe, it, expect } from 'vitest';
import { ProspectStatus, ResearchStatus, DraftStatus } from '@app/shared';
import { outboundSequenceService } from './outbound.js';
import { FakePrisma, makeDeps, FixedLlmProvider } from './test-helpers.js';
import type { ResearchOutput, ComplianceReview, OutreachDraft } from '@app/shared';

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

function passReview(): ComplianceReview {
  return { decision: 'pass', issues: [], hasUnsupportedClaims: false, suggestedFixes: [], confidence: 0.95 };
}
function failReview(): ComplianceReview {
  return {
    decision: 'fail',
    issues: [{ code: 'X', severity: 'high', detail: 'bad' }],
    hasUnsupportedClaims: true,
    suggestedFixes: [],
    confidence: 0.9,
  };
}

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

  it('auto-send ON + all gates pass: sends exactly once (idempotent)', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      config: { autoSendEnabled: true, sendingEnabled: true },
    });
    prisma.systemSetting.insert({ id: 'set1', key: 'auto_send_enabled', value: true });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('sent');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.SENT);
    expect(prisma.draftEmail.rows[0]!.sentAt).toBeTruthy();
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.SEQUENCED);
    const sends = prisma.auditLog.rows.filter((a) => a.action === 'email.send');
    expect(sends).toHaveLength(1);

    // Re-run is idempotent: same draft key, no second send result divergence.
    const again = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });
    expect(again.status).toBe('sent');
    expect(prisma.draftEmail.rows).toHaveLength(1);
  });

  it('auto-send env + setting ON but SENDING_ENABLED off: NO send, approval created', async () => {
    const prisma = new FakePrisma();
    seed(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: llm(passReview()),
      // Auto-send fully enabled, but the master kill switch is OFF.
      config: { autoSendEnabled: true, sendingEnabled: false },
    });
    prisma.systemSetting.insert({ id: 'set1', key: 'auto_send_enabled', value: true });

    const result = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });

    expect(result.status).toBe('pending_approval');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.PENDING_REVIEW);
    // No outbound send happened, and no send audit was written.
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
    // An approval item was created for the outreach send.
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    // The sending_enabled gate is recorded as failed.
    const switchGate = prisma.auditLog.rows.find((a) => a.action === 'outbound.gate.sending_enabled');
    expect(switchGate!.allowed).toBe(false);
  });
});
