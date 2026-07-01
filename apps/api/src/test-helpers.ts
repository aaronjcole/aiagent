/**
 * Test-only helpers for building an in-process {@link AppContext} + Fastify app
 * with fully mocked dependencies (no live DB, no Temporal). Route tests drive the
 * app via `app.inject()`.
 *
 * NOTE: this file lives under `src/` so it is covered by the app's tsconfig, but
 * it is only imported by `*.test.ts` files.
 */

import { createLogger, loadConfig, type Config, type Logger } from '@app/shared';
import type { PrismaClient } from '@app/db';
import type { AppContext } from './context.js';

/** Overridable pieces of a fake {@link AppContext}. */
export interface FakeContextOptions {
  /** Env overrides passed to `loadConfig` (e.g. API_AUTH_TOKEN, NODE_ENV). */
  env?: NodeJS.ProcessEnv;
  /** Structural prisma double (only the delegates a route touches). */
  prisma?: Partial<PrismaClient> | Record<string, unknown>;
  /** Temporal readiness probe result. Defaults to resolving `'ok'`. */
  pingTemporal?: () => Promise<'ok'>;
}

/**
 * Build a fake {@link AppContext} with a silent logger, a mocked prisma, and a
 * configurable Temporal readiness probe. Temporal client / Deps / mock-email
 * accessors throw if a test unexpectedly reaches for them.
 */
export function makeFakeContext(opts: FakeContextOptions = {}): AppContext {
  const config: Config = loadConfig({ NODE_ENV: 'test', ...opts.env });
  // Silent logger so tests don't spam output.
  const logger: Logger = createLogger('api-test', { level: 'silent' });
  const prisma = (opts.prisma ?? {}) as unknown as PrismaClient;

  const notWired = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not wired in this fake context`);
  };

  return {
    config,
    logger,
    prisma,
    getTemporalClient: notWired('getTemporalClient') as AppContext['getTemporalClient'],
    getDeps: notWired('getDeps') as AppContext['getDeps'],
    getMockEmail: notWired('getMockEmail') as AppContext['getMockEmail'],
    pingTemporal: opts.pingTemporal ?? (async () => 'ok'),
    async close() {
      /* no-op */
    },
  };
}
