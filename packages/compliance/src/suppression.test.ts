import { describe, it, expect } from 'vitest';
import { SuppressionReason } from '@app/shared';
import { checkSuppression, addSuppression } from './suppression.js';
import { FakeSuppressionRepo } from './fakes.js';

describe('checkSuppression', () => {
  it('flags a listed email', async () => {
    const repo = new FakeSuppressionRepo();
    await repo.upsert({ email: 'blocked@acme.com', reason: SuppressionReason.UNSUBSCRIBE, source: 'test' });

    const r = await checkSuppression(repo, { email: 'Blocked@Acme.com' });
    expect(r.suppressed).toBe(true);
    expect(r.matchedOn).toBe('email');
  });

  it('flags an email whose domain is listed', async () => {
    const repo = new FakeSuppressionRepo();
    await repo.upsert({ domain: 'competitor.com', reason: SuppressionReason.COMPETITOR, source: 'test' });

    const r = await checkSuppression(repo, { email: 'someone@competitor.com' });
    expect(r.suppressed).toBe(true);
    expect(r.matchedOn).toBe('domain');
  });

  it('does not flag an unlisted email/domain', async () => {
    const repo = new FakeSuppressionRepo();
    await repo.upsert({ email: 'other@acme.com', reason: SuppressionReason.MANUAL, source: 'test' });

    const r = await checkSuppression(repo, { email: 'fresh@example.com' });
    expect(r.suppressed).toBe(false);
    expect(r.entry).toBeUndefined();
  });

  it('prefers email match over domain match', async () => {
    const repo = new FakeSuppressionRepo();
    await repo.upsert({ domain: 'acme.com', reason: SuppressionReason.GLOBAL_BLOCK, source: 'test' });
    await repo.upsert({ email: 'vip@acme.com', reason: SuppressionReason.UNSUBSCRIBE, source: 'test' });

    const r = await checkSuppression(repo, { email: 'vip@acme.com' });
    expect(r.matchedOn).toBe('email');
  });
});

describe('addSuppression', () => {
  it('is idempotent for the same email', async () => {
    const repo = new FakeSuppressionRepo();
    await addSuppression(repo, { email: 'dupe@acme.com', reason: SuppressionReason.BOUNCE, source: 'test' });
    await addSuppression(repo, { email: 'DUPE@acme.com', reason: SuppressionReason.BOUNCE, source: 'test' });
    expect(repo.size).toBe(1);
  });

  it('throws when neither email nor domain is provided', async () => {
    const repo = new FakeSuppressionRepo();
    await expect(addSuppression(repo, { reason: SuppressionReason.MANUAL, source: 'test' })).rejects.toThrow();
  });
});
