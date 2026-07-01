/**
 * Provider factory: selects the email adapter by `config.emailProvider`,
 * defaulting to the in-memory mock.
 */

import type { Config, Logger } from '@app/shared';
import { GmailProvider } from './gmail.js';
import { MockEmailProvider } from './mock.js';
import type { Clock, EmailProvider } from './types.js';

/** Options for {@link createEmailProvider}. */
export interface CreateEmailProviderOptions {
  /** Deterministic clock for the mock adapter. */
  clock?: Clock;
}

/**
 * Build an `EmailProvider` from config. `mock` (default) is fully in-memory;
 * `gmail` is a stub that throws `ProviderError` until wired up.
 */
export function createEmailProvider(
  config: Config,
  logger: Logger,
  options: CreateEmailProviderOptions = {},
): EmailProvider {
  switch (config.emailProvider) {
    case 'gmail':
      return new GmailProvider({
        clientId: config.gmailClientId,
        clientSecret: config.gmailClientSecret,
        refreshToken: config.gmailRefreshToken,
        redirectUri: config.gmailRedirectUri,
        user: config.gmailUser,
      });
    case 'mock':
    default:
      return new MockEmailProvider({ logger, clock: options.clock });
  }
}
