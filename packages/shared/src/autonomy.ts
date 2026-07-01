/**
 * Typed catalog of controlled-autonomy `SystemSetting` keys, their value types,
 * and CONSERVATIVE defaults.
 *
 * This is the single source of truth for which knobs govern autonomous email /
 * calendar behavior and what they default to when no row exists in the
 * `SystemSetting` table. The deterministic policy layer (`@app/compliance`)
 * reads these — the LLM never decides any of them.
 *
 * Every default is deliberately conservative: the safest possible posture so
 * that a fresh deployment (with no settings rows) cannot auto-send or auto-book.
 */

import { EmailAutonomyMode, CalendarAutonomyMode } from './constants.js';

/**
 * The typed catalog shape: each setting key with its WIDE value type (booleans
 * as `boolean`, caps/thresholds as `number`, pause lists as `string[]`, modes as
 * their string-literal unions). Annotating the catalog with this interface keeps
 * default VALUES while exposing widened value types to consumers/overrides.
 */
export interface AutonomySettings {
  emailAutonomyMode: EmailAutonomyMode;
  calendarAutonomyMode: CalendarAutonomyMode;

  maxAutoSendsPerDayGlobal: number;
  maxAutoSendsPerSenderPerDay: number;
  maxAutoSendsPerDomainPerDay: number;
  maxAutoSendsPerProspectPerSequence: number;
  minMinutesBetweenAutoSendsPerSender: number;
  maxAutoRepliesPerThreadPerDay: number;
  maxCalendarEventsPerDay: number;

  researchConfidenceThreshold: number;
  complianceConfidenceThreshold: number;
  calendarConfidenceThreshold: number;

  businessHoursStart: number;
  businessHoursEnd: number;
  businessTimezone: string;

  globalPauseAllAutomation: boolean;
  pauseOutboundSending: boolean;
  pauseInboundReplies: boolean;
  pauseCalendarCreation: boolean;
  pauseSpecificSenderAccounts: string[];
  pauseSpecificDomains: string[];

  spfDkimDmarcReady: boolean;
  physicalAddressConfigured: boolean;
  unsubscribeConfigured: boolean;
  suppressionListActive: boolean;
  senderIdentityConfigured: boolean;
  replyToValid: boolean;
  bounceHandlingConfigured: boolean;
  postmasterMonitoring: boolean;
}

/**
 * The full catalog: each key maps to its conservative default value. Values are
 * widened per {@link AutonomySettings} so overrides (e.g. flipping a flag to
 * `true`) typecheck.
 */
export const AUTONOMY_SETTINGS: AutonomySettings = {
  // --- Autonomy modes ---
  /** Email autonomy ladder; default requires explicit human approval. */
  emailAutonomyMode: EmailAutonomyMode.APPROVAL_REQUIRED,
  /** Calendar autonomy ladder; default only proposes times. */
  calendarAutonomyMode: CalendarAutonomyMode.PROPOSE_TIMES_ONLY,

  // --- Sending / scheduling caps ---
  /** Max autonomous sends across ALL senders per day. */
  maxAutoSendsPerDayGlobal: 10,
  /** Max autonomous sends from a single sender account per day. */
  maxAutoSendsPerSenderPerDay: 10,
  /** Max autonomous sends to a single recipient domain per day. */
  maxAutoSendsPerDomainPerDay: 2,
  /** Max autonomous sends to a single prospect within one sequence. */
  maxAutoSendsPerProspectPerSequence: 1,
  /** Minimum minutes between two autonomous sends from the same sender. */
  minMinutesBetweenAutoSendsPerSender: 10,
  /** Max autonomous replies on a single thread per day. */
  maxAutoRepliesPerThreadPerDay: 3,
  /** Max autonomous calendar events created per day. */
  maxCalendarEventsPerDay: 10,

  // --- Confidence thresholds ---
  /** Minimum research confidence to autonomously send. */
  researchConfidenceThreshold: 0.7,
  /** Minimum compliance-review confidence to autonomously send. */
  complianceConfidenceThreshold: 0.7,
  /** Minimum classification confidence to autonomously book a meeting. */
  calendarConfidenceThreshold: 0.9,

  // --- Business hours ---
  /** Business-day start hour (0-23, local to `businessTimezone`). */
  businessHoursStart: 9,
  /** Business-day end hour (0-23, local to `businessTimezone`). */
  businessHoursEnd: 17,
  /** IANA timezone the business hours are evaluated in. */
  businessTimezone: 'America/New_York',

  // --- Kill switches ---
  /** Hard global stop: when true, NOTHING is automated. */
  globalPauseAllAutomation: false,
  /** Pause all autonomous outbound sending. */
  pauseOutboundSending: false,
  /** Pause all autonomous inbound replies. */
  pauseInboundReplies: false,
  /** Pause all autonomous calendar event creation. */
  pauseCalendarCreation: false,
  /** Specific sender accounts (emails) that are paused. */
  pauseSpecificSenderAccounts: [] as string[],
  /** Specific recipient domains that are paused. */
  pauseSpecificDomains: [] as string[],

  // --- Readiness flags (deliverability / compliance posture) ---
  /** SPF/DKIM/DMARC verified for the sending domain. */
  spfDkimDmarcReady: false,
  /** A physical postal address is configured (CAN-SPAM). */
  physicalAddressConfigured: false,
  /** A working unsubscribe mechanism is configured. */
  unsubscribeConfigured: false,
  /** The suppression list is active and enforced. */
  suppressionListActive: false,
  /** Sender identity (from name/address) is configured. */
  senderIdentityConfigured: false,
  /** A valid Reply-To is configured. */
  replyToValid: false,
  /** Bounce handling is configured. */
  bounceHandlingConfigured: false,
  /** Postmaster / deliverability monitoring is active. */
  postmasterMonitoring: false,
};

/** Union of every autonomy setting key. */
export type SETTING_KEYS = keyof AutonomySettings;

/** Convenience alias mirroring {@link SETTING_KEYS} for value-position use. */
export type AutonomySettingKey = SETTING_KEYS;

/** The value type of a specific setting key. */
export type AutonomySettingValue<K extends SETTING_KEYS> = AutonomySettings[K];

/**
 * Return the conservative default for a setting key. Used as the fallback when
 * no `SystemSetting` row exists for that key.
 */
export function defaultFor<K extends SETTING_KEYS>(key: K): AutonomySettingValue<K> {
  return AUTONOMY_SETTINGS[key];
}

/** All readiness flag keys (every one must be confirmed before auto-send). */
export const READINESS_KEYS = [
  'spfDkimDmarcReady',
  'physicalAddressConfigured',
  'unsubscribeConfigured',
  'suppressionListActive',
  'senderIdentityConfigured',
  'replyToValid',
  'bounceHandlingConfigured',
  'postmasterMonitoring',
] as const satisfies readonly SETTING_KEYS[];

/** Numeric cap keys. */
export const CAP_KEYS = [
  'maxAutoSendsPerDayGlobal',
  'maxAutoSendsPerSenderPerDay',
  'maxAutoSendsPerDomainPerDay',
  'maxAutoSendsPerProspectPerSequence',
  'minMinutesBetweenAutoSendsPerSender',
  'maxAutoRepliesPerThreadPerDay',
  'maxCalendarEventsPerDay',
] as const satisfies readonly SETTING_KEYS[];

/** Kill-switch keys (boolean flags + the two string-array pause lists). */
export const KILLSWITCH_KEYS = [
  'globalPauseAllAutomation',
  'pauseOutboundSending',
  'pauseInboundReplies',
  'pauseCalendarCreation',
  'pauseSpecificSenderAccounts',
  'pauseSpecificDomains',
] as const satisfies readonly SETTING_KEYS[];
