/**
 * `Deps` — the injected dependency bundle every service function receives. This
 * is the seam that makes the real orchestration logic fully unit-testable: a
 * service performs all of its side effects and decisions through `Deps`, so a
 * test can pass in-memory fakes (a fake prisma, the Mock providers, a mock
 * `LlmClient`) with no Temporal, no real DB, and no network.
 *
 * The Temporal activity layer builds a real `Deps` via {@link createDeps}.
 */

import { createLlmClient, type LlmClient } from '@app/llm';
import { createEmailProvider, type EmailProvider } from '@app/email';
import { createCalendarProvider, type CalendarProvider } from '@app/calendar';
import type { PrismaClient } from '@app/db';
import { createLogger, loadConfig, type Config, type Logger } from '@app/shared';
import {
  createLiveSettingsReader,
  createCapRepo,
  reserveAutoAction,
  type SettingsReader,
  type CapRepo,
  type ReserveArgs,
  type ReserveResult,
} from '@app/compliance';
import { createResearchProvider, type ResearchProvider } from './providers/research.js';

/** A monotonic clock; injected so timestamps are deterministic in tests. */
export type Clock = () => Date;

/**
 * The dependency bundle. `prisma` is the full Prisma client in production;
 * tests pass a structural subset (only the delegates a given service touches),
 * cast to {@link PrismaClient} via {@link asPrisma}.
 */
export interface Deps {
  prisma: PrismaClient;
  llmClient: LlmClient;
  email: EmailProvider;
  calendar: CalendarProvider;
  research: ResearchProvider;
  config: Config;
  logger: Logger;
  clock: Clock;
  /**
   * Deterministic controlled-autonomy settings reader (autonomy modes, caps,
   * kill switches, readiness flags). Read once from `SystemSetting`; the policy
   * layer consults it to decide whether an autonomous action is permitted. The
   * LLM never reads or writes these.
   */
  settings: SettingsReader;
  /** Rolling 24h cap counts for the controlled-autonomy policy layer. */
  caps: CapRepo;
  /**
   * ATOMIC cap check-and-reserve (CORR-2). Called RIGHT BEFORE an external
   * send/book provider call: it re-counts the caps and writes the canonical
   * reservation audit row inside one advisory-locked transaction, so concurrent
   * runs can never both pass the caps. On `allowed:false` the caller MUST fall
   * back to approval/propose (never send/create). In production this wraps
   * {@link reserveAutoAction}; tests inject an in-memory equivalent.
   */
  reserve: (args: ReserveArgs) => Promise<ReserveResult>;
}

/** Options for {@link createDeps}. */
export interface CreateDepsOptions {
  config?: Config;
  logger?: Logger;
  prisma?: PrismaClient;
  clock?: Clock;
}

/**
 * Wire a real {@link Deps} from config. Selects providers via the config flags
 * (`*_PROVIDER`), defaulting to the deterministic mocks. Used by the activity
 * factory; not used directly by workflow (deterministic) code.
 */
export async function createDeps(options: CreateDepsOptions = {}): Promise<Deps> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger('workflows', { level: config.logLevel });
  const clock: Clock = options.clock ?? (() => new Date());

  // Lazily import the real Prisma singleton so test code paths (which inject a
  // fake prisma) never construct a real client / load the query engine.
  const prisma = options.prisma ?? (await import('@app/db')).prisma;

  // Build a LIVE settings reader (short-TTL refreshable) so admin changes to
  // autonomy modes / kill switches / readiness propagate within seconds instead
  // of requiring a process restart. Same synchronous SettingsReader interface.
  const settings = await createLiveSettingsReader(prisma);
  const caps = createCapRepo(prisma);

  return {
    config,
    logger,
    clock,
    prisma,
    settings,
    caps,
    reserve: (args: ReserveArgs) => reserveAutoAction({ prisma, settings, now: clock() }, args),
    llmClient: createLlmClient(config, logger),
    email: createEmailProvider(config, logger, { clock }),
    calendar: createCalendarProvider(config, logger),
    research: createResearchProvider(config, logger),
  };
}

/**
 * Test helper: accept a structural subset of the Prisma client (only the
 * delegates a service uses) and present it as a {@link PrismaClient}. Keeps test
 * fakes small without resorting to `any` at each call site.
 */
export function asPrisma(partial: Partial<PrismaClient> | Record<string, unknown>): PrismaClient {
  return partial as unknown as PrismaClient;
}
