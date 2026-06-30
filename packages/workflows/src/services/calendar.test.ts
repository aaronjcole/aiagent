import { describe, it, expect } from 'vitest';
import { idempotencyKey } from '@app/shared';
import { confirmAndCreateCalendarEvent, proposeCalendarEvent } from './calendar.js';
import { FakePrisma, makeDeps } from './test-helpers.js';

const SLOT = { startIso: '2026-07-02T13:00:00.000Z', endIso: '2026-07-02T13:30:00.000Z' };

describe('confirmAndCreateCalendarEvent', () => {
  it('blocks when guards fail (no confirmation) and keeps the event PROPOSED', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);
    const { calendarEventId } = await proposeCalendarEvent(deps, {
      prospectId: 'p1',
      title: 'Intro',
      timezone: 'America/New_York',
      proposedSlots: [SLOT],
      attendees: [{ email: 'jane@acme.test' }],
      idempotencyKey: idempotencyKey(['thr_1', 'propose']),
    });

    const result = await confirmAndCreateCalendarEvent(deps, {
      calendarEventId,
      recipientConfirmed: false,
      selectedSlot: SLOT,
      timezone: 'America/New_York',
      availabilityChecked: true,
      idempotencyKey: idempotencyKey(['thr_1', 'confirm']),
      title: 'Intro',
      attendees: [{ email: 'jane@acme.test' }],
    });

    expect(result.created).toBe(false);
    expect(result.reason).toContain('not confirmed');
    expect(prisma.calendarEvent.rows[0]!.status).toBe('proposed');
    expect(prisma.auditLog.rows.some((a) => a.action === 'calendar.create_blocked')).toBe(true);
  });

  it('creates the provider event once all guards hold; idempotent on the key', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);
    const { calendarEventId } = await proposeCalendarEvent(deps, {
      prospectId: 'p1',
      title: 'Intro',
      timezone: 'America/New_York',
      proposedSlots: [SLOT],
      attendees: [{ email: 'jane@acme.test' }],
      idempotencyKey: idempotencyKey(['thr_1', 'propose']),
    });

    const confirmKey = idempotencyKey(['thr_1', 'confirm']);
    const input = {
      calendarEventId,
      recipientConfirmed: true,
      selectedSlot: SLOT,
      timezone: 'America/New_York',
      availabilityChecked: true,
      idempotencyKey: confirmKey,
      title: 'Intro',
      attendees: [{ email: 'jane@acme.test' }],
    };

    const r1 = await confirmAndCreateCalendarEvent(deps, input);
    expect(r1.created).toBe(true);
    expect(r1.providerEventId).toBeTruthy();
    expect(prisma.calendarEvent.rows[0]!.status).toBe('confirmed');

    // Same key → same provider event (no duplicate provider event).
    const r2 = await confirmAndCreateCalendarEvent(deps, input);
    expect(r2.providerEventId).toBe(r1.providerEventId);
  });
});

describe('proposeCalendarEvent', () => {
  it('is idempotent on the key (same key → one row)', async () => {
    const prisma = new FakePrisma();
    const deps = makeDeps(prisma);
    const key = idempotencyKey(['thr_9', 'propose']);
    const a = await proposeCalendarEvent(deps, {
      prospectId: 'p1',
      title: 'Intro',
      timezone: 'UTC',
      proposedSlots: [SLOT],
      attendees: [{ email: 'jane@acme.test' }],
      idempotencyKey: key,
    });
    const b = await proposeCalendarEvent(deps, {
      prospectId: 'p1',
      title: 'Intro',
      timezone: 'UTC',
      proposedSlots: [SLOT],
      attendees: [{ email: 'jane@acme.test' }],
      idempotencyKey: key,
    });
    expect(a.calendarEventId).toBe(b.calendarEventId);
    expect(prisma.calendarEvent.rows).toHaveLength(1);
  });
});
