/** System settings routes: list and update one by key (e.g. auto_send_enabled). */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ValidationError,
  EmailAutonomyMode,
  CalendarAutonomyMode,
} from '@app/shared';
import type { AppContext } from '../context.js';
import { getSetting, listSettings, setSetting } from '../services.js';

// Reusable value schemas for the autonomy catalog (see @app/shared autonomy.ts).
const NonNegInt = z.number().int().nonnegative();
const Threshold = z.number().min(0).max(1);
const Hour = z.number().int().min(0).max(23);
const EmailList = z.array(z.string().email());
const DomainList = z.array(z.string().min(1));

// A valid IANA timezone string: rejects empties / values Intl can't resolve.
const Timezone = z.string().refine(
  (tz) => {
    try {
      // Throws a RangeError for an unknown/invalid IANA zone.
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid IANA timezone' },
);

// Allow-list of writable settings + the value schema each accepts. Covers the
// original `*_enabled`/cap toggles PLUS every controlled-autonomy SystemSetting
// key from `AUTONOMY_SETTINGS` (modes, caps/thresholds, business hours, kill
// switches, readiness flags). Unknown key or wrong value type → 400.
const SettingSchemas = {
  // --- Legacy / existing settings (kept; additive) ---
  auto_send_enabled: z.boolean(),
  sending_enabled: z.boolean(),
  daily_send_cap: NonNegInt,
  per_inbox_daily_cap: NonNegInt,
  per_domain_daily_cap: NonNegInt,
  sequence_max_steps: NonNegInt,

  // --- Autonomy modes ---
  emailAutonomyMode: z.nativeEnum(EmailAutonomyMode),
  calendarAutonomyMode: z.nativeEnum(CalendarAutonomyMode),

  // --- Sending / scheduling caps (non-negative ints) ---
  maxAutoSendsPerDayGlobal: NonNegInt,
  maxAutoSendsPerSenderPerDay: NonNegInt,
  maxAutoSendsPerDomainPerDay: NonNegInt,
  maxAutoSendsPerProspectPerSequence: NonNegInt,
  minMinutesBetweenAutoSendsPerSender: NonNegInt,
  maxAutoRepliesPerThreadPerDay: NonNegInt,
  maxCalendarEventsPerDay: NonNegInt,

  // --- Confidence thresholds (0..1) ---
  researchConfidenceThreshold: Threshold,
  complianceConfidenceThreshold: Threshold,
  calendarConfidenceThreshold: Threshold,

  // --- Business hours ---
  businessHoursStart: Hour,
  businessHoursEnd: Hour,
  businessTimezone: Timezone,

  // --- Kill switches (booleans + the two pause lists) ---
  globalPauseAllAutomation: z.boolean(),
  pauseOutboundSending: z.boolean(),
  pauseInboundReplies: z.boolean(),
  pauseCalendarCreation: z.boolean(),
  pauseSpecificSenderAccounts: EmailList,
  pauseSpecificDomains: DomainList,

  // --- Readiness flags (booleans) ---
  spfDkimDmarcReady: z.boolean(),
  physicalAddressConfigured: z.boolean(),
  unsubscribeConfigured: z.boolean(),
  suppressionListActive: z.boolean(),
  senderIdentityConfigured: z.boolean(),
  replyToValid: z.boolean(),
  bounceHandlingConfigured: z.boolean(),
  postmasterMonitoring: z.boolean(),
} as const;

type SettingKey = keyof typeof SettingSchemas;

/** Type guard: is `key` one of the writable, allow-listed setting keys? */
function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SettingSchemas, key);
}

const PutBody = z.object({ value: z.unknown() });

/** Register the settings routes: list all settings and update one by key. */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /settings — list all system settings (sorted by key).
  app.get('/settings', async () => listSettings(ctx.prisma));

  // GET /settings/:key — fetch one setting by key (404 if no row exists).
  app.get('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    return getSetting(ctx.prisma, key);
  });

  // PUT /settings/:key — validate and upsert one allow-listed setting value.
  app.put('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    if (!isSettingKey(key)) {
      throw new ValidationError(`unknown setting key: ${key}`, { key });
    }
    // CR FIX: safeParse the envelope so a malformed body surfaces as a 400
    // ValidationError instead of a raw ZodError → 500.
    const body = PutBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError('invalid request body', { issues: body.error.issues });
    }
    const parsed = SettingSchemas[key].safeParse(body.data.value);
    if (!parsed.success) {
      throw new ValidationError(`invalid value for setting "${key}"`, {
        key,
        issues: parsed.error.issues,
      });
    }
    return setSetting(ctx.prisma, key, parsed.data);
  });
}
