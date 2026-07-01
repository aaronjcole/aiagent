/**
 * The DETERMINISTIC controlled-autonomy decision layer.
 *
 * SAFETY-CRITICAL. These services decide whether an autonomous email send,
 * autonomous inbound reply, or autonomous calendar booking is permitted. They
 * are 100% deterministic: every gate is plain app logic reading injected
 * settings/repos/config. NO LLM call happens here, and the LLM must NEVER
 * influence these gates — an agent only supplies already-parsed facts (e.g. a
 * classification category/confidence) that the rules then evaluate.
 *
 * Design rules:
 *  - These are ADDITIVE to the existing draft/approval flow (`gates.ts`); they
 *    do not replace or weaken it. They only authorize the *autonomous* path.
 *  - Each service collects ALL failing reasons (no short-circuit) EXCEPT kill
 *    switches, which short-circuit immediately (a paused system stops cold).
 *  - Every default is conservative; a missing setting denies rather than allows.
 */

import {
  EmailAutonomyMode,
  CalendarAutonomyMode,
  type ComplianceReview,
  type PolicyDecision,
  allowed,
  denied,
  combine,
} from '@app/shared';
import type { SettingsReader } from './settings.js';
import type { CapRepo } from './types.js';
import { isValidEmail, extractDomain, normalizeEmail } from './email.js';
import { isValidIanaTimezone, isWithinBusinessHours } from './business-hours.js';

// ---------------------------------------------------------------------------
// Shared dependency / config shapes
// ---------------------------------------------------------------------------

/** Subset of `Config` the email policy services read. */
export interface EmailPolicyConfig {
  /** Env master flag: autonomous sending is enabled at the deployment level. */
  ENABLE_AUTO_SEND: boolean;
  /**
   * MASTER SEND SWITCH (`SENDING_ENABLED`). OPTIONAL for backward compatibility:
   * when omitted it is treated as OFF (fail-safe), so any path that does NOT yet
   * pass it in is denied on the switch-gated flows (inbound reply / calendar).
   * The workflows round MUST pass the real `config.sendingEnabled` here.
   */
  sendingEnabled?: boolean;
}

/** Subset of `Config` the calendar policy services read. */
export interface CalendarPolicyConfig {
  /** Env master flag: autonomous scheduling is enabled at the deployment level. */
  ENABLE_AUTO_SCHEDULING: boolean;
  /**
   * MASTER SEND SWITCH (`SENDING_ENABLED`). OPTIONAL for backward compatibility:
   * when omitted it is treated as OFF (fail-safe). Calendar creation is an
   * autonomous EXTERNAL action, so the master send switch must also stop it.
   * The workflows round MUST pass the real `config.sendingEnabled` here.
   */
  sendingEnabled?: boolean;
}

/** Injected dependencies for the email policy services. */
export interface EmailPolicyDeps {
  settings: SettingsReader;
  caps: CapRepo;
  config: EmailPolicyConfig;
  /** Defaults to `new Date()`; injectable for deterministic tests. */
  now?: Date;
}

/** Injected dependencies for the calendar policy services. */
export interface CalendarPolicyDeps {
  settings: SettingsReader;
  caps: CapRepo;
  config: CalendarPolicyConfig;
  /** Defaults to `new Date()`; injectable for deterministic tests. */
  now?: Date;
}

const MINUTE_MS = 60 * 1000;

/** True if the compliance review verdict is an approving one. */
function complianceApproved(decision: string): boolean {
  return decision === 'pass' || decision === 'approve';
}

// ---------------------------------------------------------------------------
// 1 & 2. Autonomous OUTBOUND email
// ---------------------------------------------------------------------------

/** Facts about a candidate autonomous OUTBOUND send. */
export interface AutoSendInput {
  /** Sending account address. */
  senderEmail: string;
  /** Whether the sending account row is active (not paused). */
  senderActive: boolean;
  /** Recipient/prospect address. */
  recipientEmail: string;
  /** Whether a prospect record exists for the recipient. */
  prospectExists: boolean;

  /** Suppression checks (caller resolves against the suppression list). */
  emailSuppressed: boolean;
  domainSuppressed: boolean;
  /** Prospect previously unsubscribed. */
  unsubscribed: boolean;
  /** Thread already contains a negative reply. */
  negativeReply: boolean;
  /** Thread carries an angry/complaint/legal/security/pricing/procurement flag. */
  threadHasSensitiveFlag: boolean;

  /** Research lifecycle status (e.g. 'researched' | 'approved' | ...). */
  researchStatus: string;
  /** Research confidence in [0,1]. */
  researchConfidence: number;

  /** Parsed LLM compliance review (decision + confidence). */
  complianceReview: Pick<ComplianceReview, 'decision' | 'confidence'>;

  /** CAN-SPAM footer / unsubscribe is present in the body (when applicable). */
  footerPresent: boolean;
  /** Subject line. */
  subject: string;
  /** Caller's heuristic flag that the subject is deceptive. */
  subjectDeceptive?: boolean;
  /** Claims in the body not supported by research. */
  unsupportedClaims: string[];

  /** Sequence + step identity for per-prospect-per-sequence and step caps. */
  prospectId: string;
  sequenceId?: string;
  /** This exact sequence step was already sent to this prospect. */
  stepAlreadySent?: boolean;
  /** Count of autonomous sends already made to this prospect in this sequence. */
  prospectSequenceSends: number;

  /** Idempotency: this exact send already went out. */
  alreadySent?: boolean;

  /** Instant the send would occur (ISO-8601); defaults to deps.now. */
  sendAtIso?: string;
}

/** ALL-CAPS spammy subject heuristic (kept intentionally simple). */
function isSpammyAllCaps(subject: string): boolean {
  const letters = subject.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 6) return false;
  return letters === letters.toUpperCase();
}

/**
 * Deterministic verdict on whether an OUTBOUND email may be sent autonomously.
 * Kill switches short-circuit; every other failing gate is collected.
 */
export function canAutoSendOutboundEmail(
  input: AutoSendInput,
  deps: EmailPolicyDeps,
): PolicyDecision {
  const { settings, config } = deps;
  const now = deps.now ?? new Date();
  const nowIso = input.sendAtIso ?? now.toISOString();

  // --- Kill switches (short-circuit) ---
  const recipientDomain = extractDomain(input.recipientEmail) ?? '';
  const sender = normalizeEmail(input.senderEmail);
  const pausedSenders = settings.strArray('pauseSpecificSenderAccounts').map((s) =>
    s.trim().toLowerCase(),
  );
  const pausedDomains = settings.strArray('pauseSpecificDomains').map((d) =>
    d.trim().toLowerCase(),
  );
  const killReasons: string[] = [];
  if (settings.bool('globalPauseAllAutomation'))
    killReasons.push('kill switch: globalPauseAllAutomation is on');
  if (settings.bool('pauseOutboundSending'))
    killReasons.push('kill switch: pauseOutboundSending is on');
  if (pausedSenders.includes(sender))
    killReasons.push(`kill switch: sender ${sender} is paused`);
  if (recipientDomain && pausedDomains.includes(recipientDomain))
    killReasons.push(`kill switch: domain ${recipientDomain} is paused`);
  if (killReasons.length > 0) return denied(...killReasons);

  const reasons: string[] = [];

  // --- Mode + env gate ---
  if (settings.emailAutonomyMode() !== EmailAutonomyMode.LIMITED_AUTO_SEND)
    reasons.push(
      `email autonomy mode is not limited_auto_send (is ${settings.emailAutonomyMode()})`,
    );
  if (config.ENABLE_AUTO_SEND !== true)
    reasons.push('ENABLE_AUTO_SEND env flag is off');

  // --- Prospect / recipient validity ---
  if (!input.prospectExists) reasons.push('no prospect record');
  if (!isValidEmail(input.recipientEmail)) reasons.push('recipient email is not valid');

  // --- Suppression / opt-out / negative / sensitive ---
  if (input.emailSuppressed) reasons.push('recipient email is suppressed');
  if (input.domainSuppressed) reasons.push('recipient domain is suppressed');
  if (input.unsubscribed) reasons.push('prospect previously unsubscribed');
  if (input.negativeReply) reasons.push('thread has a negative reply');
  if (input.threadHasSensitiveFlag)
    reasons.push('thread carries an angry/complaint/legal/security/pricing/procurement flag');

  // --- Research ---
  const researchOk =
    input.researchStatus === 'researched' || input.researchStatus === 'approved';
  if (!researchOk)
    reasons.push(`research status not complete/approved (is ${input.researchStatus})`);
  if (input.researchConfidence < settings.num('researchConfidenceThreshold'))
    reasons.push(
      `research confidence ${input.researchConfidence} < threshold ${settings.num('researchConfidenceThreshold')}`,
    );

  // --- Compliance review ---
  if (!complianceApproved(input.complianceReview.decision))
    reasons.push(`compliance review decision is ${input.complianceReview.decision}`);
  if (input.complianceReview.confidence < settings.num('complianceConfidenceThreshold'))
    reasons.push(
      `compliance confidence ${input.complianceReview.confidence} < threshold ${settings.num('complianceConfidenceThreshold')}`,
    );

  // --- Content / identity quality ---
  if (!input.footerPresent) reasons.push('footer/unsubscribe not present');
  if (!input.subject || input.subject.trim().length === 0)
    reasons.push('subject is empty');
  if (input.subjectDeceptive === true) reasons.push('subject flagged deceptive');
  if (isSpammyAllCaps(input.subject)) reasons.push('subject is all-caps / spammy');
  if (input.unsupportedClaims.length > 0)
    reasons.push(`subject/body has ${input.unsupportedClaims.length} unsupported claim(s)`);
  if (input.senderActive !== true) reasons.push('sending account is not active');

  // --- Readiness (ALL flags confirmed) ---
  if (!settings.readinessAllReady())
    reasons.push('compliance/deliverability readiness not fully confirmed');

  // --- Step / sequence dedupe ---
  if (input.stepAlreadySent === true)
    reasons.push('prospect already received this sequence step');
  if (input.prospectSequenceSends >= settings.num('maxAutoSendsPerProspectPerSequence'))
    reasons.push(
      `per-prospect-per-sequence cap reached (${input.prospectSequenceSends}/${settings.num('maxAutoSendsPerProspectPerSequence')})`,
    );

  // --- Quiet hours / business hours ---
  if (!isWithinBusinessHours(nowIso, settings.businessHours()))
    reasons.push('outside configured business hours');

  // --- Idempotency ---
  if (input.alreadySent === true) reasons.push('idempotency: send already occurred');

  return reasons.length === 0 ? allowed() : denied(...reasons);
}

/**
 * Async cap checks for an autonomous send (global/sender/domain/day +
 * min-minutes-between-sends). Split out so the synchronous content gates and the
 * DB-backed counts are clearly separated.
 */
export async function checkAutoSendCaps(
  input: Pick<AutoSendInput, 'senderEmail' | 'recipientEmail'>,
  deps: EmailPolicyDeps,
): Promise<PolicyDecision> {
  const { settings, caps } = deps;
  const now = deps.now ?? new Date();
  const sender = normalizeEmail(input.senderEmail);
  const domain = extractDomain(input.recipientEmail) ?? '';

  const [global, senderCount, domainCount, lastAt] = await Promise.all([
    caps.countGlobalSentToday(),
    caps.countSenderSentToday(sender),
    domain ? caps.countDomainSentToday(domain) : Promise.resolve(0),
    caps.lastSenderSendAt(sender),
  ]);

  const reasons: string[] = [];
  if (global >= settings.num('maxAutoSendsPerDayGlobal'))
    reasons.push(`global daily auto-send cap reached (${global}/${settings.num('maxAutoSendsPerDayGlobal')})`);
  if (senderCount >= settings.num('maxAutoSendsPerSenderPerDay'))
    reasons.push(
      `per-sender daily auto-send cap reached (${senderCount}/${settings.num('maxAutoSendsPerSenderPerDay')})`,
    );
  if (domain && domainCount >= settings.num('maxAutoSendsPerDomainPerDay'))
    reasons.push(
      `per-domain daily auto-send cap reached for ${domain} (${domainCount}/${settings.num('maxAutoSendsPerDomainPerDay')})`,
    );

  const minMinutes = settings.num('minMinutesBetweenAutoSendsPerSender');
  if (lastAt) {
    const elapsedMin = (now.getTime() - lastAt.getTime()) / MINUTE_MS;
    if (elapsedMin < minMinutes)
      reasons.push(
        `min minutes between sends not met for ${sender} (${elapsedMin.toFixed(1)} < ${minMinutes})`,
      );
  }

  return reasons.length === 0 ? allowed() : denied(...reasons);
}

/**
 * Full gate + caps verdict for an autonomous send. Combines the synchronous
 * content gates with the async cap checks.
 */
export async function canAutoSendOutboundEmailWithCaps(
  input: AutoSendInput,
  deps: EmailPolicyDeps,
): Promise<PolicyDecision> {
  const gates = canAutoSendOutboundEmail(input, deps);
  const capDec = await checkAutoSendCaps(input, deps);
  return combine(gates, capDec);
}

/**
 * Final pre-flight re-check immediately before an autonomous send actually
 * goes out: `canAutoSendOutboundEmailWithCaps` PLUS a re-check of the most
 * time-sensitive gates (kill switches, min-minutes-between-sends, idempotency).
 */
export async function canSendNow(
  input: AutoSendInput,
  deps: EmailPolicyDeps,
): Promise<PolicyDecision> {
  const base = await canAutoSendOutboundEmailWithCaps(input, deps);

  const { settings } = deps;
  const recheck: string[] = [];

  // Kill switches re-checked at the last moment.
  if (settings.bool('globalPauseAllAutomation'))
    recheck.push('kill switch: globalPauseAllAutomation is on (final re-check)');
  if (settings.bool('pauseOutboundSending'))
    recheck.push('kill switch: pauseOutboundSending is on (final re-check)');

  // Paused-list kill switches re-checked at the last moment, using the SAME
  // normalized sender/domain lookup as canAutoSendOutboundEmail().
  const sender = normalizeEmail(input.senderEmail);
  const recipientDomain = extractDomain(input.recipientEmail) ?? '';
  const pausedSenders = settings
    .strArray('pauseSpecificSenderAccounts')
    .map((s) => s.trim().toLowerCase());
  const pausedDomains = settings
    .strArray('pauseSpecificDomains')
    .map((d) => d.trim().toLowerCase());
  if (pausedSenders.includes(sender))
    recheck.push(`kill switch: sender ${sender} is paused (final re-check)`);
  if (recipientDomain && pausedDomains.includes(recipientDomain))
    recheck.push(`kill switch: domain ${recipientDomain} is paused (final re-check)`);

  // Time-sensitive min-minutes re-check.
  const minMinutes = settings.num('minMinutesBetweenAutoSendsPerSender');
  const lastAt = await deps.caps.lastSenderSendAt(sender);
  if (lastAt) {
    const now = deps.now ?? new Date();
    const elapsedMin = (now.getTime() - lastAt.getTime()) / MINUTE_MS;
    if (elapsedMin < minMinutes)
      recheck.push('min minutes between sends not met (final re-check)');
  }

  // Idempotency re-check.
  if (input.alreadySent === true)
    recheck.push('idempotency: send already occurred (final re-check)');

  return combine(base, recheck.length === 0 ? allowed() : denied(...recheck));
}

// ---------------------------------------------------------------------------
// 3. Autonomous INBOUND reply
// ---------------------------------------------------------------------------

/** Facts about a candidate autonomous INBOUND reply. */
export interface AutoReplyInput {
  /** Thread the reply would be appended to. */
  threadId: string;
  /**
   * Thread carries an angry/complaint/legal/security/pricing/procurement flag.
   * The caller MUST pass the REAL classification-derived value (not a hardcoded
   * false); this gate denies the auto-reply when true.
   */
  threadHasSensitiveFlag: boolean;
  /**
   * Inbound message is an unsubscribe/opt-out request. The caller MUST pass the
   * REAL value; this gate denies the auto-reply when true.
   */
  isUnsubscribe: boolean;
  /**
   * Instant the reply would be sent (ISO-8601); defaults to deps.now. An
   * auto-reply is a REAL send, so it is subject to the SAME business-hours gate
   * as an outbound send.
   */
  sendAtIso?: string;
}

/**
 * Deterministic verdict on whether an INBOUND auto-reply is permitted.
 * Kill switches short-circuit; the per-thread daily cap is collected.
 */
export async function canAutoReplyInboundEmail(
  input: AutoReplyInput,
  deps: EmailPolicyDeps,
): Promise<PolicyDecision> {
  const { settings, caps, config } = deps;
  const now = deps.now ?? new Date();
  const nowIso = input.sendAtIso ?? now.toISOString();

  // --- Kill switches (short-circuit) ---
  const killReasons: string[] = [];
  if (settings.bool('globalPauseAllAutomation'))
    killReasons.push('kill switch: globalPauseAllAutomation is on');
  if (settings.bool('pauseInboundReplies'))
    killReasons.push('kill switch: pauseInboundReplies is on');
  if (killReasons.length > 0) return denied(...killReasons);

  const reasons: string[] = [];

  // --- Master send switch (SENDING_ENABLED) ---
  // An auto-reply is a REAL send; the master switch must stop it. Optional +
  // fail-safe: an unset (undefined) value is treated as OFF.
  if (config.sendingEnabled !== true)
    reasons.push('SENDING_ENABLED master switch is off');

  if (settings.emailAutonomyMode() !== EmailAutonomyMode.LIMITED_AUTO_SEND)
    reasons.push(
      `email autonomy mode is not limited_auto_send (is ${settings.emailAutonomyMode()})`,
    );
  if (config.ENABLE_AUTO_SEND !== true)
    reasons.push('ENABLE_AUTO_SEND env flag is off');

  if (input.threadHasSensitiveFlag)
    reasons.push('thread carries an angry/sensitive (pricing/legal/security/procurement) flag');
  if (input.isUnsubscribe) reasons.push('inbound message is an unsubscribe request');

  // --- Business hours (an auto-reply is a real send) ---
  if (!isWithinBusinessHours(nowIso, settings.businessHours()))
    reasons.push('outside configured business hours');

  const replies = await caps.countThreadAutoRepliesToday(input.threadId);
  if (replies >= settings.num('maxAutoRepliesPerThreadPerDay'))
    reasons.push(
      `per-thread daily auto-reply cap reached (${replies}/${settings.num('maxAutoRepliesPerThreadPerDay')})`,
    );

  return reasons.length === 0 ? allowed() : denied(...reasons);
}

// ---------------------------------------------------------------------------
// 4 & 5. Autonomous CALENDAR booking
// ---------------------------------------------------------------------------

/** Facts about a candidate autonomous calendar event. */
export interface AutoCalendarInput {
  /** Inbound message is from the prospect/contact. */
  fromIsProspect: boolean;
  /** Inbound classification (category + confidence). */
  classification: { category: string; confidence: number };
  /** Recipient explicitly agreed to a specific date/time or selected a slot. */
  explicitSlotAgreement: boolean;

  /** IANA timezone for the event. */
  timezone: string;
  /** The timezone is ambiguous (e.g. "ET" with DST/region uncertainty). */
  timezoneAmbiguous: boolean;

  /** Availability was checked immediately before booking. */
  availabilityCheckedAt?: string;
  /** The slot is still free as of the check. */
  slotStillFree: boolean;

  /** Event start/end as ISO-8601 datetimes. */
  startIso: string;
  endIso: string;

  /** Attendee emails for the event. */
  attendees: string[];
  /** External attendees that must be a subset of thread participants. */
  externalAttendees: string[];
  /** Known thread participants (the allowed external-attendee set). */
  threadParticipants: string[];

  /** Pricing/legal/security/procurement/contractual flags present in thread. */
  sensitiveFlags: string[];
  /** Thread is angry. */
  angry?: boolean;
  /** Inbound carried an unsubscribe intent. */
  unsubscribe?: boolean;

  /** Idempotency: an equivalent event already exists. */
  alreadyExists?: boolean;
}

/** Freshness window (minutes) for the availability check before booking. */
const AVAILABILITY_FRESHNESS_MIN = 10;

/**
 * Deterministic verdict on whether a calendar event may be auto-created.
 * Kill switches short-circuit; every other failing gate is collected.
 */
export function canAutoCreateCalendarEvent(
  input: AutoCalendarInput,
  deps: CalendarPolicyDeps,
): PolicyDecision {
  const { settings, config } = deps;
  const now = deps.now ?? new Date();

  // --- Kill switches (short-circuit) ---
  const killReasons: string[] = [];
  if (settings.bool('globalPauseAllAutomation'))
    killReasons.push('kill switch: globalPauseAllAutomation is on');
  if (settings.bool('pauseCalendarCreation'))
    killReasons.push('kill switch: pauseCalendarCreation is on');
  if (killReasons.length > 0) return denied(...killReasons);

  const reasons: string[] = [];

  // --- Master send switch (SENDING_ENABLED) ---
  // Calendar creation is an autonomous EXTERNAL action; the master send switch
  // must also stop it. Optional + fail-safe: unset (undefined) is treated OFF.
  if (config.sendingEnabled !== true)
    reasons.push('SENDING_ENABLED master switch is off');

  // --- Mode + env ---
  if (settings.calendarAutonomyMode() !== CalendarAutonomyMode.AUTO_BOOK_CONFIRMED)
    reasons.push(
      `calendar autonomy mode is not auto_book_confirmed (is ${settings.calendarAutonomyMode()})`,
    );
  if (config.ENABLE_AUTO_SCHEDULING !== true)
    reasons.push('ENABLE_AUTO_SCHEDULING env flag is off');

  // --- Provenance + intent ---
  if (input.fromIsProspect !== true) reasons.push('inbound is not from the prospect/contact');
  if (input.classification.category !== 'interested_schedule')
    reasons.push(`classification category is ${input.classification.category}, not interested_schedule`);
  if (input.classification.confidence < settings.num('calendarConfidenceThreshold'))
    reasons.push(
      `classification confidence ${input.classification.confidence} < threshold ${settings.num('calendarConfidenceThreshold')}`,
    );
  if (input.explicitSlotAgreement !== true)
    reasons.push('no explicit agreement to a specific date/time or slot');

  // --- Timezone ---
  if (!isValidIanaTimezone(input.timezone))
    reasons.push(`timezone is not a valid IANA zone (${input.timezone})`);
  if (input.timezoneAmbiguous === true) reasons.push('timezone is ambiguous');

  // --- Availability ---
  if (input.availabilityCheckedAt) {
    const checked = new Date(input.availabilityCheckedAt);
    if (Number.isNaN(checked.getTime())) {
      reasons.push('availability check timestamp is invalid');
    } else {
      const ageMin = (now.getTime() - checked.getTime()) / MINUTE_MS;
      if (ageMin > AVAILABILITY_FRESHNESS_MIN || ageMin < -1)
        reasons.push('availability not checked immediately before booking');
    }
  } else {
    reasons.push('availability was not checked before booking');
  }
  if (input.slotStillFree !== true) reasons.push('slot is no longer free');

  // --- Datetime validity + duration ---
  const start = new Date(input.startIso);
  const end = new Date(input.endIso);
  const startValid = !Number.isNaN(start.getTime());
  const endValid = !Number.isNaN(end.getTime());
  if (!startValid) reasons.push('event start is not a valid ISO datetime');
  if (!endValid) reasons.push('event end is not a valid ISO datetime');
  if (startValid && endValid) {
    if (end.getTime() <= start.getTime()) {
      reasons.push('event end must be after start');
    } else {
      const durationMin = (end.getTime() - start.getTime()) / MINUTE_MS;
      if (durationMin < 15 || durationMin > 60)
        reasons.push(`event duration ${durationMin} min out of 15-60 range`);
    }
  }

  // --- Business hours (start AND end) ---
  // The business-hours window is half-open [start, end), so an event ending
  // exactly at `businessHoursEnd` (e.g. 16:30-17:00) must still be allowed.
  // Validate the end using an exclusive instant one millisecond before `end`
  // so end-exactly-at-close passes; the start check stays inclusive.
  const hours = settings.businessHours();
  if (startValid && !isWithinBusinessHours(input.startIso, hours))
    reasons.push('event start is outside business hours');
  if (endValid) {
    const endExclusiveIso = new Date(end.getTime() - 1).toISOString();
    if (!isWithinBusinessHours(endExclusiveIso, hours))
      reasons.push('event end is outside business hours');
  }

  // --- Attendees ---
  const invalidAttendees = input.attendees.filter((a) => !isValidEmail(a));
  if (invalidAttendees.length > 0)
    reasons.push(`invalid attendee email(s): ${invalidAttendees.join(', ')}`);
  const participantSet = new Set(input.threadParticipants.map((p) => normalizeEmail(p)));
  const strayExternal = input.externalAttendees.filter(
    (a) => !participantSet.has(normalizeEmail(a)),
  );
  if (strayExternal.length > 0)
    reasons.push(`external attendee(s) not in thread: ${strayExternal.join(', ')}`);

  // --- Sensitivity / sentiment ---
  if (input.sensitiveFlags.length > 0)
    reasons.push(`thread has sensitive flags: ${input.sensitiveFlags.join(', ')}`);
  if (input.angry === true) reasons.push('thread is angry/complaint');
  if (input.unsubscribe === true) reasons.push('inbound carried an unsubscribe intent');

  // --- Idempotency ---
  if (input.alreadyExists === true) reasons.push('idempotency: event already exists');

  return reasons.length === 0 ? allowed() : denied(...reasons);
}

/** Async cap check for calendar creation (events/day). */
export async function checkCalendarCap(deps: CalendarPolicyDeps): Promise<PolicyDecision> {
  const { settings, caps } = deps;
  const count = await caps.countCalendarEventsToday();
  if (count >= settings.num('maxCalendarEventsPerDay'))
    return denied(
      `daily calendar event cap reached (${count}/${settings.num('maxCalendarEventsPerDay')})`,
    );
  return allowed();
}

/**
 * Full gate + cap verdict for an autonomous calendar event (the synchronous
 * gates plus the events/day cap).
 */
export async function canAutoCreateCalendarEventWithCap(
  input: AutoCalendarInput,
  deps: CalendarPolicyDeps,
): Promise<PolicyDecision> {
  const gates = canAutoCreateCalendarEvent(input, deps);
  const cap = await checkCalendarCap(deps);
  return combine(gates, cap);
}

/**
 * Final pre-flight re-check immediately before booking:
 * `canAutoCreateCalendarEventWithCap` PLUS a re-check of the time-sensitive
 * gates (kill switches, slotStillFree, alreadyExists, events/day cap).
 */
export async function canBookNow(
  input: AutoCalendarInput,
  deps: CalendarPolicyDeps,
): Promise<PolicyDecision> {
  const base = await canAutoCreateCalendarEventWithCap(input, deps);

  const { settings } = deps;
  const recheck: string[] = [];
  if (settings.bool('globalPauseAllAutomation'))
    recheck.push('kill switch: globalPauseAllAutomation is on (final re-check)');
  if (settings.bool('pauseCalendarCreation'))
    recheck.push('kill switch: pauseCalendarCreation is on (final re-check)');
  if (input.slotStillFree !== true) recheck.push('slot is no longer free (final re-check)');
  if (input.alreadyExists === true)
    recheck.push('idempotency: event already exists (final re-check)');

  const capRecheck = await checkCalendarCap(deps);

  return combine(base, recheck.length === 0 ? allowed() : denied(...recheck), capRecheck);
}
