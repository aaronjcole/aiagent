/**
 * In-memory, fully deterministic calendar provider used by default and in tests.
 *
 * Determinism: this adapter performs NO `Date.now()` / `Math.random()` reads.
 * Event ids are derived from the caller-supplied `idempotencyKey`; seed busy
 * blocks are anchored to a configured base date (or, absent one, to the start
 * of each query's range). Given the same inputs it always produces the same
 * outputs.
 */

import { idempotencyKey, NotFoundError, ValidationError, type Logger } from '@app/shared';
import type {
  AvailabilityInput,
  AvailabilityResult,
  CalendarEventDTO,
  CalendarProvider,
  CalendarProviderConfig,
  CancelEventInput,
  CreateEventInput,
  TimeSlotDTO,
  UpdateEventInput,
  WatchCalendarInput,
  WatchChannelDTO,
  WebhookNotification,
} from './types.js';

/** Business-hours window (local to the query timezone), 24h clock. */
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;
/** Slot grid: candidate starts align to :00 and :30. */
const SLOT_STEP_MINUTES = 30;
const MS_PER_MINUTE = 60_000;

/**
 * Timezone handling (kept intentionally simple and documented):
 * we treat the query timezone as a FIXED UTC offset for the whole range,
 * computed once from the range start. This ignores a DST transition that lands
 * inside the range, which is acceptable for the mock's slot-generation purpose.
 */
function tzOffsetMinutes(timezone: string, atIso: string): number {
  const date = new Date(atIso);
  // Format the instant in both UTC and the target zone, then diff the wall times.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  let hour = get('hour');
  // Intl can emit hour "24" at midnight in some environments; normalize.
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return Math.round((asUtc - date.getTime()) / MS_PER_MINUTE);
}

/** UTC ms at midnight (local) of the calendar day containing `instantMs`. */
function localMidnightUtcMs(instantMs: number, offsetMin: number): number {
  const localMs = instantMs + offsetMin * MS_PER_MINUTE;
  const dayMs = 24 * 60 * MS_PER_MINUTE;
  const localMidnight = Math.floor(localMs / dayMs) * dayMs;
  return localMidnight - offsetMin * MS_PER_MINUTE;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

interface StoredEvent {
  providerEventId: string;
  calendarId: string;
  title: string;
  description?: string;
  startMs: number;
  endMs: number;
  timezone: string;
  attendees: string[];
  status: CalendarEventDTO['status'];
  idempotencyKey: string;
}

/**
 * In-memory {@link CalendarProvider} for tests and the demo: computes free/busy
 * over deterministic seeded blocks plus stored events, and supports idempotent
 * event creation. Deterministic via an optional configured base date.
 */
export class MockCalendarProvider implements CalendarProvider {
  readonly name = 'mock' as const;

  private readonly logger: Logger;
  private readonly baseDateIso?: string;
  /** providerEventId -> event. */
  private readonly events = new Map<string, StoredEvent>();
  /** idempotencyKey -> providerEventId, for create de-dup. */
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(config: Pick<CalendarProviderConfig, 'mockBaseDateIso'>, logger: Logger) {
    this.logger = logger;
    this.baseDateIso = config.mockBaseDateIso;
  }

  /**
   * Deterministic seed busy blocks for a given calendar/day. Anchored to the
   * configured base date when present, otherwise to `anchorMs` (the query range
   * start). Two blocks per anchored day: 10:00-11:00 and 14:00-15:00 local.
   */
  private seedBusyForDay(timezone: string, dayMidnightUtcMs: number): TimeSlotDTO[] {
    const blocks: Array<[number, number]> = [
      [10 * 60, 11 * 60],
      [14 * 60, 15 * 60],
    ];
    return blocks.map(([startMin, endMin]) => ({
      startIso: new Date(dayMidnightUtcMs + startMin * MS_PER_MINUTE).toISOString(),
      endIso: new Date(dayMidnightUtcMs + endMin * MS_PER_MINUTE).toISOString(),
    }));
  }

  private busyIntervalsForRange(input: AvailabilityInput): TimeSlotDTO[] {
    const offsetMin = tzOffsetMinutes(input.timezone, input.rangeStartIso);
    const rangeStartMs = new Date(input.rangeStartIso).getTime();
    const rangeEndMs = new Date(input.rangeEndIso).getTime();

    // Anchor seed blocks to the configured base date, else to the range start.
    const anchorIso = this.baseDateIso ?? input.rangeStartIso;
    const anchorMs = new Date(anchorIso).getTime();

    const dayMs = 24 * 60 * MS_PER_MINUTE;
    const firstMidnight = localMidnightUtcMs(Math.min(anchorMs, rangeStartMs), offsetMin);

    const seeded: TimeSlotDTO[] = [];
    for (let dayMidnight = firstMidnight; dayMidnight < rangeEndMs; dayMidnight += dayMs) {
      for (const block of this.seedBusyForDay(input.timezone, dayMidnight)) {
        seeded.push(block);
      }
    }

    // Stored events on this calendar also count as busy.
    const stored: TimeSlotDTO[] = [];
    for (const ev of this.events.values()) {
      if (ev.calendarId !== input.calendarId) continue;
      if (ev.status === 'cancelled' || ev.status === 'failed') continue;
      stored.push({ startIso: new Date(ev.startMs).toISOString(), endIso: new Date(ev.endMs).toISOString() });
    }

    // Keep only intervals that overlap the requested range.
    return [...seeded, ...stored].filter((b) =>
      overlaps(new Date(b.startIso).getTime(), new Date(b.endIso).getTime(), rangeStartMs, rangeEndMs),
    );
  }

  getAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
    this.logger.info(
      { provider: 'mock', op: 'getAvailability', calendarId: input.calendarId, durationMinutes: input.durationMinutes },
      'MOCK calendar getAvailability',
    );

    const offsetMin = tzOffsetMinutes(input.timezone, input.rangeStartIso);
    const rangeStartMs = new Date(input.rangeStartIso).getTime();
    const rangeEndMs = new Date(input.rangeEndIso).getTime();
    const durationMs = input.durationMinutes * MS_PER_MINUTE;
    const stepMs = SLOT_STEP_MINUTES * MS_PER_MINUTE;
    const dayMs = 24 * 60 * MS_PER_MINUTE;

    const busy = this.busyIntervalsForRange(input);
    const busyMs = busy.map((b) => [new Date(b.startIso).getTime(), new Date(b.endIso).getTime()] as const);

    const freeSlots: TimeSlotDTO[] = [];

    // Walk each local day that intersects the range; within business hours,
    // step the slot grid and keep slots that fit and don't overlap busy blocks.
    const firstMidnight = localMidnightUtcMs(rangeStartMs, offsetMin);
    for (let dayMidnight = firstMidnight; dayMidnight < rangeEndMs; dayMidnight += dayMs) {
      const bhStart = dayMidnight + BUSINESS_START_HOUR * 60 * MS_PER_MINUTE;
      const bhEnd = dayMidnight + BUSINESS_END_HOUR * 60 * MS_PER_MINUTE;
      for (let slotStart = bhStart; slotStart + durationMs <= bhEnd; slotStart += stepMs) {
        const slotEnd = slotStart + durationMs;
        if (slotStart < rangeStartMs || slotEnd > rangeEndMs) continue;
        const clash = busyMs.some(([bs, be]) => overlaps(slotStart, slotEnd, bs, be));
        if (clash) continue;
        freeSlots.push({
          startIso: new Date(slotStart).toISOString(),
          endIso: new Date(slotEnd).toISOString(),
        });
      }
    }

    return Promise.resolve({ busy, freeSlots });
  }

  createEvent(input: CreateEventInput): Promise<CalendarEventDTO> {
    this.logger.info(
      { provider: 'mock', op: 'createEvent', calendarId: input.calendarId, idempotencyKey: input.idempotencyKey },
      'MOCK calendar createEvent',
    );

    // Idempotent: same key returns the original event, no duplicate.
    const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.events.get(existingId);
      if (existing) return Promise.resolve(toDTO(existing));
    }

    // Deterministic id derived from the idempotency key (no random/clock).
    const providerEventId = `evt_${idempotencyKey([input.calendarId, input.idempotencyKey])}`;
    const event: StoredEvent = {
      providerEventId,
      calendarId: input.calendarId,
      title: input.title,
      description: input.description,
      startMs: new Date(input.startIso).getTime(),
      endMs: new Date(input.endIso).getTime(),
      timezone: input.timezone,
      attendees: [...input.attendees],
      status: 'confirmed',
      idempotencyKey: input.idempotencyKey,
    };
    this.events.set(providerEventId, event);
    this.byIdempotencyKey.set(input.idempotencyKey, providerEventId);
    return Promise.resolve(toDTO(event));
  }

  updateEvent(input: UpdateEventInput): Promise<CalendarEventDTO> {
    this.logger.info(
      { provider: 'mock', op: 'updateEvent', calendarId: input.calendarId, providerEventId: input.providerEventId },
      'MOCK calendar updateEvent',
    );

    const event = this.events.get(input.providerEventId);
    if (!event || event.calendarId !== input.calendarId) {
      throw new NotFoundError('calendar event not found', { providerEventId: input.providerEventId });
    }
    if (input.title !== undefined) event.title = input.title;
    if (input.description !== undefined) event.description = input.description;
    if (input.startIso !== undefined) event.startMs = new Date(input.startIso).getTime();
    if (input.endIso !== undefined) event.endMs = new Date(input.endIso).getTime();
    if (input.timezone !== undefined) event.timezone = input.timezone;
    if (input.attendees !== undefined) event.attendees = [...input.attendees];
    return Promise.resolve(toDTO(event));
  }

  cancelEvent(input: CancelEventInput): Promise<CalendarEventDTO> {
    this.logger.info(
      { provider: 'mock', op: 'cancelEvent', calendarId: input.calendarId, providerEventId: input.providerEventId },
      'MOCK calendar cancelEvent',
    );

    const event = this.events.get(input.providerEventId);
    if (!event || event.calendarId !== input.calendarId) {
      throw new NotFoundError('calendar event not found', { providerEventId: input.providerEventId });
    }
    event.status = 'cancelled';
    return Promise.resolve(toDTO(event));
  }

  watchCalendar(input: WatchCalendarInput): Promise<WatchChannelDTO> {
    this.logger.info(
      { provider: 'mock', op: 'watchCalendar', calendarId: input.calendarId },
      'MOCK calendar watchCalendar',
    );

    // Deterministic channel/resource ids derived from inputs (no random/clock).
    const channelId = `chan_${idempotencyKey([input.calendarId, input.callbackUrl])}`;
    const resourceId = `res_${idempotencyKey([input.calendarId])}`;
    // Fixed, deterministic far-future expiry for the mock.
    return Promise.resolve({
      channelId,
      resourceId,
      expirationIso: '2099-12-31T23:59:59.000Z',
    });
  }

  parseWebhookNotification(payload: unknown): WebhookNotification {
    this.logger.info({ provider: 'mock', op: 'parseWebhookNotification' }, 'MOCK calendar parseWebhookNotification');

    if (typeof payload !== 'object' || payload === null) {
      throw new ValidationError('webhook payload must be an object');
    }
    const body = payload as Record<string, unknown>;
    const channelId = readString(body, ['channelId', 'channel_id', 'X-Goog-Channel-ID']);
    const resourceId = readString(body, ['resourceId', 'resource_id', 'X-Goog-Resource-ID']);
    const resourceState = readString(body, ['resourceState', 'resource_state', 'X-Goog-Resource-State']);
    if (channelId === undefined || resourceId === undefined || resourceState === undefined) {
      throw new ValidationError('webhook payload missing channelId/resourceId/resourceState');
    }
    const calendarId = readString(body, ['calendarId', 'calendar_id']);
    const result: WebhookNotification = { channelId, resourceId, resourceState };
    if (calendarId !== undefined) result.calendarId = calendarId;
    return result;
  }
}

function toDTO(event: StoredEvent): CalendarEventDTO {
  return {
    providerEventId: event.providerEventId,
    title: event.title,
    startIso: new Date(event.startMs).toISOString(),
    endIso: new Date(event.endMs).toISOString(),
    timezone: event.timezone,
    attendees: [...event.attendees],
    status: event.status,
  };
}

function readString(body: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
