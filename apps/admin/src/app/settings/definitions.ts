/**
 * Static metadata for the controlled-autonomy `SystemSetting` keys the settings
 * page renders: human labels, conservative defaults, value kinds, and option
 * lists. Mirrors `@app/shared`'s autonomy catalog but is duplicated locally so
 * the admin stays a thin HTTP client (no runtime dependency on the policy layer).
 *
 * The admin never *decides* policy from these — it only displays current values
 * and PUTs edits back to `PUT /settings/:key`. Everything is tolerant of missing
 * keys so the page degrades gracefully if the API contract is incomplete.
 */
import type { EmailAutonomyMode, CalendarAutonomyMode } from '../../lib/types';

/** Email autonomy mode options, lowest → highest autonomy, with safe default. */
export const EMAIL_AUTONOMY_OPTIONS: ReadonlyArray<{ value: EmailAutonomyMode; label: string }> = [
  { value: 'disabled', label: 'Disabled — no automated email behavior' },
  { value: 'draft_only', label: 'Draft only — generate drafts, never send' },
  { value: 'approval_required', label: 'Approval required — human approves every send' },
  { value: 'limited_auto_send', label: 'Limited auto-send — bounded autonomous sending' },
];

/** Calendar autonomy mode options, lowest → highest autonomy, with safe default. */
export const CALENDAR_AUTONOMY_OPTIONS: ReadonlyArray<{
  value: CalendarAutonomyMode;
  label: string;
}> = [
  { value: 'disabled', label: 'Disabled — no automated calendar behavior' },
  { value: 'propose_times_only', label: 'Propose times only — a human books' },
  { value: 'auto_book_confirmed', label: 'Auto-book confirmed — bounded autonomous booking' },
];

/** Conservative defaults shown when no `SystemSetting` row exists for a key. */
export const EMAIL_AUTONOMY_DEFAULT: EmailAutonomyMode = 'approval_required';
/** Conservative calendar default: only propose times, never auto-book. */
export const CALENDAR_AUTONOMY_DEFAULT: CalendarAutonomyMode = 'propose_times_only';

/** A numeric cap / threshold / business-hours setting and how to display it. */
export interface NumericSettingDef {
  key: string;
  label: string;
  /** Conservative default when no row exists. */
  default: number;
  /** `int` renders a step-1 number input; `float` allows decimals (0–1 thresholds). */
  kind: 'int' | 'float';
  /** Optional unit suffix shown after the value (e.g. "/ day", "min"). */
  unit?: string;
  help?: string;
}

/** Sending / scheduling caps. */
export const CAP_DEFS: ReadonlyArray<NumericSettingDef> = [
  { key: 'maxAutoSendsPerDayGlobal', label: 'Max auto-sends per day (global)', default: 10, kind: 'int', unit: '/ day' },
  { key: 'maxAutoSendsPerSenderPerDay', label: 'Max auto-sends per sender / day', default: 10, kind: 'int', unit: '/ day' },
  { key: 'maxAutoSendsPerDomainPerDay', label: 'Max auto-sends per domain / day', default: 2, kind: 'int', unit: '/ day' },
  { key: 'maxAutoSendsPerProspectPerSequence', label: 'Max auto-sends per prospect / sequence', default: 1, kind: 'int' },
  { key: 'minMinutesBetweenAutoSendsPerSender', label: 'Min minutes between sends (per sender)', default: 10, kind: 'int', unit: 'min' },
  { key: 'maxAutoRepliesPerThreadPerDay', label: 'Max auto-replies per thread / day', default: 3, kind: 'int', unit: '/ day' },
  { key: 'maxCalendarEventsPerDay', label: 'Max calendar events per day', default: 10, kind: 'int', unit: '/ day' },
];

/** Confidence thresholds (0–1). */
export const THRESHOLD_DEFS: ReadonlyArray<NumericSettingDef> = [
  { key: 'researchConfidenceThreshold', label: 'Research confidence threshold', default: 0.7, kind: 'float', help: '0–1; min research confidence to auto-send' },
  { key: 'complianceConfidenceThreshold', label: 'Compliance confidence threshold', default: 0.7, kind: 'float', help: '0–1; min compliance confidence to auto-send' },
  { key: 'calendarConfidenceThreshold', label: 'Calendar confidence threshold', default: 0.9, kind: 'float', help: '0–1; min classification confidence to auto-book' },
];

/** Business-hours numeric settings (the timezone is handled separately as text). */
export const BUSINESS_HOURS_NUMERIC_DEFS: ReadonlyArray<NumericSettingDef> = [
  { key: 'businessHoursStart', label: 'Business hours start (0–23)', default: 9, kind: 'int', unit: ':00' },
  { key: 'businessHoursEnd', label: 'Business hours end (0–23)', default: 17, kind: 'int', unit: ':00' },
];

/** Business timezone text setting. */
export const BUSINESS_TIMEZONE_DEF = {
  key: 'businessTimezone',
  label: 'Business timezone (IANA)',
  default: 'America/New_York',
} as const;

/** A boolean kill-switch setting. */
export interface BooleanSettingDef {
  key: string;
  label: string;
  /** Conservative default when no row exists. */
  default: boolean;
  help?: string;
}

/** Boolean kill switches (the global pause is rendered prominently, see below). */
export const KILLSWITCH_BOOLEAN_DEFS: ReadonlyArray<BooleanSettingDef> = [
  { key: 'globalPauseAllAutomation', label: 'Global pause — stop ALL automation', default: false, help: 'Hard stop: nothing is automated while on.' },
  { key: 'pauseOutboundSending', label: 'Pause outbound sending', default: false },
  { key: 'pauseInboundReplies', label: 'Pause inbound replies', default: false },
  { key: 'pauseCalendarCreation', label: 'Pause calendar creation', default: false },
];

/** The key for the prominent global pause (rendered separately). */
export const GLOBAL_PAUSE_KEY = 'globalPauseAllAutomation';

/** String-array pause lists (comma-list editors). */
export const KILLSWITCH_LIST_DEFS: ReadonlyArray<{ key: string; label: string; placeholder: string }> = [
  { key: 'pauseSpecificSenderAccounts', label: 'Paused sender accounts', placeholder: 'alice@acme.com, bob@acme.com' },
  { key: 'pauseSpecificDomains', label: 'Paused recipient domains', placeholder: 'example.com, test.org' },
];

/** The 8 deliverability / compliance readiness booleans. */
export const READINESS_DEFS: ReadonlyArray<BooleanSettingDef> = [
  { key: 'spfDkimDmarcReady', label: 'SPF / DKIM / DMARC verified', default: false },
  { key: 'physicalAddressConfigured', label: 'Physical postal address configured (CAN-SPAM)', default: false },
  { key: 'unsubscribeConfigured', label: 'Unsubscribe mechanism configured', default: false },
  { key: 'suppressionListActive', label: 'Suppression list active & enforced', default: false },
  { key: 'senderIdentityConfigured', label: 'Sender identity configured', default: false },
  { key: 'replyToValid', label: 'Valid Reply-To configured', default: false },
  { key: 'bounceHandlingConfigured', label: 'Bounce handling configured', default: false },
  { key: 'postmasterMonitoring', label: 'Postmaster / deliverability monitoring active', default: false },
];

/** Every autonomy key this page manages — used to flag "other" settings below. */
export const MANAGED_KEYS: ReadonlySet<string> = new Set<string>([
  'emailAutonomyMode',
  'calendarAutonomyMode',
  ...CAP_DEFS.map((d) => d.key),
  ...THRESHOLD_DEFS.map((d) => d.key),
  ...BUSINESS_HOURS_NUMERIC_DEFS.map((d) => d.key),
  BUSINESS_TIMEZONE_DEF.key,
  ...KILLSWITCH_BOOLEAN_DEFS.map((d) => d.key),
  ...KILLSWITCH_LIST_DEFS.map((d) => d.key),
  ...READINESS_DEFS.map((d) => d.key),
]);
