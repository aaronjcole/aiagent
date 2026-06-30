/**
 * @app/worker — the Temporal Worker process.
 *
 * Responsibilities:
 *  - build a single, process-wide `Deps` bundle (real prisma + mock/live
 *    providers + llm client) via `createDeps()`,
 *  - inject it into the activity layer with `setActivityDeps(deps)` so every
 *    activity shares one prisma client + provider set,
 *  - create a Temporal `Worker` bound to the `aiagent` task queue that hosts the
 *    compiled workflows (`workflowsPath`) and the activity functions
 *    (`workflowActivities`),
 *  - run until a SIGINT/SIGTERM triggers a graceful shutdown.
 *
 * Workflows must stay deterministic, so the worker registers them by path
 * (the bundler re-imports them in the workflow sandbox); activities run in the
 * Node.js context with the injected `Deps`.
 */

import { NativeConnection, Worker } from '@temporalio/worker';
import { createLogger, loadConfig, redactedConfig } from '@app/shared';
import {
  TASK_QUEUE,
  createDeps,
  setActivityDeps,
  workflowActivities,
  workflowsPath,
} from '@app/workflows';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('worker', { level: config.logLevel });

  logger.info({ config: redactedConfig(config) }, 'starting Temporal worker');

  // Build the shared dependency bundle ONCE and inject it into the activity
  // layer so all activities reuse one prisma client + provider/llm set.
  const deps = await createDeps({ config, logger });
  setActivityDeps(deps);

  // Connect to the Temporal frontend. A connection failure here is fatal — there
  // is nothing for the worker to do without a server.
  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: config.temporalAddress });
  } catch (err) {
    logger.error(
      { err, temporalAddress: config.temporalAddress },
      'failed to connect to Temporal — is the server running? (docker compose up)',
    );
    process.exitCode = 1;
    return;
  }

  let worker: Worker;
  try {
    worker = await Worker.create({
      connection,
      workflowsPath,
      activities: workflowActivities,
      taskQueue: TASK_QUEUE,
    });
  } catch (err) {
    logger.error({ err }, 'failed to create Temporal worker');
    await connection.close();
    process.exitCode = 1;
    return;
  }

  logger.info({ taskQueue: TASK_QUEUE, temporalAddress: config.temporalAddress }, 'worker created; polling');

  // Graceful shutdown: `worker.shutdown()` stops polling and drains in-flight
  // activities/workflows; `worker.run()` then resolves and we close the
  // connection. Register handlers BEFORE `run()` so an early signal is honored.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'received shutdown signal; draining worker');
    worker.shutdown();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await worker.run();
    logger.info('worker run loop exited cleanly');
  } catch (err) {
    logger.error({ err }, 'worker run loop failed');
    process.exitCode = 1;
  } finally {
    await connection.close();
  }
}

main().catch((err: unknown) => {
  // Last-resort handler for anything thrown before the logger is available.
  console.error('worker fatal error', err);
  process.exit(1);
});
