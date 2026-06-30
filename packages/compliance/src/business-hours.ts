/**
 * Deterministic business-hours + IANA timezone helpers.
 *
 * These are pure and `Intl`-based (no external date library, no I/O), so they
 * behave identically across runs. They are used by the controlled-autonomy
 * policy services to enforce quiet-hours and business-hour windows.
 */

/** Business-hours window evaluated in a specific IANA timezone. */
export interface BusinessHours {
  /** Start hour, 0-23 inclusive (local to `timezone`). */
  start: number;
  /** End hour, 0-23 inclusive (local to `timezone`); the window is [start, end). */
  end: number;
  /** IANA timezone identifier (e.g. `America/New_York`). */
  timezone: string;
}

/**
 * True if `tz` is a valid IANA timezone identifier. Uses the runtime's `Intl`
 * timezone database; unknown identifiers throw and are reported as invalid.
 */
export function isValidIanaTimezone(tz: string | null | undefined): boolean {
  if (typeof tz !== 'string' || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the local hour (0-23) of an instant in a given IANA timezone.
 * Returns null if `iso` is not a valid datetime or `timeZone` is invalid.
 */
function localHourInZone(iso: string, timeZone: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour');
    if (!hourPart) return null;
    // `hour12:false` can render midnight as "24"; normalize to 0-23.
    const hour = Number.parseInt(hourPart.value, 10);
    if (Number.isNaN(hour)) return null;
    return hour === 24 ? 0 : hour;
  } catch {
    return null;
  }
}

/**
 * True if the instant `iso` falls within the business-hours window
 * `[start, end)` in the configured IANA timezone.
 *
 * Conservative: an invalid timezone, invalid datetime, or malformed window
 * (start/end out of 0-23, or start >= end) returns false.
 */
export function isWithinBusinessHours(iso: string, hours: BusinessHours): boolean {
  const { start, end, timezone } = hours;
  if (!isValidIanaTimezone(timezone)) return false;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > 23 ||
    end < 0 ||
    end > 23 ||
    start >= end
  ) {
    return false;
  }
  const hour = localHourInZone(iso, timezone);
  if (hour === null) return false;
  return hour >= start && hour < end;
}
