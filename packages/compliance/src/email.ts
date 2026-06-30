/**
 * Small deterministic email-address helpers shared by the compliance checks.
 */

/**
 * Pragmatic, RFC-ish single-address validation. Not a full RFC 5322 parser
 * (which is impractical and over-permissive); this catches the cases that
 * matter for outbound safety: exactly one `@`, a non-empty local part with no
 * spaces, and a domain with at least one dot and a 2+ char TLD.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

export function isValidEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return EMAIL_RE.test(trimmed);
}

/** Lowercase + trim an email for consistent comparison/keying. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Extract the (lowercased) domain from an email, or null if malformed. */
export function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}
