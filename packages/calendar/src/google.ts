/**
 * Google Calendar adapter — STUB.
 *
 * `googleapis` is intentionally not installed in this monorepo, so every method
 * throws a `ProviderError`. The comments below outline the real mapping so a
 * downstream implementer can wire it up by installing `googleapis` and
 * authenticating via the configured `GOOGLE_*` OAuth credentials.
 */

import { ProviderError, type Logger } from '@app/shared';
import type {
  AvailabilityInput,
  AvailabilityResult,
  CalendarEventDTO,
  CalendarProvider,
  CalendarProviderConfig,
  CancelEventInput,
  CreateEventInput,
  UpdateEventInput,
  WatchCalendarInput,
  WatchChannelDTO,
  WebhookNotification,
} from './types.js';

const NOT_CONFIGURED = 'google calendar not configured — set GOOGLE_* env and install googleapis';

/**
 * Google Calendar-backed {@link CalendarProvider} stub. Requires `GOOGLE_*` env
 * and the `googleapis` dependency; throws `ProviderError` until fully wired up.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google' as const;

  private readonly config: CalendarProviderConfig;
  private readonly logger: Logger;

  constructor(config: CalendarProviderConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  // Real impl: build an OAuth2 client from config.google{ClientId,ClientSecret,
  // RefreshToken,RedirectUri}, then `calendar.freebusy.query({ requestBody: {
  // timeMin: rangeStartIso, timeMax: rangeEndIso, timeZone: timezone,
  // items: [{ id: calendarId }] } })`. Map `data.calendars[calendarId].busy`
  // to `busy`, then compute `freeSlots` the same way the mock does.
  getAvailability(_input: AvailabilityInput): Promise<AvailabilityResult> {
    void this.config;
    void this.logger;
    throw new ProviderError(NOT_CONFIGURED);
  }

  // Real impl: `calendar.events.insert({ calendarId, requestBody: { summary:
  // title, description, start: { dateTime: startIso, timeZone }, end: {...},
  // attendees: attendees.map((email) => ({ email })) }, sendUpdates: 'all',
  // conferenceDataVersion: 1 })`. Pass `requestId: idempotencyKey` (within
  // requestBody/`conferenceData.createRequest` and/or the insert call) so a
  // retry returns the same event rather than creating a duplicate.
  createEvent(_input: CreateEventInput): Promise<CalendarEventDTO> {
    throw new ProviderError(NOT_CONFIGURED);
  }

  // Real impl: `calendar.events.patch({ calendarId, eventId: providerEventId,
  // requestBody: { ...changed fields... }, sendUpdates: 'all' })`.
  updateEvent(_input: UpdateEventInput): Promise<CalendarEventDTO> {
    throw new ProviderError(NOT_CONFIGURED);
  }

  // Real impl: `calendar.events.delete({ calendarId, eventId: providerEventId,
  // sendUpdates: 'all' })`, then return the event marked `cancelled`.
  cancelEvent(_input: CancelEventInput): Promise<CalendarEventDTO> {
    throw new ProviderError(NOT_CONFIGURED);
  }

  // Real impl: `calendar.events.watch({ calendarId, requestBody: { id:
  // newId('chan'), type: 'web_hook', address: callbackUrl } })`. Map response
  // `data.{id,resourceId,expiration}` to the WatchChannelDTO (expiration is a
  // ms epoch string → convert to ISO).
  watchCalendar(_input: WatchCalendarInput): Promise<WatchChannelDTO> {
    throw new ProviderError(NOT_CONFIGURED);
  }

  // Real impl: Google push notifications arrive as HTTP headers, not a body:
  // `X-Goog-Channel-ID`, `X-Goog-Resource-ID`, `X-Goog-Resource-State`,
  // `X-Goog-Channel-Token`. Parse those into a WebhookNotification; an `exists`
  // state means re-sync the calendar via events.list with the saved syncToken.
  parseWebhookNotification(_payload: unknown): WebhookNotification {
    throw new ProviderError(NOT_CONFIGURED);
  }
}
