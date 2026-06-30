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

  return {
    config,
    logger,
    clock,
    prisma,
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
