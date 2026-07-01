/**
 * Inbound simulation route. Preseeds the mock email provider with a simulated
 * inbound message (so the inbound flow can `getThread` it), then starts the
 * inbound workflow. This is how the demo simulates a reply from a prospect.
 *
 * IMPORTANT — this endpoint is in-process demo tooling, not a cross-process
 * webhook. The mock email provider is in-memory and PER-PROCESS, and the inbound
 * workflow loads the thread via `deps.email.getThread(threadId)` — i.e. from the
 * provider, NOT the database. The API preseeds its OWN provider instance, so
 * this only works when the workflow runs in THIS process (single-process dev, or
 * the demo's `--no-temporal` mode which calls the service directly). A separate
 * Temporal worker process has its own empty mock and would not see the preseed.
 *
 * Making it durable cross-process would require the inbound service to read from
 * the DB instead of the provider (logic that lives in `@app/workflows`), so we
 * keep the scope honest: this route is GUARDED to only run against the mock
 * provider, and audited. For a real inbound, the provider webhook/poll path
 * feeds the workflow.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ActorType, EmailDirection, ValidationError } from '@app/shared';
import { MockEmailProvider, type PreseedThread } from '@app/email';
import type { AppContext } from '../context.js';
import { startInbound } from '../start-workflows.js';

const InboundBody = z.object({
  from: z.string().email(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

/** Register the inbound simulation route (mock-provider, in-process demo tooling). */
export function registerInboundRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /inbound/simulate — preseed the mock provider with a fake inbound
  // message, then start the inbound workflow (requires EMAIL_PROVIDER=mock).
  app.post('/inbound/simulate', async (req) => {
    const input = InboundBody.parse(req.body);

    // GUARD: this simulation only has durable meaning against the in-process
    // mock provider. Fail clearly (400) instead of preseeding a provider the
    // workflow will never read (which would silently appear to "start" then do
    // nothing in a separate worker process).
    const deps = await ctx.getDeps();
    if (!(deps.email instanceof MockEmailProvider)) {
      throw new ValidationError(
        `/inbound/simulate requires EMAIL_PROVIDER=mock (got "${deps.email.name}"); ` +
          'it is in-process demo tooling, not a cross-process inbound webhook.',
        { emailProvider: deps.email.name },
      );
    }
    const mock = deps.email;

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

    // Audit the simulate action (decision trail). Best-effort; never block the
    // response on the audit write failing.
    try {
      await ctx.prisma.auditLog.create({
        data: {
          action: 'inbound.simulate',
          actorType: ActorType.HUMAN,
          entityType: 'email_thread',
          entityId: thread.providerThreadId,
          allowed: true,
          reason: 'simulated inbound (mock provider, in-process demo)',
          metadata: {
            from: input.from,
            subject: input.subject,
            workflowId: started.workflowId,
            runId: started.runId,
            providerMessageId: providerMessageId ?? null,
          },
        },
      });
    } catch (err) {
      ctx.logger.warn({ err }, 'failed to write inbound.simulate audit log');
    }

    return { ...started, threadId: thread.providerThreadId, providerMessageId };
  });
}
