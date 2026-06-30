import { describe, expect, it } from 'vitest';
import { createLogger, isAppError, ProviderError } from '@app/shared';
import { createCalendarProvider, type CalendarConfigInput } from './factory.js';
import { MockCalendarProvider } from './mock.js';
import { GoogleCalendarProvider } from './google.js';
import type { AvailabilityInput, CreateEventInput } from './types.js';

const logger = createLogger('calendar-test', { level: 'silent' });

function mockConfig(overrides: Partial<CalendarConfigInput> = {}): CalendarConfigInput {
  return {
    calendarProvider: 'mock',
    googleCalendarId: 'primary',
    ...overrides,
  };
}

// A single weekday range in UTC so business hours map 1:1 onto wall time.
const RANGE: Pick<AvailabilityInput, 'rangeStartIso' | 'rangeEndIso' | 'timezone'> = {
  rangeStartIso: '2026-07-01T00:00:00.000Z',
  rangeEndIso: '2026-07-01T23:59:59.000Z',
  timezone: 'UTC',
};

describe('createCalendarProvider', () => {
  it('defaults to the mock adapter', () => {
    const provider = createCalendarProvider(mockConfig(), logger);
    expect(provider).toBeInstanceOf(MockCalendarProvider);
    expect(provider.name).toBe('mock');
  });

  it('selects the google adapter when configured', () => {
    const provider = createCalendarProvider(mockConfig({ calendarProvider: 'google' }), logger);
    expect(provider).toBeInstanceOf(GoogleCalendarProvider);
    expect(provider.name).toBe('google');
  });
});

describe('MockCalendarProvider.getAvailability', () => {
  it('returns free slots that exclude the seeded busy blocks', async () => {
    const provider = createCalendarProvider(mockConfig(), logger);
    const result = await provider.getAvailability({
      calendarId: 'primary',
      durationMinutes: 30,
      ...RANGE,
    });

    // Seed busy blocks are 10:00-11:00 and 14:00-15:00 UTC.
    expect(result.busy).toEqual([
      { startIso: '2026-07-01T10:00:00.000Z', endIso: '2026-07-01T11:00:00.000Z' },
      { startIso: '2026-07-01T14:00:00.000Z', endIso: '2026-07-01T15:00:00.000Z' },
    ]);

    // No free slot may overlap a busy block.
    for (const slot of result.freeSlots) {
      const s = new Date(slot.startIso).getTime();
      const e = new Date(slot.endIso).getTime();
      for (const busy of result.busy) {
        const bs = new Date(busy.startIso).getTime();
        const be = new Date(busy.endIso).getTime();
        expect(s < be && bs < e).toBe(false);
      }
    }

    // First slot is at business-hours open (09:00), 30 minutes long.
    expect(result.freeSlots[0]).toEqual({
      startIso: '2026-07-01T09:00:00.000Z',
      endIso: '2026-07-01T09:30:00.000Z',
    });

    // The 10:00 slot is blocked; 09:30 is the last pre-block slot.
    const starts = result.freeSlots.map((s) => s.startIso);
    expect(starts).toContain('2026-07-01T09:30:00.000Z');
    expect(starts).not.toContain('2026-07-01T10:00:00.000Z');
    expect(starts).not.toContain('2026-07-01T10:30:00.000Z');
  });

  it('respects durationMinutes when sizing slots', async () => {
    const provider = createCalendarProvider(mockConfig(), logger);
    const result = await provider.getAvailability({
      calendarId: 'primary',
      durationMinutes: 60,
      ...RANGE,
    });

    for (const slot of result.freeSlots) {
      const lengthMin = (new Date(slot.endIso).getTime() - new Date(slot.startIso).getTime()) / 60000;
      expect(lengthMin).toBe(60);
    }
    // A 60-min slot at 09:30 would run into the 10:00 block, so it must be absent.
    const starts = result.freeSlots.map((s) => s.startIso);
    expect(starts).toContain('2026-07-01T09:00:00.000Z');
    expect(starts).not.toContain('2026-07-01T09:30:00.000Z');
  });

  it('is deterministic across instances', async () => {
    const a = createCalendarProvider(mockConfig(), logger);
    const b = createCalendarProvider(mockConfig(), logger);
    const input: AvailabilityInput = { calendarId: 'primary', durationMinutes: 30, ...RANGE };
    expect(await a.getAvailability(input)).toEqual(await b.getAvailability(input));
  });
});

describe('MockCalendarProvider.createEvent', () => {
  const baseInput: CreateEventInput = {
    calendarId: 'primary',
    title: 'Intro call',
    startIso: '2026-07-01T12:00:00.000Z',
    endIso: '2026-07-01T12:30:00.000Z',
    timezone: 'UTC',
    attendees: ['a@example.com'],
    idempotencyKey: 'key-123',
  };

  it('is idempotent on idempotencyKey (same key → identical event)', async () => {
    const provider = new MockCalendarProvider({}, logger);
    const first = await provider.createEvent(baseInput);
    const second = await provider.createEvent(baseInput);

    expect(second).toEqual(first);
    expect(second.providerEventId).toBe(first.providerEventId);

    // Repeat with the same key — even with different field values — must not
    // create a new event and must return the original.
    const third = await provider.createEvent({ ...baseInput, title: 'Changed title' });
    expect(third).toEqual(first);
  });

  it('produces a deterministic providerEventId derived from the key', async () => {
    const a = new MockCalendarProvider({}, logger);
    const b = new MockCalendarProvider({}, logger);
    const evA = await a.createEvent(baseInput);
    const evB = await b.createEvent(baseInput);
    expect(evA.providerEventId).toBe(evB.providerEventId);
  });

  it('keeps store size unchanged on repeated create (no new busy block)', async () => {
    const provider = new MockCalendarProvider({}, logger);
    await provider.createEvent(baseInput);
    const after1 = await provider.getAvailability({ calendarId: 'primary', durationMinutes: 30, ...RANGE });
    await provider.createEvent(baseInput);
    await provider.createEvent(baseInput);
    const after3 = await provider.getAvailability({ calendarId: 'primary', durationMinutes: 30, ...RANGE });
    expect(after3.busy).toEqual(after1.busy);
  });

  it('a created event becomes busy and blocks overlapping slots', async () => {
    const provider = new MockCalendarProvider({}, logger);
    await provider.createEvent(baseInput); // 12:00-12:30
    const result = await provider.getAvailability({ calendarId: 'primary', durationMinutes: 30, ...RANGE });
    const starts = result.freeSlots.map((s) => s.startIso);
    expect(starts).not.toContain('2026-07-01T12:00:00.000Z');
    expect(result.busy).toContainEqual({
      startIso: '2026-07-01T12:00:00.000Z',
      endIso: '2026-07-01T12:30:00.000Z',
    });
  });
});

describe('MockCalendarProvider.updateEvent / cancelEvent', () => {
  it('updateEvent patches fields', async () => {
    const provider = new MockCalendarProvider({}, logger);
    const created = await provider.createEvent({
      calendarId: 'primary',
      title: 'Old',
      startIso: '2026-07-01T12:00:00.000Z',
      endIso: '2026-07-01T12:30:00.000Z',
      timezone: 'UTC',
      attendees: [],
      idempotencyKey: 'upd-1',
    });
    const updated = await provider.updateEvent({
      calendarId: 'primary',
      providerEventId: created.providerEventId,
      title: 'New',
      attendees: ['x@example.com'],
    });
    expect(updated.title).toBe('New');
    expect(updated.attendees).toEqual(['x@example.com']);
    expect(updated.providerEventId).toBe(created.providerEventId);
  });

  it('cancelEvent marks the event cancelled and frees its slot', async () => {
    const provider = new MockCalendarProvider({}, logger);
    const created = await provider.createEvent({
      calendarId: 'primary',
      title: 'Call',
      startIso: '2026-07-01T12:00:00.000Z',
      endIso: '2026-07-01T12:30:00.000Z',
      timezone: 'UTC',
      attendees: [],
      idempotencyKey: 'cancel-1',
    });
    const cancelled = await provider.cancelEvent({
      calendarId: 'primary',
      providerEventId: created.providerEventId,
    });
    expect(cancelled.status).toBe('cancelled');

    // The slot is free again.
    const result = await provider.getAvailability({ calendarId: 'primary', durationMinutes: 30, ...RANGE });
    expect(result.freeSlots.map((s) => s.startIso)).toContain('2026-07-01T12:00:00.000Z');
  });

  it('cancelEvent on a missing event throws NotFoundError', () => {
    const provider = new MockCalendarProvider({}, logger);
    expect(() => provider.cancelEvent({ calendarId: 'primary', providerEventId: 'nope' })).toThrowError(
      /not found/,
    );
  });
});

describe('MockCalendarProvider.parseWebhookNotification', () => {
  it('parses a simple notification shape', () => {
    const provider = new MockCalendarProvider({}, logger);
    const note = provider.parseWebhookNotification({
      channelId: 'chan_1',
      resourceId: 'res_1',
      resourceState: 'exists',
      calendarId: 'primary',
    });
    expect(note).toEqual({
      channelId: 'chan_1',
      resourceId: 'res_1',
      resourceState: 'exists',
      calendarId: 'primary',
    });
  });

  it('throws ValidationError on a malformed payload', () => {
    const provider = new MockCalendarProvider({}, logger);
    expect(() => provider.parseWebhookNotification({ channelId: 'only' })).toThrowError(
      /missing channelId/,
    );
    expect(() => provider.parseWebhookNotification(null)).toThrowError(/must be an object/);
  });
});

describe('GoogleCalendarProvider stub', () => {
  const provider = new GoogleCalendarProvider(
    { provider: 'google', googleCalendarId: 'primary' },
    logger,
  );

  it('throws ProviderError from getAvailability', () => {
    let thrown: unknown;
    try {
      void provider.getAvailability({ calendarId: 'primary', durationMinutes: 30, ...RANGE });
    } catch (err) {
      thrown = err;
    }
    expect(isAppError(thrown) && thrown instanceof ProviderError).toBe(true);
  });

  it('throws ProviderError from createEvent', () => {
    expect(() =>
      provider.createEvent({
        calendarId: 'primary',
        title: 't',
        startIso: RANGE.rangeStartIso,
        endIso: RANGE.rangeEndIso,
        timezone: 'UTC',
        attendees: [],
        idempotencyKey: 'k',
      }),
    ).toThrowError(ProviderError);
  });

  it('throws ProviderError from cancelEvent and parseWebhookNotification', () => {
    expect(() => provider.cancelEvent({ calendarId: 'primary', providerEventId: 'x' })).toThrowError(
      ProviderError,
    );
    expect(() => provider.parseWebhookNotification({})).toThrowError(ProviderError);
  });
});
