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
  /**
   * Force a synchronous-from-the-caller's-view FRESH reload of the backing store
   * so the NEXT synchronous read reflects the latest committed `SystemSetting`
   * values, bypassing the TTL cache. OPTIONAL: only the live reader implements
   * it (snapshot / fake readers are already exact). Safety-critical decision
   * points (the final kill-switch re-check before a real send/book) MUST
   * `await settings.refresh?.()` first so a kill-switch flip cannot be served
   * stale up to the TTL (fixes SAFE-3). Non-safety-critical reads keep serving
   * from the short-TTL cache, preserving the query-storm protection.
   */
  refresh?(): Promise<void>;
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
 * The TTL is env-configurable via `LIVE_SETTINGS_TTL_MS` (wired through
 * `config.liveSettingsTtlMs` in `createDeps`).
 *
 * The reader exposes the SAME synchronous {@link SettingsReader} interface as the
 * snapshot reader, so callers are unchanged. The synchronous getters read from
 * the most recent snapshot; staleness triggers a non-blocking refresh whose
 * result is applied to subsequent reads. The first snapshot is loaded eagerly
 * before this function resolves.
 *
 * SAFETY-CRITICAL FRESHNESS (SAFE-3): the returned reader also exposes
 * {@link SettingsReader.refresh}, a forced synchronous-awaited reload used at the
 * actual send/book decision points (kill-switch / autonomy-mode re-check) so a
 * flip cannot be served stale up to the TTL. The TTL cache still governs the
 * many non-safety-critical reads, preserving the query-storm protection.
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
        // Keep serving the last-good snapshot on a transient DB error, and
        // stamp loadedAt=now so a failing refresh does NOT re-fire on every
        // subsequent read (which would turn a DB blip into a query storm). We
        // retry no more often than the TTL, matching the success cadence.
        loadedAt = Date.now();
      })
      .finally(() => {
        refreshing = null;
      });
  }

  /**
   * FORCE a fresh reload and wait for it. Used by the safety-critical
   * forced-fresh path (kill-switch re-check) so a flip cannot be served stale up
   * to the TTL. Coalesces with any in-flight background refresh so a burst of
   * decision points does not fan out into many concurrent queries. On a DB error
   * the last-good snapshot is retained (fail-safe) and the error is swallowed —
   * the caller's downstream gates remain conservative by construction.
   */
  async function refresh(): Promise<void> {
    if (refreshing) {
      // A background/stale refresh is already in flight — await it rather than
      // firing a second concurrent query.
      await refreshing;
      return;
    }
    refreshing = load()
      .catch(() => {
        loadedAt = Date.now();
      })
      .finally(() => {
        refreshing = null;
      });
    await refreshing;
  }

  // Eager initial load so the first reads see real values, not catalog defaults.
  await load();

  const reader = makeSettingsReader({
    raw: (key) => {
      maybeRefresh();
      return snapshot.get(key);
    },
  });
  // Attach the forced-fresh path used at safety-critical decision points.
  reader.refresh = refresh;
  return reader;
}
