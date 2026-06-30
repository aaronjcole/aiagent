import { describe, it, expect } from 'vitest';
import type { ComplianceReview } from '@app/shared';
import { runOutboundGates } from './gates.js';
import type { RunOutboundGatesArgs } from './gates.js';
import { FakeSuppressionRepo, FakeSendCountRepo } from './fakes.js';

const passReview: ComplianceReview = {
  decision: 'pass',
  issues: [],
  hasUnsupportedClaims: false,
  suggestedFixes: [],
  confidence: 0.95,
};

const failReview: ComplianceReview = {
  decision: 'fail',
  issues: [{ code: 'unsupported_claim', severity: 'high', detail: 'fabricated stat' }],
  hasUnsupportedClaims: true,
  suggestedFixes: ['remove claim'],
  confidence: 0.9,
};

function baseArgs(overrides: Partial<RunOutboundGatesArgs> = {}): RunOutboundGatesArgs {
  return {
    prospect: { id: 'pros_1', email: 'target@acme.com', status: 'ready' },
    fromEmail: 'sender@us.example.com',
    prospectId: 'pros_1',
    sequenceId: 'seq_1',
    replyHistory: { unsubscribed: false, negativeReply: false },
    body: 'Hi! Quick note about your work.',
    complianceReview: passReview,
    suppressionRepo: new FakeSuppressionRepo(),
    sendCountRepo: new FakeSendCountRepo({}),
    capConfig: { dailySendCap: 200, perInboxDailyCap: 50, perDomainDailyCap: 10, sequenceMaxSteps: 5 },
    footerConfig: {
      unsubscribeBaseUrl: 'https://example.com/unsubscribe',
      companyAddress: '123 Example St, City, ST 00000, USA',
    },
    config: { autoSendEnabled: false },
    systemAutoSendSetting: false,
    ...overrides,
  };
}

function gate(decisions: { gate: string; passed: boolean }[], name: string): boolean {
  return decisions.find((d) => d.gate === name)?.passed ?? false;
}

describe('runOutboundGates', () => {
  it('happy path with auto-send OFF: allowed but requires approval, no auto-send', async () => {
    const r = await runOutboundGates(baseArgs());
    expect(r.allowed).toBe(true);
    expect(r.requiresApproval).toBe(true);
    expect(r.canAutoSend).toBe(false);
    // All eight hard gates pass.
    for (const g of [
      'prospect_exists',
      'not_suppressed',
      'not_unsubscribed',
      'no_negative_reply',
      'sequence_limit',
      'sending_caps',
      'compliance_review',
      'footer_present',
    ]) {
      expect(gate(r.decisions, g)).toBe(true);
    }
  });

  it('a failing compliance review blocks the send', async () => {
    const r = await runOutboundGates(baseArgs({ complianceReview: failReview }));
    expect(r.allowed).toBe(false);
    expect(r.canAutoSend).toBe(false);
    expect(gate(r.decisions, 'compliance_review')).toBe(false);
  });

  it('needs_review compliance verdict blocks the hard gate', async () => {
    const review: ComplianceReview = { ...passReview, decision: 'needs_review' };
    const r = await runOutboundGates(baseArgs({ complianceReview: review }));
    expect(r.allowed).toBe(false);
    expect(gate(r.decisions, 'compliance_review')).toBe(false);
  });

  it('auto-send ON (env + system setting) with all gates passing -> canAutoSend', async () => {
    const r = await runOutboundGates(
      baseArgs({ config: { autoSendEnabled: true }, systemAutoSendSetting: true }),
    );
    expect(r.allowed).toBe(true);
    expect(r.canAutoSend).toBe(true);
    expect(r.requiresApproval).toBe(false);
  });

  it('NEVER auto-sends when env flag is on but system setting is off', async () => {
    const r = await runOutboundGates(
      baseArgs({ config: { autoSendEnabled: true }, systemAutoSendSetting: false }),
    );
    expect(r.canAutoSend).toBe(false);
    expect(r.requiresApproval).toBe(true);
  });

  it('NEVER auto-sends when system setting is on but env flag is off', async () => {
    const r = await runOutboundGates(
      baseArgs({ config: { autoSendEnabled: false }, systemAutoSendSetting: true }),
    );
    expect(r.canAutoSend).toBe(false);
    expect(r.requiresApproval).toBe(true);
  });

  it('human approval present clears requiresApproval without auto-send', async () => {
    const r = await runOutboundGates(baseArgs({ hasHumanApproval: true }));
    expect(r.allowed).toBe(true);
    expect(r.requiresApproval).toBe(false);
    expect(r.canAutoSend).toBe(false);
  });

  it('suppressed recipient blocks even with auto-send on', async () => {
    const repo = new FakeSuppressionRepo();
    await repo.upsert({ domain: 'acme.com', reason: 'global_block', source: 'test' });
    const r = await runOutboundGates(
      baseArgs({
        suppressionRepo: repo,
        config: { autoSendEnabled: true },
        systemAutoSendSetting: true,
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.canAutoSend).toBe(false);
    expect(gate(r.decisions, 'not_suppressed')).toBe(false);
  });

  it('exceeding a sending cap blocks the send', async () => {
    const r = await runOutboundGates(
      baseArgs({ sendCountRepo: new FakeSendCountRepo({ global: 999 }) }),
    );
    expect(r.allowed).toBe(false);
    expect(gate(r.decisions, 'sending_caps')).toBe(false);
  });

  it('missing/invalid recipient email blocks at gate 1', async () => {
    const r = await runOutboundGates(baseArgs({ prospect: { id: 'p', email: 'bad' }, toEmail: undefined }));
    expect(r.allowed).toBe(false);
    expect(gate(r.decisions, 'prospect_exists')).toBe(false);
  });
});
