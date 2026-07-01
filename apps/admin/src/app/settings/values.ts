/**
 * Tolerant coercion of `SystemSetting` JSON values into the concrete shapes the
 * UI needs. The API may return a value directly (`true`, `10`, `"x"`) or wrapped
 * (`{ value: ... }`); these helpers handle both and fall back to a default so a
 * missing/malformed row never crashes the page.
 */
import type { Json, SystemSetting } from '../../lib/types';

/** Unwrap a `{ value: ... }` envelope one level, otherwise return as-is. */
function unwrap(value: Json | undefined): Json | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as Record<string, Json>).value;
  }
  return value;
}

/** Coerce a JSON setting value to boolean. */
export function asBool(value: Json | undefined, fallback = false): boolean {
  const v = unwrap(value);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
  }
  return fallback;
}

/** Coerce a JSON setting value to a finite number, else the fallback. */
export function asNumber(value: Json | undefined, fallback: number): number {
  const v = unwrap(value);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return n;
  }
  return fallback;
}

/** Coerce a JSON setting value to a string, else the fallback. */
export function asString(value: Json | undefined, fallback = ''): string {
  const v = unwrap(value);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

/** Coerce a JSON setting value to a string array (tolerant of comma strings). */
export function asStringArray(value: Json | undefined): string[] {
  const v = unwrap(value);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim() !== '') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Look up a setting's raw value by key, or `undefined` when absent. */
export function settingValue(settings: SystemSetting[], key: string): Json | undefined {
  return settings.find((s) => s.key === key)?.value;
}
