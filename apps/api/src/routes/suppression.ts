/** Suppression routes: list, add (deterministic), remove. State-changing. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SuppressionReason } from '@app/shared';
import type { AppContext } from '../context.js';
import {
  addSuppressionEntry,
  listSuppression,
  removeSuppressionEntry,
} from '../services.js';

const AddBody = z
  .object({
    email: z.string().email().optional(),
    domain: z.string().optional(),
    reason: z
      .enum([
        SuppressionReason.UNSUBSCRIBE,
        SuppressionReason.BOUNCE,
        SuppressionReason.COMPLAINT,
        SuppressionReason.MANUAL,
        SuppressionReason.GLOBAL_BLOCK,
        SuppressionReason.COMPETITOR,
      ])
      .optional(),
    notes: z.string().optional(),
  })
  .refine((b) => Boolean(b.email || b.domain), {
    message: 'either email or domain is required',
  });

export function registerSuppressionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/suppression', async () => listSuppression(ctx.prisma));

  app.post('/suppression', async (req, reply) => {
    const body = AddBody.parse(req.body);
    const entry = await addSuppressionEntry(ctx.prisma, body);
    reply.status(201);
    return entry;
  });

  app.delete('/suppression/:id', async (req) => {
    const { id } = req.params as { id: string };
    return removeSuppressionEntry(ctx.prisma, id);
  });
}
