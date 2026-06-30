/**
 * @app/api entrypoint — builds the Fastify app and listens on `config.apiPort`.
 * Loads `.env` (via dotenv) so local runs pick up the same config the worker
 * uses. Graceful shutdown on SIGINT/SIGTERM.
 */

import 'dotenv/config';
import { createAppContext } from './context.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const ctx = createAppContext();
  const app = buildServer(ctx);

  const close = async (signal: string): Promise<void> => {
    ctx.logger.info({ signal }, 'shutting down API');
    await app.close();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  try {
    await app.listen({ port: ctx.config.apiPort, host: '0.0.0.0' });
    ctx.logger.info({ port: ctx.config.apiPort }, 'API listening');
  } catch (err) {
    ctx.logger.error({ err }, 'failed to start API');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('api fatal error', err);
  process.exit(1);
});
