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

/** Default freshness window for {@link createLiveSettingsReader}'s cache. */
export const DEFAULT_LIVE_SETTINGS_TTL_MS = 5000;

/** Options for {@link createLiveSettingsReader}. */
export interface LiveSettingsReaderOptions {
  /**
   * Cache freshness window in milliseconds. The reader serves values from a
   * cached snapshot and synchronously re-queries `SystemSetting` only when the
   * snapshot is older than this. Defaults to {@link DEFAULT_LIVE_SETTINGS_TTL_MS}
   * (5000ms). A lower value propagates admin changes (kill switches / modes /
   * readiness) faster at the cost of more DB reads; `0` re-queries on every read.
   */
  ttlMs?: number;
}

/**
 * Build a LIVE {@link SettingsReader} that reflects current `SystemSetting`
 * values WITHOUT a process restart. Unlike {@link createSettingsReader} (which
 * snapshots once), this reader keeps a short-TTL cache and re-queries the DB in
 * the background when the snapshot goes stale, so admin changes — kill switches,
 * autonomy modes, readiness flags — take effect within the TTL window (default
 * 5s) rather than at next deploy. The TTL bounds DB load so a hot path that
 * checks settings many times per second does not trigger a per-call query storm.
 *
 * The reader exposes the SAME synchronous {@link SettingsReader} interface as the
 * snapshot reader, so callers are unchanged. The synchronous getters read from
 * the most recent snapshot; staleness triggers a non-blocking refresh whose
 * result is applied to subsequent reads. The first snapshot is loaded eagerly
 * before this function resolves.
 *
 * Intended for long-lived workers / API processes (wired in `createDeps()`).
 * Tests continue to use {@link FakeSettingsReader}, which is TTL-free and
 * therefore deterministic.
 */
export async function createLiveSettingsReader(
  prisma: PrismaClient,
  opts: LiveSettingsReaderOptions = {},
): Promise<SettingsReader> {
  const ttlMs = opts.ttlMs ?? DEFAULT_LIVE_SETTINGS_TTL_MS;
  const keys = Object.keys(AUTONOMY_SETTINGS) as SETTING_KEYS[];

  let snapshot = new Map<string, unknown>();
  let loadedAt = 0;
  let refreshing: Promise<void> | null = null;

  async function load(): Promise<void> {
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const next = new Map<string, unknown>();
    for (const row of rows) next.set(row.key, row.value);
    snapshot = next;
    loadedAt = Date.now();
  }

  /** Kick off a refresh if the snapshot is stale; never throws to the caller. */
  function maybeRefresh(): void {
    if (refreshing) return;
    if (Date.now() - loadedAt < ttlMs) return;
    refreshing = load()
      .catch(() => {
        // Keep serving the last good snapshot on a transient DB error.
      })
      .finally(() => {
        refreshing = null;
      });
  }

  // Eager initial load so the first reads see real values, not catalog defaults.
  await load();

  return makeSettingsReader({
    raw: (key) => {
      maybeRefresh();
      return snapshot.get(key);
    },
  });
}
