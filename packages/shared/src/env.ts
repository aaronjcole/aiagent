import { z } from 'zod';

/**
 * Coerce common string representations of booleans. Defaults are applied by the
 * caller via `.default(...)`; this only handles parsing of a provided string.
 */
const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

/** Coerce a numeric env string into a non-negative integer with a default. */
const intFromString = (def: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative())
    .default(def);

/** Zod schema validating and defaulting all runtime configuration. */
export const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Database
  databaseUrl: z.string().default('postgresql://localhost:5432/aiagent'),

  // Temporal
  temporalAddress: z.string().default('localhost:7233'),

  // LLM
  llmProvider: z.enum(['mock', 'openai', 'anthropic']).default('mock'),
  openaiApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiModel: z.string().default('gpt-4o-mini'),
  anthropicModel: z.string().default('claude-3-5-sonnet-latest'),

  // Email
  emailProvider: z.enum(['mock', 'gmail']).default('mock'),
  gmailClientId: z.string().optional(),
  gmailClientSecret: z.string().optional(),
  gmailRefreshToken: z.string().optional(),
  gmailRedirectUri: z.string().optional(),
  gmailUser: z.string().optional(),

  // Calendar
  calendarProvider: z.enum(['mock', 'google']).default('mock'),
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  googleRefreshToken: z.string().optional(),
  googleRedirectUri: z.string().optional(),
  googleCalendarId: z.string().default('primary'),

  // Research
  researchProvider: z.enum(['mock', 'live']).default('mock'),

  // Safety gates — default OFF
  autoSendEnabled: boolFromString.default(false),
  sendingEnabled: boolFromString.default(false),
  // Controlled-autonomy master env flags — default OFF. These are env-level
  // enablers that must ALSO be on (alongside the SystemSetting modes) before any
  // autonomous send / booking can occur. They are additive to and independent
  // of the legacy `sendingEnabled`/`autoSendEnabled` switches.
  enableAutoSend: boolFromString.default(false),
  enableAutoScheduling: boolFromString.default(false),
  dailySendCap: intFromString(200),
  perInboxDailyCap: intFromString(50),
  perDomainDailyCap: intFromString(10),
  sequenceMaxSteps: intFromString(5),
  // Per-prospect lifetime (all-time, all-sequence) send cap. <= 0 means unlimited.
  perProspectMaxSends: intFromString(5),

  // Sender identity / compliance footer
  defaultFromEmail: z.string().default('outreach@example.com'),
  defaultFromName: z.string().default('Outreach Team'),
  companyAddress: z.string().default('123 Example St, City, ST 00000, USA'),
  unsubscribeBaseUrl: z.string().default('https://example.com/unsubscribe'),
  // Secret used to sign/verify one-click unsubscribe tokens. No default: when
  // unset, the unsubscribe endpoint falls back to non-signed (email=) links.
  unsubscribeTokenSecret: z.string().optional(),

  // API auth
  // Shared bearer secret for authenticating API requests. No default: when
  // unset, the API layer (wired in a later round) treats the deployment as
  // having NO configured credential. Secret — redacted before logging.
  apiAuthToken: z.string().optional(),

  // Services
  apiPort: intFromString(3001),
  adminPort: intFromString(3000),
});

/** Fully parsed, typed application configuration. */
export type Config = z.infer<typeof ConfigSchema>;

/** Keys in Config that hold secret values and must be redacted before logging. */
const SECRET_KEYS: readonly (keyof Config)[] = [
  'databaseUrl',
  'openaiApiKey',
  'anthropicApiKey',
  'gmailClientSecret',
  'gmailRefreshToken',
  'googleClientSecret',
  'googleRefreshToken',
  'unsubscribeTokenSecret',
  'apiAuthToken',
];

/**
 * Parse `process.env` (or an injected source) into a typed, defaulted Config.
 * Throws a ZodError if a provided value is invalid (e.g. unknown provider).
 * Missing values fall back to safe defaults; sending/auto-send default to false.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    temporalAddress: env.TEMPORAL_ADDRESS,

    llmProvider: env.LLM_PROVIDER,
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    anthropicModel: env.ANTHROPIC_MODEL,

    emailProvider: env.EMAIL_PROVIDER,
    gmailClientId: env.GMAIL_CLIENT_ID,
    gmailClientSecret: env.GMAIL_CLIENT_SECRET,
    gmailRefreshToken: env.GMAIL_REFRESH_TOKEN,
    gmailRedirectUri: env.GMAIL_REDIRECT_URI,
    gmailUser: env.GMAIL_USER,

    calendarProvider: env.CALENDAR_PROVIDER,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: env.GOOGLE_REFRESH_TOKEN,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI,
    googleCalendarId: env.GOOGLE_CALENDAR_ID,

    researchProvider: env.RESEARCH_PROVIDER,

    autoSendEnabled: env.AUTO_SEND_ENABLED,
    sendingEnabled: env.SENDING_ENABLED,
    enableAutoSend: env.ENABLE_AUTO_SEND,
    enableAutoScheduling: env.ENABLE_AUTO_SCHEDULING,
    dailySendCap: env.DAILY_SEND_CAP,
    perInboxDailyCap: env.PER_INBOX_DAILY_CAP,
    perDomainDailyCap: env.PER_DOMAIN_DAILY_CAP,
    sequenceMaxSteps: env.SEQUENCE_MAX_STEPS,
    perProspectMaxSends: env.PER_PROSPECT_MAX_SENDS,

    defaultFromEmail: env.DEFAULT_FROM_EMAIL,
    defaultFromName: env.DEFAULT_FROM_NAME,
    companyAddress: env.COMPANY_ADDRESS,
    unsubscribeBaseUrl: env.UNSUBSCRIBE_BASE_URL,
    unsubscribeTokenSecret: env.UNSUBSCRIBE_TOKEN_SECRET,

    apiAuthToken: env.API_AUTH_TOKEN,

    apiPort: env.API_PORT,
    adminPort: env.ADMIN_PORT,
  });
}

/**
 * Return a shallow copy of a Config with all secret values replaced by a
 * presence indicator. Safe to log. Never returns the secret value itself.
 */
export function redactedConfig(config: Config): Record<keyof Config, unknown> {
  const out = { ...config } as Record<keyof Config, unknown>;
  for (const key of SECRET_KEYS) {
    const val = config[key];
    out[key] = val === undefined || val === '' ? '[UNSET]' : '[REDACTED]';
  }
  return out;
}
