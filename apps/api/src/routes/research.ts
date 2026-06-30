/** Research routes: list (optionally by prospectId) and get by id. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getResearch, listResearch } from '../services.js';

// Fastify can surface a repeated query param as an array; only accept a single
// string (or omit it). Anything else (e.g. ?prospectId=a&prospectId=b) → 400.
const ListQuery = z.object({ prospectId: z.string().optional() });

export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/research', async (req) => {
    const { prospectId } = ListQuery.parse(req.query);
    return listResearch(ctx.prisma, prospectId);
  });

  app.get('/research/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getResearch(ctx.prisma, id);
  });
}
