import { describe, it, expect } from 'vitest';
import { FakeCapRepo } from './fakes.js';

describe('FakeCapRepo (controlled-autonomy cap counts)', () => {
  it('returns preset counts and 0/null defaults', async () => {
    const last = new Date('2025-06-30T17:50:00.000Z');
    const repo = new FakeCapRepo({
      global: 3,
      sender: { 'sender@us.example.com': 2 },
      domain: { 'acme.com': 1 },
      lastSenderSendAt: { 'sender@us.example.com': last },
      threadReplies: { t1: 2 },
      calendarEvents: 4,
    });

    expect(await repo.countGlobalSentToday()).toBe(3);
    expect(await repo.countSenderSentToday('Sender@US.Example.com')).toBe(2);
    expect(await repo.countDomainSentToday('ACME.com')).toBe(1);
    expect(await repo.lastSenderSendAt('sender@us.example.com')).toEqual(last);
    expect(await repo.countThreadAutoRepliesToday('t1')).toBe(2);
    expect(await repo.countCalendarEventsToday()).toBe(4);

    // Unset keys default conservatively.
    expect(await repo.countSenderSentToday('other@x.com')).toBe(0);
    expect(await repo.lastSenderSendAt('other@x.com')).toBeNull();
    expect(await repo.countThreadAutoRepliesToday('t2')).toBe(0);
  });

  it('defaults to all-zero / null with no presets', async () => {
    const repo = new FakeCapRepo();
    expect(await repo.countGlobalSentToday()).toBe(0);
    expect(await repo.countCalendarEventsToday()).toBe(0);
    expect(await repo.lastSenderSendAt('a@b.com')).toBeNull();
  });
});
