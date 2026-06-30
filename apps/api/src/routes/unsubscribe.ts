/**
 * Unsubscribe routes: the deterministic HTTPS suppression endpoint referenced by
 * the `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
 *
 * Both POST (one-click `List-Unsubscribe-Post`) and GET (plain link click) add a
 * SuppressionEntry (reason UNSUBSCRIBE) + write the audit trail, immediately and
 * deterministically — no LLM. At least one of `email` / `domain` is required.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@app/shared';
import type { AppContext } from '../context.js';
import { recordUnsubscribe } from '../services.js';

// email and/or domain (plus an optional opaque token from the unsubscribe link).
const UnsubscribeInput = z
  .object({
    email: z.string().email().optional(),
    domain: z.string().min(1).optional(),
    token: z.string().optional(),
  })
  .refine((b) => Boolean(b.email || b.domain), {
    message: 'either email or domain is required',
  });

/** Register the unsubscribe routes: deterministic, immediate suppression. */
export function registerUnsubscribeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /unsubscribe — one-click (List-Unsubscribe-Post) body { email?, domain?, token? }.
  app.post('/unsubscribe', async (req) => {
    const parsed = UnsubscribeInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('invalid unsubscribe request', { issues: parsed.error.issues });
    }
    const entry = await recordUnsubscribe(ctx.prisma, parsed.data);
    return { ok: true, unsubscribed: true, email: entry.email, domain: entry.domain };
  });

  // GET /unsubscribe — convenience for a plain one-click link; reads from query.
  app.get('/unsubscribe', async (req) => {
    const parsed = UnsubscribeInput.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new ValidationError('invalid unsubscribe request', { issues: parsed.error.issues });
    }
    const entry = await recordUnsubscribe(ctx.prisma, parsed.data);
    return { ok: true, unsubscribed: true, email: entry.email, domain: entry.domain };
  });
}
