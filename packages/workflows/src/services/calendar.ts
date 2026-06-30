/**
 * Calendar service — the guarded path from a confirmed scheduling intent to a
 * real provider event. A `CalendarEvent` row is created in `PROPOSED` status by
 * the inbound flow; the actual provider event is created ONLY when every guard
 * holds (recipient confirmed a specific slot, timezone known, availability
 * checked, payload validates, idempotency key present). Idempotent on the key.
 */

import {
  ActorType,
  CalendarEventStatus,
  ValidationError,
  type TimeSlot,
} from '@app/shared';
import type { Deps } from '../deps.js';
import { toJson, writeAudit } from './shared.js';
import { isValidIanaTimezone } from './tz.js';

/** A confirmed slot the recipient explicitly selected. */
export interface ConfirmedSlot {
  startIso: string;
  endIso: string;
}

export interface ConfirmAndCreateInput {
  /** The PROPOSED CalendarEvent row id to confirm. */
  calendarEventId: string;
  prospectId?: string;
  threadId?: string;
  /** Recipient has confirmed a specific slot. */
  recipientConfirmed: boolean;
  selectedSlot: ConfirmedSlot | null;
  /** Resolved IANA timezone (must be non-null/known). */
  timezone: string | null;
  /** Whether availability was checked and the slot was free. */
  availabilityChecked: boolean;
  /** Stable idempotency key for the create-event side effect. */
  idempotencyKey: string;
  title: string;
  description?: string;
  attendees: { email: string; name?: string }[];
}

export interface ConfirmAndCreateResult {
  created: boolean;
  calendarEventId: string;
  providerEventId?: string;
  reason?: string;
}

/**
 * Confirm a PROPOSED calendar event and create the provider event, but only
 * when all guards hold. Returns `created: false` with a reason when a guard
 * blocks (the event row stays PROPOSED). Idempotent: a re-run with the same key
 * returns the existing provider event.
 */
export async function confirmAndCreateCalendarEvent(
  deps: Deps,
  input: ConfirmAndCreateInput,
): Promise<ConfirmAndCreateResult> {
  const guardFailure = checkGuards(input);
  if (guardFailure) {
    await writeAudit(deps, {
      action: 'calendar.create_blocked',
      entityType: 'calendar_event',
      entityId: input.calendarEventId,
      decision: 'blocked',
      allowed: false,
      reason: guardFailure,
      idempotencyKey: input.idempotencyKey,
    });
    return { created: false, calendarEventId: input.calendarEventId, reason: guardFailure };
  }

  // Guards guarantee these are present.
  const slot = input.selectedSlot as ConfirmedSlot;
  const timezone = input.timezone as string;

  const providerEvent = await deps.calendar.createEvent({
    calendarId: deps.config.googleCalendarId,
    title: input.title,
    description: input.description,
    startIso: slot.startIso,
    endIso: slot.endIso,
    timezone,
    attendees: input.attendees.map((a) => a.email),
    idempotencyKey: input.idempotencyKey,
  });

  await deps.prisma.calendarEvent.update({
    where: { id: input.calendarEventId },
    data: {
      status: CalendarEventStatus.CONFIRMED,
      providerEventId: providerEvent.providerEventId,
      meetingUrl: null,
      startTime: new Date(slot.startIso),
      endTime: new Date(slot.endIso),
      timezone,
    },
  });

  await writeAudit(deps, {
    action: 'calendar.create',
    actorType: ActorType.SYSTEM,
    entityType: 'calendar_event',
    entityId: input.calendarEventId,
    decision: 'created',
    allowed: true,
    reason: 'all scheduling guards satisfied',
    idempotencyKey: input.idempotencyKey,
    metadata: { providerEventId: providerEvent.providerEventId },
  });

  return {
    created: true,
    calendarEventId: input.calendarEventId,
    providerEventId: providerEvent.providerEventId,
  };
}

/** Return a human-readable reason if any guard fails, else null. */
function checkGuards(input: ConfirmAndCreateInput): string | null {
  if (!input.recipientConfirmed) return 'recipient has not confirmed a slot';
  if (!input.selectedSlot) return 'no selected slot';
  if (!input.timezone) return 'timezone unknown';
  // A non-IANA / invalid timezone must never reach the provider (which builds an
  // Intl.DateTimeFormat and throws RangeError). Treat it as a blocked guard.
  if (!isValidIanaTimezone(input.timezone)) return 'invalid IANA timezone';
  if (!input.availabilityChecked) return 'availability not checked';
  if (!input.idempotencyKey) return 'missing idempotency key';
  const { startIso, endIso } = input.selectedSlot;
  if (!isIso(startIso) || !isIso(endIso)) return 'invalid slot timestamps';
  if (new Date(startIso).getTime() >= new Date(endIso).getTime()) {
    return 'slot start must precede end';
  }
  return null;
}

function isIso(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t);
}

/**
 * Persist a PROPOSED `CalendarEvent` row (no provider call). Returns the row id
 * and the idempotency key. Idempotent on the key.
 */
export interface ProposeEventInput {
  prospectId?: string;
  threadId?: string;
  title: string;
  description?: string;
  timezone: string;
  proposedSlots: TimeSlot[];
  attendees: { email: string; name?: string }[];
  idempotencyKey: string;
}

export async function proposeCalendarEvent(
  deps: Deps,
  input: ProposeEventInput,
): Promise<{ calendarEventId: string }> {
  if (!input.idempotencyKey) {
    throw new ValidationError('proposeCalendarEvent requires an idempotency key');
  }
  const first = input.proposedSlots[0];
  const row = await deps.prisma.calendarEvent.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: {
      idempotencyKey: input.idempotencyKey,
      prospectId: input.prospectId ?? null,
      threadId: input.threadId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: CalendarEventStatus.PROPOSED,
      startTime: first ? new Date(first.startIso) : null,
      endTime: first ? new Date(first.endIso) : null,
      timezone: input.timezone,
      attendees: toJson(input.attendees) as object,
    },
    update: {},
    select: { id: true },
  });
  return { calendarEventId: row.id };
}
