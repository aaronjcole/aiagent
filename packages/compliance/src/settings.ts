/**
 * Typed reader over the `SystemSetting` table for controlled-autonomy knobs.
 *
 * Every value falls back to the CONSERVATIVE default from
 * `@app/shared`'s `AUTONOMY_SETTINGS` catalog when no row exists, so a fresh
 * deployment is always in the safest posture. The reader is the deterministic
 * source of truth for the policy layer — the LLM never reads or writes these.
 *
 * DB access is expressed as a narrow {@link SettingsStore} interface; the Prisma
 * implementation lives here, and tests use {@link FakeSettingsReader} (in
 * `fakes.ts`). All reads are synchronous against an in-memory snapshot the
 * caller loads once via `createSettingsReader`.
 */

import {
  AUTONOMY_SETTINGS,
  defaultFor,
  READINESS_KEYS,
  EmailAutonomyMode,
  CalendarAutonomyMode,
  type SETTING_KEYS,
  type AutonomySettingValue,
} from '@app/shared';
import type { PrismaClient } from '@app/db';
import type { BusinessHours } from './business-hours.js';

/**
 * Synchronous, typed accessor for autonomy settings. Implementations resolve
 * each key from a backing store, falling back to the catalog default.
 */
export interface SettingsReader {
  /** Raw typed value for `key`, or the conservative default. */
  get<K extends SETTING_KEYS>(key: K): AutonomySettingValue<K>;
  /** The configured email autonomy mode. */
  emailAutonomyMode(): EmailAutonomyMode;
  /** The configured calendar autonomy mode. */
  calendarAutonomyMode(): CalendarAutonomyMode;
  /** A numeric setting (caps / thresholds / hours). */
  num(key: SETTING_KEYS): number;
  /** A boolean setting (kill switches / readiness flags). */
  bool(key: SETTING_KEYS): boolean;
  /** A string-array setting (pause lists). */
  strArray(key: SETTING_KEYS): string[];
  /** The business-hours window {start,end,timezone}. */
  businessHours(): BusinessHours;
  /** True only if EVERY readiness flag is confirmed. */
  readinessAllReady(): boolean;
}

/** Narrow store the {@link SettingsReader} resolves keys from. */
export interface SettingsStore {
  /** Resolved raw value for `key`, or undefined when no override exists. */
  raw(key: SETTING_KEYS): unknown;
}

/**
 * Build a {@link SettingsReader} over a pre-loaded snapshot of `SystemSetting`
 * rows. Resolution: snapshot value (when present) → catalog default.
 */
export function makeSettingsReader(store: SettingsStore): SettingsReader {
  function get<K extends SETTING_KEYS>(key: K): AutonomySettingValue<K> {
    const v = store.raw(key);
    return (v === undefined || v === null
      ? defaultFor(key)
      : (v as AutonomySettingValue<K>)) as AutonomySettingValue<K>;
  }

  return {
    get,
    emailAutonomyMode(): EmailAutonomyMode {
      return get('emailAutonomyMode');
    },
    calendarAutonomyMode(): CalendarAutonomyMode {
      return get('calendarAutonomyMode');
    },
    num(key: SETTING_KEYS): number {
      const v = get(key);
      return typeof v === 'number' ? v : Number(defaultFor(key));
    },
    bool(key: SETTING_KEYS): boolean {
      const v = get(key);
      return typeof v === 'boolean' ? v : Boolean(defaultFor(key));
    },
    strArray(key: SETTING_KEYS): string[] {
      const v = get(key);
      return Array.isArray(v) ? (v as string[]) : [];
    },
    businessHours(): BusinessHours {
      return {
        start: this.num('businessHoursStart'),
        end: this.num('businessHoursEnd'),
        timezone: String(get('businessTimezone')),
      };
    },
    readinessAllReady(): boolean {
      return READINESS_KEYS.every((k) => this.bool(k));
    },
  };
}

/**
 * Load all `SystemSetting` rows whose key is in the autonomy catalog and build a
 * {@link SettingsReader}. Reads happen ONCE here; the returned reader is then
 * synchronous and side-effect-free.
 */
export async function createSettingsReader(prisma: PrismaClient): Promise<SettingsReader> {
  const keys = Object.keys(AUTONOMY_SETTINGS) as SETTING_KEYS[];
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: keys } },
  });
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }
  return makeSettingsReader({ raw: (key) => map.get(key) });
}
