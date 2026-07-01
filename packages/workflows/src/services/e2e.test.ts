/**
 * End-to-end integration test (mocked providers, no Temporal, no DB, no network).
 *
 * Drives the full prospect lifecycle through the REAL service functions against
 * ONE shared {@link FakePrisma} + {@link makeDeps} (deterministic Mock email /
 * calendar / LLM, fixed clock). Asserts the safety-first invariants end to end:
 *   1. research → prospect researched + a ResearchResult row,
 *   2. outbound with auto-send OFF → DraftEmail + ApprovalItem, ZERO email.send,
 *   3. approve the draft + sendApprovedDraft with SENDING_ENABLED off → blocked,
 *      still no send; then with SENDING_ENABLED on → exactly one email.send,
 *      idempotent on rerun,
 *   4. inbound scheduling reply → reply draft + PROPOSED CalendarEvent (no
 *      providerEventId),
 *   5. inbound unsubscribe reply → SuppressionEntry added, no scheduling.
 *
 * Fully deterministic: no Date.now()/Math.random() — the fixed clock + Mock
 * providers + the canned MockLlmProvider outputs are used throughout.
 */

import { describe, it, expect } from 'vitest';
import {
  DraftStatus,
  EmailDirection,
  ProspectStatus,
  ResearchStatus,
} from '@app/shared';
import { MockEmailProvider } from '@app/email';
import { researchProspectService } from './research.js';
import { outboundSequenceService } from './outbound.js';
import { sendApprovedDraft } from './send.js';
import { inboundEmailService } from './inbound.js';
import { FakePrisma, makeDeps } from './test-helpers.js';

/** Filter audit rows down to actual `email.send` entries. */
const SEND = (rows: { id: string; [k: string]: unknown }[]) =>
  rows.filter((a) => a.action === 'email.send');

describe('end-to-end lifecycle (mocked providers)', () => {
  it('research → draft/approval → human-approved send → inbound scheduling + unsubscribe', async () => {
    const prisma = new FakePrisma();

    // Seed a company + prospect.
    prisma.company.insert({
      id: 'co1',
      name: 'Acme',
      domain: 'acme.test',
      industry: 'Software',
      description: 'Makes things',
    });
    prisma.prospect.insert({
      id: 'p1',
      email: 'jane@acme.test',
      firstName: 'Jane',
      lastName: 'Doe',
      title: 'VP Eng',
      status: ProspectStatus.NEW,
      companyId: 'co1',
    });
    prisma.outreachSequence.insert({ id: 's1', prospectId: 'p1', currentStep: 0, maxSteps: 5 });

    // Default config: auto-send + sending both OFF (safe default).
    const deps = makeDeps(prisma);

    // --- (1) Research -------------------------------------------------------
    const research = await researchProspectService(deps, { prospectId: 'p1' });
    expect(research.status).toBe('researched');
    expect(research.researchStatus).toBe(ResearchStatus.RESEARCHED);
    expect(prisma.researchResult.rows).toHaveLength(1);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.RESEARCHED);

    // --- (2) Outbound, auto-send OFF → draft + approval, NO send ------------
    const outbound = await outboundSequenceService(deps, { prospectId: 'p1', sequenceId: 's1' });
    expect(outbound.status).toBe('pending_approval');
    expect(prisma.draftEmail.rows).toHaveLength(1);
    const draftId = String(prisma.draftEmail.rows[0]!.id);
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.PENDING_REVIEW);
    expect(prisma.approvalItem.rows.some((a) => a.type === 'outreach_send')).toBe(true);
    expect(SEND(prisma.auditLog.rows)).toHaveLength(0);

    // --- (3a) Approve the draft, but SENDING_ENABLED still OFF → blocked ----
    // A human approves the draft (status APPROVED).
    prisma.draftEmail.rows[0]!.status = DraftStatus.APPROVED;

    const blocked = await sendApprovedDraft(deps, { draftId });
    expect(blocked.status).toBe('blocked');
    // Still no send.
    expect(SEND(prisma.auditLog.rows)).toHaveLength(0);
    // Draft stays APPROVED (not SENT).
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.APPROVED);
    expect(prisma.auditLog.rows.some((a) => a.action === 'email.send_blocked')).toBe(true);

    // --- (3b) Flip SENDING_ENABLED on → exactly one send, idempotent -------
    const sendingDeps = makeDeps(prisma, { config: { sendingEnabled: true } });
    const sent = await sendApprovedDraft(sendingDeps, { draftId });
    expect(sent.status).toBe('sent');
    expect(prisma.draftEmail.rows[0]!.status).toBe(DraftStatus.SENT);
    expect(SEND(prisma.auditLog.rows)).toHaveLength(1);

    // Rerun is idempotent: short-circuits on SENT, no second send.
    const again = await sendApprovedDraft(sendingDeps, { draftId });
    expect(again.status).toBe('sent');
    expect(SEND(prisma.auditLog.rows)).toHaveLength(1);

    // --- (4) Inbound scheduling reply → reply draft + PROPOSED event -------
    const mock = deps.email as MockEmailProvider;
    mock.preseed([
      {
        providerThreadId: 'thr_sched',
        subject: 'Re: Quick idea',
        messages: [
          {
            providerMessageId: 'msg_sched',
            from: { email: 'jane@acme.test' },
            to: [{ email: deps.config.defaultFromEmail }],
            subject: 'Re: Quick idea',
            body: 'Yes! I am interested — can we find a time next week? I am in America/New_York.',
            direction: EmailDirection.INBOUND,
          },
        ],
      },
    ]);

    const draftsBefore = prisma.draftEmail.rows.length;
    const scheduling = await inboundEmailService(deps, {
      providerMessageId: 'msg_sched',
      threadId: 'thr_sched',
    });
    expect(scheduling.status).toBe('scheduling_proposed');
    // A new reply draft was created (never auto-sent).
    expect(prisma.draftEmail.rows.length).toBe(draftsBefore + 1);
    // A PROPOSED calendar event with NO provider event id.
    const event = prisma.calendarEvent.rows.find((e) => e.id === scheduling.calendarEventId);
    expect(event).toBeTruthy();
    expect(event!.status).toBe('proposed');
    expect(event!.providerEventId).toBeUndefined();
    // The scheduling reply was NOT sent.
    expect(SEND(prisma.auditLog.rows)).toHaveLength(1);

    // --- (5) Inbound unsubscribe reply → suppression, no scheduling --------
    mock.preseed([
      {
        providerThreadId: 'thr_unsub',
        subject: 'Re: Quick idea',
        messages: [
          {
            providerMessageId: 'msg_unsub',
            from: { email: 'jane@acme.test' },
            to: [{ email: deps.config.defaultFromEmail }],
            subject: 'Re: Quick idea',
            body: 'Please unsubscribe me from all future emails.',
            direction: EmailDirection.INBOUND,
          },
        ],
      },
    ]);

    const eventsBefore = prisma.calendarEvent.rows.length;
    const unsub = await inboundEmailService(deps, {
      providerMessageId: 'msg_unsub',
      threadId: 'thr_unsub',
    });
    expect(unsub.status).toBe('unsubscribed');
    expect(prisma.suppressionEntry.rows.some((s) => s.email === 'jane@acme.test')).toBe(true);
    expect(prisma.prospect.rows[0]!.status).toBe(ProspectStatus.UNSUBSCRIBED);
    // No new calendar event from an unsubscribe.
    expect(prisma.calendarEvent.rows.length).toBe(eventsBefore);
    // And still exactly one real send across the whole lifecycle.
    expect(SEND(prisma.auditLog.rows)).toHaveLength(1);
  });
});
