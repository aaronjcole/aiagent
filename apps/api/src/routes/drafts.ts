/** Draft email routes: list (optionally by status) and get by id. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DraftStatus } from '@app/db';
import type { AppContext } from '../context.js';
import { getDraft, listDrafts } from '../services.js';
import { startSendApprovedDraft } from '../start-workflows.js';

// Only accept a single valid DraftStatus (kept in sync with the Prisma enum);
// invalid values → 400.
const ListQuery = z.object({ status: z.nativeEnum(DraftStatus).optional() });

/** Register the draft routes: list/get drafts and start the approved-send workflow. */
export function registerDraftRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /drafts — list drafts, optionally filtered by ?status.
  app.get('/drafts', async (req) => {
    const { status } = ListQuery.parse(req.query);
    return listDrafts(ctx.prisma, status);
  });

  // GET /drafts/:id — fetch one draft by id (404 if missing).
  app.get('/drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getDraft(ctx.prisma, id);
  });

  // Trigger the human-in-the-loop SEND of an APPROVED draft. The send is still
  // gated on SENDING_ENABLED + the human approval inside the workflow/service;
  // by default (SENDING_ENABLED off) this records a blocked audit and does not
  // send. Handler stays thin: 404 if the draft is missing, then start the
  // durable, idempotent send workflow.
  app.post('/drafts/:id/send', async (req) => {
    const { id } = req.params as { id: string };
    // 404 if the draft doesn't exist (before starting the workflow).
    await getDraft(ctx.prisma, id);
    const client = await ctx.getTemporalClient();
    return startSendApprovedDraft(client, id);
  });
}
