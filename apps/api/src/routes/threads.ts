/** Email thread routes: list and get (with messages). */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getThread, listThreads } from '../services.js';

/** Register the email-thread routes: list threads and get one with its messages. */
export function registerThreadRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /threads — list email threads (newest activity first, with prospect).
  app.get('/threads', async () => listThreads(ctx.prisma));

  // GET /threads/:id — fetch one thread with its messages (404 if missing).
  app.get('/threads/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getThread(ctx.prisma, id);
  });
}
