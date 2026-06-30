/**
 * Inbound simulation route. Preseeds the mock email provider with a simulated
 * inbound message (so the inbound flow can `getThread` it), then starts the
 * inbound workflow. This is how the demo simulates a reply from a prospect.
 *
 * NOTE: the mock provider is in-memory and per-process. The API preseeds its
 * OWN provider instance; in a single-process dev setup (or the demo's
 * `--no-temporal` mode, which calls the service directly) this is exactly the
 * provider the inbound flow reads. When a separate Temporal worker process runs
 * the workflow, it has its own in-memory provider and will not see this preseed
 * — for a true cross-process simulation an inbound message would be persisted by
 * the email layer. This contract preseeds + starts as specified.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EmailDirection } from '@app/shared';
import type { PreseedThread } from '@app/email';
import type { AppContext } from '../context.js';
import { startInbound } from '../start-workflows.js';

const InboundBody = z.object({
  from: z.string().email(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

export function registerInboundRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/inbound/simulate', async (req) => {
    const input = InboundBody.parse(req.body);
    const mock = await ctx.getMockEmail();

    const seed: PreseedThread = {
      ...(input.threadId ? { providerThreadId: input.threadId } : {}),
      subject: input.subject,
      messages: [
        {
          from: { email: input.from },
          to: [{ email: ctx.config.defaultFromEmail, name: ctx.config.defaultFromName }],
          subject: input.subject,
          body: input.body,
          direction: EmailDirection.INBOUND,
          ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
        },
      ],
    };

    const [thread] = mock.preseed([seed]);
    if (!thread) throw new Error('failed to preseed inbound thread');
    const providerMessageId = thread.messages[0]?.providerMessageId;

    const client = await ctx.getTemporalClient();
    const started = await startInbound(client, {
      threadId: thread.providerThreadId,
      ...(providerMessageId ? { providerMessageId } : {}),
    });

    return { ...started, threadId: thread.providerThreadId, providerMessageId };
  });
}
