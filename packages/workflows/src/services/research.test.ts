import { describe, it, expect } from 'vitest';
import { ProspectStatus, ResearchStatus } from '@app/shared';
import { researchProspectService } from './research.js';
import { FakePrisma, makeDeps, FailingLlmProvider, FixedLlmProvider } from './test-helpers.js';

function researchOutput(status: string) {
  return {
    status,
    summary: `summary for ${status}`,
    companyInsights: 'insights',
    personalizationPoints: [],
    sources: [],
    dataGaps: status === 'researched' ? [] : ['headcount'],
    confidence: status === 'researched' ? 0.85 : 0.4,
    riskFlags: [],
  };
}

function seedProspect(prisma: FakePrisma): void {
  prisma.company.insert({
    id: 'company_1',
    name: 'Acme',
    domain: 'acme.test',
    industry: 'Software',
    description: 'desc',
  });
  prisma.prospect.insert({
    id: 'prospect_1',
    email: 'jane@acme.test',
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'VP Eng',
    status: ProspectStatus.NEW,
    companyId: 'company_1',
  });
}

describe('researchProspectService', () => {
  it('happy path: stores ResearchResult and marks prospect ready', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma);

    const result = await researchProspectService(deps, { prospectId: 'prospect_1' });

    expect(result.status).toBe('researched');
    expect(result.researchStatus).toBe(ResearchStatus.RESEARCHED);
    expect(prisma.researchResult.rows).toHaveLength(1);
    const research = prisma.researchResult.rows[0]!;
    expect(research.prospectId).toBe('prospect_1');
    expect(research.summary).toBeTruthy();

    const prospect = prisma.prospect.rows[0]!;
    expect(prospect.status).toBe(ProspectStatus.RESEARCHED);

    // AgentRun + AuditLog written.
    expect(prisma.agentRun.rows).toHaveLength(1);
    expect(prisma.agentRun.rows[0]!.status).toBe('succeeded');
    expect(prisma.auditLog.rows.some((a) => a.action === 'research.completed')).toBe(true);
    // No escalation approval on the happy path.
    expect(prisma.approvalItem.rows).toHaveLength(0);
  });

  it('escalation path: agent EscalationError → ApprovalItem + escalated run', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, { llmProvider: new FailingLlmProvider() });

    const result = await researchProspectService(deps, { prospectId: 'prospect_1' });

    expect(result.status).toBe('escalated');
    expect(prisma.researchResult.rows).toHaveLength(0);
    expect(prisma.approvalItem.rows).toHaveLength(1);
    expect(prisma.approvalItem.rows[0]!.type).toBe('escalation');
    expect(prisma.agentRun.rows[0]!.status).toBe('escalated');
    expect(prisma.auditLog.rows.some((a) => a.action === 'research.escalated')).toBe(true);
    // Prospect flagged for human review.
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.NEEDS_REVIEW);
  });

  it('partial research → prospect status partial, no escalation approval', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({ research: researchOutput(ResearchStatus.PARTIAL) }),
    });

    const result = await researchProspectService(deps, { prospectId: 'prospect_1' });

    expect(result.status).toBe('researched');
    expect(result.researchStatus).toBe(ResearchStatus.PARTIAL);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.PARTIAL);
    expect(prisma.researchResult.rows[0]!.status).toBe(ResearchStatus.PARTIAL);
    // partial does not require human review.
    expect(prisma.approvalItem.rows).toHaveLength(0);
  });

  it('insufficient research → prospect status insufficient + escalation approval', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({ research: researchOutput(ResearchStatus.INSUFFICIENT) }),
    });

    const result = await researchProspectService(deps, { prospectId: 'prospect_1' });

    expect(result.researchStatus).toBe(ResearchStatus.INSUFFICIENT);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.INSUFFICIENT);
    expect(prisma.approvalItem.rows).toHaveLength(1);
    expect(prisma.approvalItem.rows[0]!.type).toBe('escalation');
  });

  it('needs_review research → prospect status needs_review + escalation approval', async () => {
    const prisma = new FakePrisma();
    seedProspect(prisma);
    const deps = makeDeps(prisma, {
      llmProvider: new FixedLlmProvider({ research: researchOutput(ResearchStatus.NEEDS_REVIEW) }),
    });

    const result = await researchProspectService(deps, { prospectId: 'prospect_1' });

    expect(result.researchStatus).toBe(ResearchStatus.NEEDS_REVIEW);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.NEEDS_REVIEW);
    expect(prisma.approvalItem.rows).toHaveLength(1);
    expect(prisma.approvalItem.rows[0]!.type).toBe('escalation');
  });

  it('throws NotFound + audits when the prospect is missing', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);
    await expect(researchProspectService(deps, { prospectId: 'nope' })).rejects.toThrow();
    expect(prisma.auditLog.rows.some((a) => a.action === 'research.prospect_not_found')).toBe(true);
  });
});
