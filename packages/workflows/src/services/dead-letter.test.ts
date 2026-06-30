/**
 * Dead-letter tests: a terminal failure records a DeadLetter row, an ESCALATION
 * approval, and a `workflow.terminal_failure` audit, handling both Error and
 * plain-string thrown values.
 */
import { describe, it, expect } from 'vitest';
import { recordTerminalFailure } from './dead-letter.js';
import { FakePrisma, makeDeps } from './test-helpers.js';

describe('recordTerminalFailure', () => {
  it('writes a DeadLetter row + ESCALATION approval + terminal_failure audit', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);

    const result = await recordTerminalFailure(deps, {
      workflowType: 'outboundSequenceWorkflow',
      workflowId: 'outbound-p1-s1',
      input: { prospectId: 'p1', sequenceId: 's1' },
      error: new Error('provider exploded'),
    });

    expect(result.deadLetterId).toBeTruthy();
    expect(result.approvalItemId).toBeTruthy();

    expect(prisma.deadLetter.rows).toHaveLength(1);
    const dl = prisma.deadLetter.rows[0]!;
    expect(dl.workflowType).toBe('outboundSequenceWorkflow');
    expect(dl.workflowId).toBe('outbound-p1-s1');
    expect(dl.error).toBe('provider exploded');
    expect(dl.status).toBe('open');
    expect(typeof dl.stackRedacted === 'string').toBe(true);

    expect(prisma.approvalItem.rows.some((a) => a.type === 'escalation')).toBe(true);

    const audit = prisma.auditLog.rows.find((a) => a.action === 'workflow.terminal_failure');
    expect(audit).toBeTruthy();
    expect(audit!.allowed).toBe(false);
    expect(audit!.reason).toBe('provider exploded');
  });

  it('handles a non-Error thrown value (string) without a stack', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);

    await recordTerminalFailure(deps, {
      workflowType: 'inboundEmailWorkflow',
      input: { threadId: 't1' },
      error: 'plain string failure',
    });

    const dl = prisma.deadLetter.rows[0]!;
    expect(dl.error).toBe('plain string failure');
    expect(dl.stackRedacted).toBeNull();
    expect(dl.workflowId).toBeNull();
  });
});
