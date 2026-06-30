/** Research routes: list (optionally by prospectId) and get by id. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getResearch, listResearch } from '../services.js';

// Fastify can surface a repeated query param as an array; only accept a single
// string (or omit it). Anything else (e.g. ?prospectId=a&prospectId=b) → 400.
const ListQuery = z.object({ prospectId: z.string().optional() });

/** Register the research routes: list research results and get one by id. */
export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /research — list research results, optionally filtered by ?prospectId.
  app.get('/research', async (req) => {
    const { prospectId } = ListQuery.parse(req.query);
    return listResearch(ctx.prisma, prospectId);
  });

  // GET /research/:id — fetch one research result by id (404 if missing).
  app.get('/research/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getResearch(ctx.prisma, id);
  });
}
