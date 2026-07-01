/**
 * Build RFC 8058 / RFC 2369 `List-Unsubscribe` headers for an outbound message.
 *
 * Headers are emitted ONLY when the corresponding readiness/config is enabled:
 *  - the `unsubscribeConfigured` readiness flag must be true, AND
 *  - at least one mechanism must be available (a mailto address and/or an
 *    https URL derived from `UNSUBSCRIBE_BASE_URL`).
 *
 * One-click unsubscribe (the https mechanism + the
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header, RFC 8058) is
 * emitted ONLY when the https endpoint can be made functional and safe: an
 * https:// base URL, a valid recipient, AND a signing secret so the link
 * carries a signed `?token=`. Without the secret no https/one-click mechanism
 * is advertised (only the mailto fallback, if any) — we never emit a plain,
 * unverifiable `?email=` one-click link. This complements the in-body CAN-SPAM
 * footer (`ensureFooter`); it does NOT replace it.
 */

import { signUnsubscribeToken } from '@app/shared';
import type { SettingsReader } from './settings.js';
import { isValidEmail, normalizeEmail } from './email.js';

/** Subset of `Config` the header builder reads. */
export interface UnsubscribeHeaderConfig {
  /** Base unsubscribe URL. RFC 8058 one-click requires `https://`. */
  unsubscribeBaseUrl?: string;
  /** Optional mailto address recipients can email to opt out. */
  unsubscribeMailto?: string;
  /**
   * Optional secret for signing one-click unsubscribe tokens. When present
   * (and a valid recipient is supplied), the https one-click URL carries a
   * signed `?token=` instead of a plain `?email=`, so the endpoint derives the
   * target from a tamper-evident token rather than trusting query input.
   */
  unsubscribeTokenSecret?: string;
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

  // https one-click mechanism (RFC 8058). Emitted ONLY when we can build a
  // FUNCTIONAL, tamper-evident link, which requires ALL of:
  //  - an https:// base URL (RFC 8058 one-click MUST be HTTPS; http:// and any
  //    other scheme are rejected and fall back to the mailto mechanism only),
  //  - a valid recipient address, AND
  //  - a signing secret so we can mint a signed `?token=`.
  // Without the secret we deliberately do NOT advertise a plain `?email=` link:
  // that endpoint has no way to verify the query input, so a one-click POST to
  // it would be a nonfunctional / unsafe mechanism. In that case only the
  // mailto fallback (if any) is offered.
  let hasHttps = false;
  const base = config.unsubscribeBaseUrl?.trim();
  const secret = config.unsubscribeTokenSecret?.trim();
  if (base && /^https:\/\//i.test(base) && secret && isValidEmail(recipient)) {
    const sep = base.includes('?') ? '&' : '?';
    const token = signUnsubscribeToken({ email: normalizeEmail(recipient) }, secret);
    const url = `${base}${sep}token=${encodeURIComponent(token)}`;
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
