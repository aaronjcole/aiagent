/** Research routes: list (optionally by prospectId) and get by id. */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getResearch, listResearch } from '../services.js';

export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/research', async (req) => {
    const { prospectId } = req.query as { prospectId?: string };
    return listResearch(ctx.prisma, prospectId);
  });

  app.get('/research/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getResearch(ctx.prisma, id);
  });
}
