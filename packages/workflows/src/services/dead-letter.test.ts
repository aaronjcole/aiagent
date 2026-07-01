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

  it('is idempotent: same workflowId/type twice → one DeadLetter, one ApprovalItem', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);
    const input = {
      workflowType: 'outboundSequenceWorkflow',
      workflowId: 'outbound-p1-s1',
      input: { prospectId: 'p1', sequenceId: 's1' },
      error: new Error('boom'),
    };

    const first = await recordTerminalFailure(deps, input);
    const second = await recordTerminalFailure(deps, input);

    // Exactly one of each durable record despite two recordings (Temporal retry).
    expect(prisma.deadLetter.rows).toHaveLength(1);
    expect(prisma.approvalItem.rows.filter((a) => a.type === 'escalation')).toHaveLength(1);
    expect(prisma.auditLog.rows.filter((a) => a.action === 'workflow.terminal_failure')).toHaveLength(1);
    // Both calls return the SAME ids.
    expect(second.deadLetterId).toBe(first.deadLetterId);
    expect(second.approvalItemId).toBe(first.approvalItemId);
  });

  it('redactStack/message scrubs secret-like substrings (sk-/Bearer/long tokens)', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);
    const err = new Error('auth failed with key sk-ant-abcdefgh12345678 and Authorization: Bearer abcDEF1234567890token');
    err.stack = `Error: leaked sk-ant-abcdefgh12345678\n    at foo (Bearer secrettoken1234567890abcd)`;

    await recordTerminalFailure(deps, {
      workflowType: 'researchProspectWorkflow',
      workflowId: 'research-p9',
      input: {},
      error: err,
    });

    const dl = prisma.deadLetter.rows[0]!;
    expect(String(dl.error)).not.toContain('sk-ant-abcdefgh12345678');
    expect(String(dl.error)).toContain('[REDACTED]');
    expect(String(dl.stackRedacted)).not.toContain('sk-ant-abcdefgh12345678');
    expect(String(dl.stackRedacted)).not.toContain('secrettoken1234567890abcd');
    expect(String(dl.stackRedacted)).toContain('[REDACTED]');
  });
});

/**
 * Replicate `withDeadLetter`'s try/catch contract (the Temporal workflow module
 * can't be imported without a workflow runtime): a dead-letter RECORDING failure
 * must be swallowed so the ORIGINAL workflow error is always rethrown.
 */
describe('withDeadLetter error-preservation contract', () => {
  async function withDeadLetter<T>(record: () => Promise<unknown>, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      try {
        await record();
      } catch {
        // swallowed: the original error below is the source of truth
      }
      throw error;
    }
  }

  it('rethrows the ORIGINAL error even when recording throws', async () => {
    const original = new Error('original workflow failure');
    await expect(
      withDeadLetter(
        () => Promise.reject(new Error('recording exploded')),
        () => Promise.reject(original),
      ),
    ).rejects.toBe(original);
  });
});
