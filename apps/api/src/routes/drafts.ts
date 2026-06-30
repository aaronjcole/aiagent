/** Draft email routes: list (optionally by status) and get by id. */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getDraft, listDrafts } from '../services.js';

export function registerDraftRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/drafts', async (req) => {
    const { status } = req.query as { status?: string };
    return listDrafts(ctx.prisma, status);
  });

  app.get('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getDraft(ctx.prisma, id);
  });
}
