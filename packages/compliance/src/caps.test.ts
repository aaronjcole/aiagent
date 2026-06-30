import { describe, it, expect } from 'vitest';
import { checkSendingCaps } from './caps.js';
import { FakeSendCountRepo } from './fakes.js';
import type { SendingCapConfig } from './types.js';

const config: SendingCapConfig = {
  dailySendCap: 200,
  perInboxDailyCap: 50,
  perDomainDailyCap: 10,
  sequenceMaxSteps: 5,
};

const baseInput = {
  fromEmail: 'sender@us.example.com',
  recipientEmail: 'target@acme.com',
  prospectId: 'pros_1',
  sequenceId: 'seq_1',
};

describe('checkSendingCaps', () => {
  it('allows when all counts are within caps', async () => {
    const repo = new FakeSendCountRepo({
      global: 10,
      inbox: { 'sender@us.example.com': 5 },
      domain: { 'acme.com': 2 },
      sequenceSteps: { 'pros_1:seq_1': 1 },
    });
    const r = await checkSendingCaps(repo, config, baseInput);
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.counts).toEqual({ global: 10, inbox: 5, domain: 2, sequenceSteps: 1 });
  });

  it('triggers ONLY the global cap reason when global is exceeded', async () => {
    const repo = new FakeSendCountRepo({ global: 200 });
    const r = await checkSendingCaps(repo, config, baseInput);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('global daily send cap');
  });

  it('triggers the per-inbox cap independently', async () => {
    const repo = new FakeSendCountRepo({ inbox: { 'sender@us.example.com': 50 } });
    const r = await checkSendingCaps(repo, config, baseInput);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.includes('per-inbox'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('global'))).toBe(false);
  });

  it('triggers the per-domain cap independently', async () => {
    const repo = new FakeSendCountRepo({ domain: { 'acme.com': 10 } });
    const r = await checkSendingCaps(repo, config, baseInput);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.includes('per-domain'))).toBe(true);
  });

  it('triggers the sequence step limit independently', async () => {
    const repo = new FakeSendCountRepo({ sequenceSteps: { 'pros_1:seq_1': 5 } });
    const r = await checkSendingCaps(repo, config, baseInput);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.includes('sequence step limit'))).toBe(true);
  });

  it('honours a per-sequence maxSteps override', async () => {
    const repo = new FakeSendCountRepo({ sequenceSteps: { 'pros_1:seq_1': 3 } });
    const r = await checkSendingCaps(repo, config, { ...baseInput, sequenceMaxSteps: 3 });
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.includes('sequence step limit'))).toBe(true);
  });

  it('returns ALL failing reasons, not just the first', async () => {
    const repo = new FakeSendCountRepo({
      global: 250,
      inbox: { 'sender@us.example.com': 80 },
      domain: { 'acme.com': 20 },
      sequenceSteps: { 'pros_1:seq_1': 9 },
    });
    const r = await checkSendingCaps(repo, config, baseInput);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toHaveLength(4);
  });
});
