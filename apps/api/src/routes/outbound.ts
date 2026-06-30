/** Outbound + sequences routes. POST /outbound starts the sequence workflow. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getProspect, listSequences } from '../services.js';
import { startOutbound } from '../start-workflows.js';

const OutboundBody = z.object({
  prospectId: z.string().min(1),
  sequenceId: z.string().min(1),
});

export function registerOutboundRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/outbound', async (req) => {
    const { prospectId, sequenceId } = OutboundBody.parse(req.body);
    // 404 if the prospect doesn't exist.
    await getProspect(ctx.prisma, prospectId);
    const client = await ctx.getTemporalClient();
    return startOutbound(client, prospectId, sequenceId);
  });

  app.get('/sequences', async () => listSequences(ctx.prisma));
}
