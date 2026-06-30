/**
 * Calendar provider DTOs and the `CalendarProvider` contract.
 *
 * All timestamps are ISO-8601 strings with an explicit offset (e.g.
 * `2026-06-30T15:00:00.000Z`). Free/busy and event windows are half-open
 * intervals `[startIso, endIso)`.
 */

import type { Config } from '@app/shared';

/** A half-open time window `[startIso, endIso)`. Mirrors `TimeSlot` from `@app/shared`. */
export interface TimeSlotDTO {
  startIso: string;
  endIso: string;
}

/** Input for an availability (free/busy + free-slot) query. */
export interface AvailabilityInput {
  /** Provider calendar id (e.g. Google `primary`). */
  calendarId: string;
  /** Inclusive start of the search range, ISO-8601. */
  rangeStartIso: string;
  /** Exclusive end of the search range, ISO-8601. */
  rangeEndIso: string;
  /** Desired meeting length, in minutes. Free slots are exactly this long. */
  durationMinutes: number;
  /** IANA timezone (e.g. `America/New_York`) used to anchor business hours. */
  timezone: string;
}

/** Result of an availability query. */
export interface AvailabilityResult {
  /** Busy intervals that overlap the requested range. */
  busy: TimeSlotDTO[];
  /** Candidate open slots of `durationMinutes` that don't overlap any busy block. */
  freeSlots: TimeSlotDTO[];
}

/** Input for creating a calendar event. */
export interface CreateEventInput {
  calendarId: string;
  title: string;
  description?: string;
  startIso: string;
  endIso: string;
  timezone: string;
  /** Attendee email addresses. */
  attendees: string[];
  /**
   * Stable idempotency key. Re-issuing `createEvent` with the same key returns
   * the original event (no duplicate is created).
   */
  idempotencyKey: string;
}

/** Input for updating an existing event. */
export interface UpdateEventInput {
  calendarId: string;
  providerEventId: string;
  title?: string;
  description?: string;
  startIso?: string;
  endIso?: string;
  timezone?: string;
  attendees?: string[];
}

/** Input for cancelling an existing event. */
export interface CancelEventInput {
  calendarId: string;
  providerEventId: string;
}

/** Input for establishing a push-notification watch channel on a calendar. */
export interface WatchCalendarInput {
  calendarId: string;
  /** URL the provider should POST change notifications to. */
  callbackUrl: string;
}

/** Result of establishing a watch channel. */
export interface WatchChannelDTO {
  channelId: string;
  resourceId: string;
  /** Channel expiry, ISO-8601. */
  expirationIso: string;
}

/** Lifecycle status of a calendar event. Values track `CalendarEventStatus`. */
export type CalendarEventDTOStatus =
  | 'proposed'
  | 'tentative'
  | 'confirmed'
  | 'cancelled'
  | 'failed';

/** A calendar event as returned by a provider. */
export interface CalendarEventDTO {
  providerEventId: string;
  title: string;
  startIso: string;
  endIso: string;
  timezone: string;
  attendees: string[];
  status: CalendarEventDTOStatus;
}

/** A normalized webhook/push change notification. */
export interface WebhookNotification {
  /** Watch channel id the notification belongs to. */
  channelId: string;
  /** Provider resource id that changed. */
  resourceId: string;
  /** Provider-reported state (e.g. `sync`, `exists`, `not_exists`). */
  resourceState: string;
  /** Affected calendar id, if derivable from the payload. */
  calendarId?: string;
}

/**
 * Configuration for a calendar provider. Derived from {@link Config} plus
 * optional mock-only knobs.
 */
export interface CalendarProviderConfig {
  provider: Config['calendarProvider'];
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  googleRedirectUri?: string;
  /** Default calendar id (Google `primary` by default). */
  googleCalendarId: string;
  /**
   * Mock-only: base date (ISO-8601) the deterministic seed busy blocks are
   * anchored to. When omitted, busy blocks are derived from each query's range
   * start so behaviour stays deterministic without any wall-clock reads.
   */
  mockBaseDateIso?: string;
}

/**
 * The contract the rest of the system codes against. Implemented by the mock
 * (default) and a Google stub.
 */
export interface CalendarProvider {
  readonly name: 'mock' | 'google';

  /** Compute busy intervals and candidate free slots within a range. */
  getAvailability(input: AvailabilityInput): Promise<AvailabilityResult>;

  /** Create an event. Idempotent on `input.idempotencyKey`. */
  createEvent(input: CreateEventInput): Promise<CalendarEventDTO>;

  /** Patch an existing event's fields. */
  updateEvent(input: UpdateEventInput): Promise<CalendarEventDTO>;

  /** Cancel (mark cancelled) an existing event. */
  cancelEvent(input: CancelEventInput): Promise<CalendarEventDTO>;

  /** Establish a push-notification watch channel on a calendar. */
  watchCalendar(input: WatchCalendarInput): Promise<WatchChannelDTO>;

  /** Parse a raw provider push payload into a normalized notification. */
  parseWebhookNotification(payload: unknown): WebhookNotification;
}
