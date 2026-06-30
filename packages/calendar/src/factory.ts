/** Factory that selects a calendar adapter by config (mock by default). */

import type { Config, Logger } from '@app/shared';
import { GoogleCalendarProvider } from './google.js';
import { MockCalendarProvider } from './mock.js';
import type { CalendarProvider, CalendarProviderConfig } from './types.js';

/** Narrow a full {@link Config} (or a partial calendar config) to the fields this package needs. */
export type CalendarConfigInput = Pick<
  Config,
  | 'calendarProvider'
  | 'googleClientId'
  | 'googleClientSecret'
  | 'googleRefreshToken'
  | 'googleRedirectUri'
  | 'googleCalendarId'
> & { mockBaseDateIso?: string };

function toProviderConfig(config: CalendarConfigInput): CalendarProviderConfig {
  return {
    provider: config.calendarProvider,
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
    googleRefreshToken: config.googleRefreshToken,
    googleRedirectUri: config.googleRedirectUri,
    googleCalendarId: config.googleCalendarId,
    mockBaseDateIso: config.mockBaseDateIso,
  };
}

/**
 * Create a {@link CalendarProvider} from config. Defaults to the in-memory mock
 * adapter; `calendarProvider === 'google'` selects the (stub) Google adapter.
 */
export function createCalendarProvider(config: CalendarConfigInput, logger: Logger): CalendarProvider {
  const providerConfig = toProviderConfig(config);
  switch (providerConfig.provider) {
    case 'google':
      return new GoogleCalendarProvider(providerConfig, logger);
    case 'mock':
    default:
      return new MockCalendarProvider(providerConfig, logger);
  }
}
