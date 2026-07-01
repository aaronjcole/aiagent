/** Prospect routes: list, get, create, and start research. Thin handlers. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  createProspect,
  getProspect,
  listProspects,
} from '../services.js';
import { startResearch } from '../start-workflows.js';

const CreateProspectBody = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  companyName: z.string().optional(),
  domain: z.string().optional(),
});

/**
 * Register the prospect routes on the Fastify app: list/get/create prospects
 * and start the research workflow for a prospect.
 */
export function registerProspectRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /prospects — list all prospects (newest first, with company).
  app.get('/prospects', async () => listProspects(ctx.prisma));

  // GET /prospects/:id — fetch one prospect by id (404 if missing).
  app.get('/prospects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getProspect(ctx.prisma, id);
  });

  // POST /prospects — create a prospect (201), upserting its company by domain.
  app.post('/prospects', async (req, reply) => {
    const body = CreateProspectBody.parse(req.body);
    const prospect = await createProspect(ctx.prisma, body);
    reply.status(201);
    return prospect;
  });

  // POST /prospects/:id/research — start the research workflow for a prospect.
  app.post('/prospects/:id/research', async (req) => {
    const { id } = req.params as { id: string };
    // Ensure the prospect exists (404 otherwise) before starting the workflow.
    await getProspect(ctx.prisma, id);
    const client = await ctx.getTemporalClient();
    return startResearch(client, id);
  });
}
