/** Small display helpers shared across pages. */

/** Format an ISO date string for display, or `—` when absent/invalid. */
export function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

/** Format a 0–1 confidence value as a percentage, or `—` when absent. */
export function fmtConfidence(value?: number | null): string {
  if (value === undefined || value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

/** Best display name for a prospect: full name, joined first/last, else email. */
export function prospectName(p: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  if (p.fullName) return p.fullName;
  const joined = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return joined || p.email;
}

/**
 * Tolerantly extract an array from common API envelope shapes.
 *
 * Returns the array on success (including a genuinely empty `[]`), or `null`
 * when the shape is malformed/unexpected (e.g. an `{ error }` envelope or a
 * non-array primitive) so callers can distinguish a contract failure from a
 * real empty list and render an error state instead of empty-state copy.
 */
export function asArray<T>(data: unknown): T[] | null {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    for (const key of ['data', 'items', 'results', 'rows']) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return null;
}
