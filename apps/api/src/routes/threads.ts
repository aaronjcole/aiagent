/** Email thread routes: list and get (with messages). */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getThread, listThreads } from '../services.js';

export function registerThreadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/threads', async () => listThreads(ctx.prisma));

  app.get('/threads/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getThread(ctx.prisma, id);
  });
}
