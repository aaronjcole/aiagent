/**
 * Timezone-safe scheduling helpers.
 *
 * A bad LLM-produced timezone string must NEVER reach a calendar provider: the
 * mock provider builds an `Intl.DateTimeFormat` with the timezone, which throws
 * a `RangeError` on an invalid IANA zone. We validate up front and treat an
 * absent OR invalid zone as "needs clarification" instead of crashing.
 */

/**
 * True iff `tz` is a valid IANA timezone identifier accepted by the host's
 * `Intl` implementation. An empty/whitespace value or an unknown zone → false.
 */
export function isValidIanaTimezone(tz: string | null | undefined): boolean {
  if (typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (trimmed.length === 0) return false;
  try {
    // Throws RangeError on an unknown timeZone.
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}
