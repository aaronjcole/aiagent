import { describe, it, expect } from 'vitest';
import { FakeReservationStore, readySettings } from './fakes.js';
import type { ReserveSendArgs, ReserveCalendarArgs } from './reservations.js';

function sendArgs(over: Partial<ReserveSendArgs> = {}): ReserveSendArgs {
  return {
    kind: 'send',
    senderEmail: 'sender@us.example.com',
    recipientEmail: 'target@acme.com',
    action: 'email.send',
    entityType: 'draft_email',
    entityId: 'draft_1',
    idempotencyKey: 'idem-1',
    ...over,
  };
}

function calArgs(over: Partial<ReserveCalendarArgs> = {}): ReserveCalendarArgs {
  return {
    kind: 'calendar',
    entityType: 'email_thread',
    entityId: 'thread_1',
    idempotencyKey: 'cal-idem-1',
    ...over,
  };
}

describe('reserveAutoAction (via FakeReservationStore)', () => {
  it('allows and writes a reservation when within cap', async () => {
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerDayGlobal: 2 }));
    const r = await store.reserve(sendArgs());
    expect(r.allowed).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      kind: 'send',
      senderEmail: 'sender@us.example.com',
      recipientDomain: 'acme.com',
      idempotencyKey: 'idem-1',
    });
  });

  it('denies at the global cap without writing a reservation', async () => {
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerDayGlobal: 1 }));
    const first = await store.reserve(sendArgs({ idempotencyKey: 'k1' }));
    expect(first.allowed).toBe(true);
    const second = await store.reserve(sendArgs({ idempotencyKey: 'k2' }));
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('global daily auto-send cap reached');
    // No extra reservation was written on denial.
    expect(store.rows).toHaveLength(1);
  });

  it('a second call after a reservation sees the incremented count and denies (race guard)', async () => {
    // Cap = 1: the FIRST reserve consumes the only slot; a concurrent SECOND
    // caller (simulated sequentially against the same store) must observe the
    // reservation and be denied — exactly the CORR-2 race the advisory lock
    // guards in production.
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerDayGlobal: 1 }));
    const a = await store.reserve(sendArgs({ idempotencyKey: 'race-a' }));
    const b = await store.reserve(sendArgs({ idempotencyKey: 'race-b' }));
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
  });

  it('denies at the per-sender cap', async () => {
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerSenderPerDay: 1 }));
    await store.reserve(sendArgs({ idempotencyKey: 's1' }));
    const r = await store.reserve(sendArgs({ idempotencyKey: 's2' }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('per-sender daily auto-send cap reached');
  });

  it('denies at the per-domain cap', async () => {
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerDomainPerDay: 1 }));
    await store.reserve(sendArgs({ idempotencyKey: 'd1', recipientEmail: 'a@acme.com' }));
    const r = await store.reserve(sendArgs({ idempotencyKey: 'd2', recipientEmail: 'b@acme.com' }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('per-domain daily auto-send cap reached');
  });

  it('email.reply reservations count toward the send caps (confirmations)', async () => {
    // A booking-confirmation reply (email.reply) must consume a send slot.
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerDayGlobal: 1 }));
    const reply = await store.reserve(sendArgs({ action: 'email.reply', idempotencyKey: 'r1' }));
    expect(reply.allowed).toBe(true);
    // The next send is now over the global cap because the reply consumed it.
    const send = await store.reserve(sendArgs({ action: 'email.send', idempotencyKey: 'r2' }));
    expect(send.allowed).toBe(false);
    expect(send.reason).toContain('global daily auto-send cap reached');
  });

  it('deduplicates by idempotencyKey (retry does not over-count)', async () => {
    // Two reservations with the SAME idempotencyKey collapse to one for cap
    // accounting, so a Temporal at-least-once retry cannot over-count. With
    // cap=2, a duplicate 'dup' row must NOT consume a second slot: a subsequent
    // send with a NEW key must still be allowed.
    const store = new FakeReservationStore(readySettings({ maxAutoSendsPerDayGlobal: 2 }));
    await store.reserve(sendArgs({ idempotencyKey: 'dup' }));
    await store.reserve(sendArgs({ idempotencyKey: 'dup' })); // retry, same key
    // Distinct-key count is still 1 (both rows share 'dup'), so a new key fits.
    const fresh = await store.reserve(sendArgs({ idempotencyKey: 'fresh' }));
    expect(fresh.allowed).toBe(true);
  });

  it('calendar: allows within cap and denies at cap', async () => {
    const store = new FakeReservationStore(readySettings({ maxCalendarEventsPerDay: 1 }));
    const first = await store.reserve(calArgs({ idempotencyKey: 'c1' }));
    expect(first.allowed).toBe(true);
    const second = await store.reserve(calArgs({ idempotencyKey: 'c2' }));
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('daily calendar event cap reached');
  });
});
