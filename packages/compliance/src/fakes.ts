/**
 * In-memory fakes implementing the narrow repo interfaces, for unit tests.
 * (Exported from the package so workflow/integration tests can reuse them; they
 * touch NO database.)
 */

import {
  AUTONOMY_SETTINGS,
  defaultFor,
  READINESS_KEYS,
  type SETTING_KEYS,
  type AutonomySettingValue,
  type EmailAutonomyMode,
  type CalendarAutonomyMode,
} from '@app/shared';
import type {
  AddSuppressionInput,
  CapRepo,
  SendCountRepo,
  SuppressionEntryLike,
  SuppressionRepo,
} from './types.js';
import type { SettingsReader } from './settings.js';
import type { BusinessHours } from './business-hours.js';
import type { ReserveArgs, ReserveResult } from './reservations.js';
import { extractDomain, normalizeEmail } from './email.js';

/** In-memory {@link SuppressionRepo} backed by two maps, for unit tests. */
export class FakeSuppressionRepo implements SuppressionRepo {
  private byEmail = new Map<string, SuppressionEntryLike>();
  private byDomain = new Map<string, SuppressionEntryLike>();

  /** Look up a suppression entry by normalized email. */
  async findByEmail(email: string): Promise<SuppressionEntryLike | null> {
    return this.byEmail.get(email.trim().toLowerCase()) ?? null;
  }
  /** Look up a suppression entry by normalized domain. */
  async findByDomain(domain: string): Promise<SuppressionEntryLike | null> {
    return this.byDomain.get(domain.trim().toLowerCase()) ?? null;
  }
  /** Store/replace an entry keyed by its email and/or domain (idempotent). */
  async upsert(input: AddSuppressionInput): Promise<SuppressionEntryLike> {
    const email = input.email?.trim().toLowerCase() ?? null;
    const domain = input.domain?.trim().toLowerCase() ?? null;
    const entry: SuppressionEntryLike = {
      email,
      domain,
      reason: input.reason,
      source: input.source,
      notes: input.notes ?? null,
    };
    if (email) this.byEmail.set(email, entry);
    if (domain) this.byDomain.set(domain, entry);
    return entry;
  }

  /** Total stored unique keys (for idempotency assertions in tests). */
  get size(): number {
    return this.byEmail.size + this.byDomain.size;
  }
}

/** Preset counts the {@link FakeSendCountRepo} returns for each cap query. */
export interface FakeSendCounts {
  global?: number;
  inbox?: Record<string, number>;
  domain?: Record<string, number>;
  sequenceSteps?: Record<string, number>;
  /** All-time sends per prospectId. */
  prospectTotal?: Record<string, number>;
}

/** In-memory {@link SendCountRepo} returning preset counts, for unit tests. */
export class FakeSendCountRepo implements SendCountRepo {
  constructor(private counts: FakeSendCounts = {}) {}

  /** Preset global 24h send count. */
  async countGlobalSentLast24h(): Promise<number> {
    return this.counts.global ?? 0;
  }
  /** Preset 24h send count for a specific inbox. */
  async countByInboxLast24h(fromEmail: string): Promise<number> {
    return this.counts.inbox?.[fromEmail.trim().toLowerCase()] ?? 0;
  }
  /** Preset 24h send count for a specific recipient domain. */
  async countByDomainLast24h(domain: string): Promise<number> {
    const d = domain.trim().toLowerCase();
    return this.counts.domain?.[d] ?? 0;
  }
  /** Preset sequence-step count, keyed by `prospectId:sequenceId` then prospectId. */
  async countSequenceStepsSent(prospectId: string, sequenceId?: string): Promise<number> {
    const key = sequenceId ? `${prospectId}:${sequenceId}` : prospectId;
    return this.counts.sequenceSteps?.[key] ?? this.counts.sequenceSteps?.[prospectId] ?? 0;
  }
  /** Preset all-time send count for a prospect. */
  async countProspectSentTotal(prospectId: string): Promise<number> {
    return this.counts.prospectTotal?.[prospectId] ?? 0;
  }
}

/** Preset counts/timestamps the {@link FakeCapRepo} returns per cap query. */
export interface FakeCapCounts {
  global?: number;
  /** Per sender email (lowercased). */
  sender?: Record<string, number>;
  /** Per recipient domain (lowercased). */
  domain?: Record<string, number>;
  /** Most-recent send timestamp per sender email (lowercased). */
  lastSenderSendAt?: Record<string, Date>;
  /** Per thread id. */
  threadReplies?: Record<string, number>;
  calendarEvents?: number;
}

/** In-memory {@link CapRepo} returning preset counts, for unit tests. */
export class FakeCapRepo implements CapRepo {
  constructor(private counts: FakeCapCounts = {}) {}

  async countGlobalSentToday(): Promise<number> {
    return this.counts.global ?? 0;
  }
  async countSenderSentToday(senderEmail: string): Promise<number> {
    return this.counts.sender?.[senderEmail.trim().toLowerCase()] ?? 0;
  }
  async countDomainSentToday(domain: string): Promise<number> {
    return this.counts.domain?.[domain.trim().toLowerCase()] ?? 0;
  }
  async lastSenderSendAt(senderEmail: string): Promise<Date | null> {
    return this.counts.lastSenderSendAt?.[senderEmail.trim().toLowerCase()] ?? null;
  }
  async countThreadAutoRepliesToday(threadId: string): Promise<number> {
    return this.counts.threadReplies?.[threadId] ?? 0;
  }
  async countCalendarEventsToday(): Promise<number> {
    return this.counts.calendarEvents ?? 0;
  }
}

/**
 * In-memory equivalent of {@link import('./reservations.js').reserveAutoAction}
 * for unit tests. It applies the SAME atomic check-and-reserve semantics against
 * an in-memory reservation ledger (deduped by idempotencyKey), so a second call
 * after a reservation sees the incremented count and denies — exactly the race
 * the real advisory-locked transaction guards. (The real cross-process
 * concurrency is enforced by the pg advisory lock and verified in the live-PG
 * round; this fake exercises the counting + reserve logic.)
 *
 * Caps are read from the provided {@link SettingsReader}, matching the real
 * implementation. Reservations count toward the send caps regardless of whether
 * the recorded action is `email.send` or `email.reply`.
 */
export class FakeReservationStore {
  /** Reservation rows: {action, senderEmail, recipientDomain, idempotencyKey}. */
  readonly rows: {
    kind: 'send' | 'calendar';
    senderEmail?: string;
    recipientDomain?: string;
    idempotencyKey: string;
  }[] = [];

  constructor(private settings: SettingsReader) {}

  /** Distinct-key count of send reservations matching an optional predicate. */
  private countSends(pred: (r: FakeReservationStore['rows'][number]) => boolean): number {
    const keys = new Set<string>();
    let nullKeys = 0;
    for (const r of this.rows) {
      if (r.kind !== 'send' || !pred(r)) continue;
      if (!r.idempotencyKey) nullKeys += 1;
      else keys.add(r.idempotencyKey);
    }
    return keys.size + nullKeys;
  }

  /** Atomic (in-memory) check-and-reserve mirroring `reserveAutoAction`. */
  async reserve(args: ReserveArgs): Promise<ReserveResult> {
    if (args.kind === 'calendar') {
      const count = this.rows.filter((r) => r.kind === 'calendar').length;
      const cap = this.settings.num('maxCalendarEventsPerDay');
      if (count >= cap) {
        return { allowed: false, reason: `daily calendar event cap reached (${count}/${cap})` };
      }
      this.rows.push({ kind: 'calendar', idempotencyKey: args.idempotencyKey });
      return { allowed: true };
    }

    const sender = normalizeEmail(args.senderEmail);
    const domain = extractDomain(args.recipientEmail) ?? '';
    const global = this.countSends(() => true);
    const senderCount = this.countSends((r) => r.senderEmail === sender);
    const domainCount = domain ? this.countSends((r) => r.recipientDomain === domain) : 0;

    const globalCap = this.settings.num('maxAutoSendsPerDayGlobal');
    const senderCap = this.settings.num('maxAutoSendsPerSenderPerDay');
    const domainCap = this.settings.num('maxAutoSendsPerDomainPerDay');

    if (global >= globalCap)
      return { allowed: false, reason: `global daily auto-send cap reached (${global}/${globalCap})` };
    if (senderCount >= senderCap)
      return {
        allowed: false,
        reason: `per-sender daily auto-send cap reached (${senderCount}/${senderCap})`,
      };
    if (domain && domainCount >= domainCap)
      return {
        allowed: false,
        reason: `per-domain daily auto-send cap reached for ${domain} (${domainCount}/${domainCap})`,
      };

    this.rows.push({
      kind: 'send',
      senderEmail: sender,
      recipientDomain: domain,
      idempotencyKey: args.idempotencyKey,
    });
    return { allowed: true };
  }
}

/**
 * In-memory {@link SettingsReader} for tests. Construct with a partial overrides
 * map; any key not overridden resolves to its conservative catalog default.
 */
export class FakeSettingsReader implements SettingsReader {
  private overrides: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }>;

  constructor(overrides: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }> = {}) {
    this.overrides = { ...overrides };
  }

  /** Mutate a single setting (returns this for chaining in tests). */
  set<K extends SETTING_KEYS>(key: K, value: AutonomySettingValue<K>): this {
    this.overrides[key] = value;
    return this;
  }

  get<K extends SETTING_KEYS>(key: K): AutonomySettingValue<K> {
    const v = this.overrides[key];
    return (v === undefined ? defaultFor(key) : v) as AutonomySettingValue<K>;
  }
  emailAutonomyMode(): EmailAutonomyMode {
    return this.get('emailAutonomyMode');
  }
  calendarAutonomyMode(): CalendarAutonomyMode {
    return this.get('calendarAutonomyMode');
  }
  num(key: SETTING_KEYS): number {
    const v = this.get(key);
    return typeof v === 'number' ? v : Number(defaultFor(key));
  }
  bool(key: SETTING_KEYS): boolean {
    const v = this.get(key);
    return typeof v === 'boolean' ? v : Boolean(defaultFor(key));
  }
  strArray(key: SETTING_KEYS): string[] {
    const v = this.get(key);
    return Array.isArray(v) ? (v as string[]) : [];
  }
  businessHours(): BusinessHours {
    return {
      start: this.num('businessHoursStart'),
      end: this.num('businessHoursEnd'),
      timezone: String(this.get('businessTimezone')),
    };
  }
  readinessAllReady(): boolean {
    return READINESS_KEYS.every((k) => this.bool(k));
  }
}

/**
 * Convenience: a {@link FakeSettingsReader} with EVERY readiness flag flipped to
 * true (otherwise default), so tests only need to override the gate(s) under
 * test. `AUTONOMY_SETTINGS` is referenced to keep the key set in sync.
 */
export function readySettings(
  overrides: Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }> = {},
): FakeSettingsReader {
  void AUTONOMY_SETTINGS;
  const readiness = Object.fromEntries(
    READINESS_KEYS.map((k) => [k, true]),
  ) as Partial<{ [K in SETTING_KEYS]: AutonomySettingValue<K> }>;
  return new FakeSettingsReader({ ...readiness, ...overrides });
}

/** Convenience for tests: derive a domain or fail loudly. */
export function domainOf(email: string): string {
  const d = extractDomain(email);
  if (!d) throw new Error(`bad test email: ${email}`);
  return d;
}
