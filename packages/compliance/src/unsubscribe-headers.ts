/**
 * Build RFC 8058 / RFC 2369 `List-Unsubscribe` headers for an outbound message.
 *
 * Headers are emitted ONLY when the corresponding readiness/config is enabled:
 *  - the `unsubscribeConfigured` readiness flag must be true, AND
 *  - at least one mechanism must be available (a mailto address and/or an
 *    https URL derived from `UNSUBSCRIBE_BASE_URL`).
 *
 * When one-click unsubscribe is configured (an https endpoint is present), the
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header (RFC 8058) is also
 * emitted. This complements the in-body CAN-SPAM footer (`ensureFooter`); it
 * does NOT replace it.
 */

import type { SettingsReader } from './settings.js';
import { isValidEmail, normalizeEmail } from './email.js';

/** Subset of `Config` the header builder reads. */
export interface UnsubscribeHeaderConfig {
  /** Base unsubscribe URL (e.g. `https://example.com/unsubscribe`). */
  unsubscribeBaseUrl?: string;
  /** Optional mailto address recipients can email to opt out. */
  unsubscribeMailto?: string;
}

/** Inputs for {@link buildUnsubscribeHeaders}. */
export interface BuildUnsubscribeHeadersInput {
  settings: SettingsReader;
  config: UnsubscribeHeaderConfig;
  /** The recipient address (used to build a per-recipient opt-out link). */
  recipient: string;
}

/** The emitted header map (empty when unsubscribe is not configured). */
export interface UnsubscribeHeaders {
  'List-Unsubscribe'?: string;
  'List-Unsubscribe-Post'?: string;
}

/**
 * Produce the `List-Unsubscribe` (+ optional one-click POST) headers, or an
 * empty object when unsubscribe is not configured.
 */
export function buildUnsubscribeHeaders(
  input: BuildUnsubscribeHeadersInput,
): UnsubscribeHeaders {
  const { settings, config, recipient } = input;

  // Gate 1: readiness must explicitly confirm unsubscribe is configured.
  if (!settings.bool('unsubscribeConfigured')) {
    return {};
  }

  const mechanisms: string[] = [];

  // mailto mechanism.
  const mailto = config.unsubscribeMailto?.trim();
  if (mailto && isValidEmail(mailto)) {
    mechanisms.push(`<mailto:${normalizeEmail(mailto)}>`);
  }

  // https mechanism (one-click capable).
  let hasHttps = false;
  const base = config.unsubscribeBaseUrl?.trim();
  if (base && /^https?:\/\//i.test(base)) {
    const sep = base.includes('?') ? '&' : '?';
    const url = isValidEmail(recipient)
      ? `${base}${sep}email=${encodeURIComponent(normalizeEmail(recipient))}`
      : base;
    mechanisms.push(`<${url}>`);
    hasHttps = true;
  }

  if (mechanisms.length === 0) {
    return {};
  }

  const headers: UnsubscribeHeaders = {
    'List-Unsubscribe': mechanisms.join(', '),
  };
  // RFC 8058 one-click is only meaningful for an https POST endpoint.
  if (hasHttps) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}
