import { describe, it, expect } from 'vitest';
import { DraftStatus, ProspectStatus, ValidationError } from '@app/shared';
import { sendApprovedDraft } from './send.js';
import { FakePrisma, makeDeps } from './test-helpers.js';

function seed(prisma: FakePrisma, draftStatus: string = DraftStatus.APPROVED): string {
  prisma.prospect.insert({
    id: 'p1',
    email: 'jane@acme.test',
    status: ProspectStatus.SEQUENCED,
    companyId: null,
  });
  const draft = prisma.draftEmail.insert({
    id: 'd1',
    idempotencyKey: 'draft-key-1',
    prospectId: 'p1',
    sequenceId: null,
    direction: 'outbound',
    fromEmail: 'outreach@example.com',
    fromName: 'Outreach',
    toEmail: 'jane@acme.test',
    subject: 'Hello',
    bodyText: 'Hi there. https://example.com/unsubscribe',
    status: draftStatus,
    complianceStatus: 'pass',
  });
  return String(draft.id);
}

describe('sendApprovedDraft', () => {
  it('throws ValidationError when the draft is not APPROVED', async () => {
    const prisma = new FakePrisma();
    const draftId = seed(prisma, DraftStatus.PENDING_REVIEW);
    const deps = makeDeps(prisma, { config: { sendingEnabled: true } });

    await expect(sendApprovedDraft(deps, { draftId })).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
  });

  it('blocks (no send) when SENDING_ENABLED is off, even with human approval', async () => {
    const prisma = new FakePrisma();
    const draftId = seed(prisma);
    const deps = makeDeps(prisma, { config: { sendingEnabled: false } });

    const result = await sendApprovedDraft(deps, { draftId });
    expect(result.status).toBe('blocked');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.APPROVED);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send')).toBe(false);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send_blocked')).toBe(true);
  });

  it('sends once when SENDING_ENABLED is on; idempotent on rerun (short-circuits SENT)', async () => {
    const prisma = new FakePrisma();
    const draftId = seed(prisma);
    const deps = makeDeps(prisma, { config: { sendingEnabled: true } });

    const r1 = await sendApprovedDraft(deps, { draftId });
    expect(r1.status).toBe('sent');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.SENT);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send')).toHaveLength(1);

    const r2 = await sendApprovedDraft(deps, { draftId });
    expect(r2.status).toBe('sent');
    expect(prisma.auditLog.rows.filter((a) => a.action === 'email.send')).toHaveLength(1);
  });
});
