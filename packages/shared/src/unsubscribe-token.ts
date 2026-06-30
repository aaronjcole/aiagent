/**
 * Signed unsubscribe tokens.
 *
 * A deterministic HMAC-SHA256 token so the public unsubscribe endpoint can
 * derive its target (email and/or domain) from a signed, tamper-evident token
 * instead of trusting caller-supplied query input. The token format is:
 *
 *   `${base64url(JSON payload)}.${base64url(HMAC-SHA256(payload, secret))}`
 *
 * Signing is deterministic: the same payload + secret always yields the same
 * token (no embedded timestamp unless an explicit `issuedAt` is supplied), so
 * tokens are stable and easy to assert in tests. Verification uses a
 * constant-time comparison and returns `null` for any missing/invalid/tampered
 * token or a token signed with a different secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The unsubscribe target carried by a token. At least one field is expected. */
export interface UnsubscribeTokenPayload {
  /** Target recipient email (opaque to this module; not validated here). */
  email?: string;
  /** Target recipient domain. */
  domain?: string;
}

/** Options for {@link signUnsubscribeToken}. */
export interface SignUnsubscribeTokenOptions {
  /**
   * Optional issued-at marker (e.g. an ISO string or epoch ms) included in the
   * signed payload. Omit to keep the token deterministic/stable; supply it only
   * when you intend the token to vary over time. There is NO implicit
   * `Date.now()` — tokens are stable by default.
   */
  issuedAt?: string | number;
}

/** Base64url-encode a UTF-8 string (no padding). */
function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** Base64url-decode to a UTF-8 string; returns null on malformed input. */
function b64urlDecode(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Compute the base64url HMAC-SHA256 signature of `payloadB64` under `secret`. */
function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * Build the canonical payload object, dropping empty/undefined fields so the
 * serialization (and therefore the signature) is stable.
 */
function canonicalPayload(
  payload: UnsubscribeTokenPayload,
  issuedAt?: string | number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload.email !== undefined && payload.email !== '') out.email = payload.email;
  if (payload.domain !== undefined && payload.domain !== '') out.domain = payload.domain;
  if (issuedAt !== undefined) out.iat = issuedAt;
  return out;
}

/**
 * Sign an unsubscribe target into a `${payload}.${sig}` token. Deterministic
 * for a given payload + secret unless `issuedAt` is supplied.
 */
export function signUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  secret: string,
  options: SignUnsubscribeTokenOptions = {},
): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signUnsubscribeToken: secret must be a non-empty string');
  }
  const json = JSON.stringify(canonicalPayload(payload, options.issuedAt));
  const payloadB64 = b64urlEncode(json);
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a token and return its `{ email?, domain? }` payload, or `null` if the
 * token is missing, malformed, signed with a different secret, or tampered.
 * Uses a constant-time signature comparison.
 */
export function verifyUnsubscribeToken(
  token: string | null | undefined,
  secret: string,
): UnsubscribeTokenPayload | null {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payloadB64, secret);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on length mismatch.
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  const json = b64urlDecode(payloadB64);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const result: UnsubscribeTokenPayload = {};
  if (typeof obj.email === 'string') result.email = obj.email;
  if (typeof obj.domain === 'string') result.domain = obj.domain;
  return result;
}
