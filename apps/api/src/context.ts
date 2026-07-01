/**
 * Process-wide application context for the API.
 *
 * Holds the config, logger, the prisma client (reads), a lazily-connected
 * Temporal `Client` (used to START workflows), and a lazily-built `Deps` bundle.
 * The `Deps` bundle is reused for two things:
 *   - the mock email provider instance, into which `/inbound/simulate` preseeds
 *     a simulated inbound message, and
 *   - direct service-function calls (the demo's `--no-temporal` mode), so the
 *     API can drive the real orchestration without a Temporal server.
 *
 * Everything is lazy so the server can boot (and answer `/health`) even if
 * Temporal is down; the client only connects on the first workflow start.
 */

import { Client, Connection } from '@temporalio/client';
import { prisma, type PrismaClient } from '@app/db';
import { createLogger, loadConfig, type Config, type Logger } from '@app/shared';
import { createDeps, type Deps } from '@app/workflows';
import { MockEmailProvider } from '@app/email';

export interface AppContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly prisma: PrismaClient;
  /** Lazily-connected Temporal client used to START workflows. */
  getTemporalClient(): Promise<Client>;
  /** Lazily-built shared Deps (real prisma + providers + llm). */
  getDeps(): Promise<Deps>;
  /**
   * The mock email provider instance (when `EMAIL_PROVIDER=mock`), so inbound
   * simulation can preseed a thread. Throws if the configured provider is not
   * the mock.
   */
  getMockEmail(): Promise<MockEmailProvider>;
  /**
   * Readiness check for Temporal connectivity (OPS-M1). Connects the lazy
   * Temporal client (if not already connected) and issues a gRPC health-service
   * check. Resolves to `'ok'` when Temporal reports SERVING, throws otherwise.
   * Separated from the `/health` liveness probe so the cheap probe never touches
   * Temporal.
   */
  pingTemporal(): Promise<'ok'>;
  close(): Promise<void>;
}

/**
 * Build the process-wide {@link AppContext}: loads config, creates the logger,
 * and wires lazily-initialized Temporal client / Deps / mock-email accessors.
 */
export function createAppContext(): AppContext {
  const config = loadConfig();
  const logger = createLogger('api', { level: config.logLevel });

  let clientPromise: Promise<Client> | undefined;
  let depsPromise: Promise<Deps> | undefined;
  let connection: Connection | undefined;

  async function getTemporalClient(): Promise<Client> {
    if (!clientPromise) {
      const pending = (async () => {
        connection = await Connection.connect({ address: config.temporalAddress });
        return new Client({ connection });
      })();
      // Don't cache a rejected init: clear the memo on failure so the next call
      // retries instead of permanently returning the same rejected promise.
      pending.catch(() => {
        if (clientPromise === pending) clientPromise = undefined;
      });
      clientPromise = pending;
    }
    return clientPromise;
  }

  async function getDeps(): Promise<Deps> {
    if (!depsPromise) {
      // Reuse the shared prisma singleton + this context's config/logger so the
      // mock email provider is a single shared instance.
      const pending = createDeps({ config, logger, prisma });
      // Don't cache a rejected init (see getTemporalClient).
      pending.catch(() => {
        if (depsPromise === pending) depsPromise = undefined;
      });
      depsPromise = pending;
    }
    return depsPromise;
  }

  async function getMockEmail(): Promise<MockEmailProvider> {
    const deps = await getDeps();
    if (!(deps.email instanceof MockEmailProvider)) {
      throw new Error(
        `inbound simulation requires EMAIL_PROVIDER=mock (got "${deps.email.name}")`,
      );
    }
    return deps.email;
  }

  async function pingTemporal(): Promise<'ok'> {
    // Reuse the same lazily-connected client the API uses to START workflows, so
    // readiness reflects the real dependency. Ensure the client (and thus the
    // concrete `connection` in this closure) is initialized, then issue the
    // standard gRPC health probe on the concrete Connection (the Client's
    // `connection` field is the narrower `ConnectionLike` and does not expose
    // `healthService`). A non-SERVING status or connect failure throws (surfaced
    // by the caller as a 503 with a safe, secret-free detail).
    await getTemporalClient();
    if (!connection) throw new Error('Temporal connection unavailable');
    const res = await connection.healthService.check({
      service: 'temporal.api.workflowservice.v1.WorkflowService',
    });
    // grpc.health.v1: 1 === SERVING.
    if (res.status !== 1) {
      throw new Error(`Temporal health status not SERVING (status=${String(res.status)})`);
    }
    return 'ok';
  }

  async function close(): Promise<void> {
    if (connection) {
      await connection.close();
    }
  }

  return {
    config,
    logger,
    prisma,
    getTemporalClient,
    getDeps,
    getMockEmail,
    pingTemporal,
    close,
  };
}
