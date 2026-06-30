/**
 * Unsubscribe routes: the deterministic HTTPS suppression endpoint referenced by
 * the `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
 *
 * The actual suppression is performed ONLY by POST (RFC 8058 one-click
 * `List-Unsubscribe-Post`), which derives its target from a verified signed
 * token via {@link recordUnsubscribe}. GET is SAFE/read-only: mail scanners and
 * link prefetchers follow links, so a GET must never mutate — it merely
 * validates the token and returns a confirmation preview (a one-click confirm
 * form). No LLM.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError, verifyUnsubscribeToken } from '@app/shared';
import type { AppContext } from '../context.js';
import { recordUnsubscribe } from '../services.js';

// The signed token from the unsubscribe link is what authorizes/derives the
// suppression target. email/domain may accompany the link for display only;
// they are NOT trusted for the suppression decision.
const UnsubscribeInput = z.object({
  email: z.string().email().optional(),
  domain: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** Register the unsubscribe routes: token-verified, deterministic suppression. */
export function registerUnsubscribeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /unsubscribe — one-click (List-Unsubscribe-Post) body { token, email?, domain? }.
  // This is the only mutating verb: it suppresses the token-derived target.
  app.post('/unsubscribe', async (req) => {
    const parsed = UnsubscribeInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('invalid unsubscribe request', { issues: parsed.error.issues });
    }
    const entry = await recordUnsubscribe(
      ctx.prisma,
      parsed.data,
      ctx.config.unsubscribeTokenSecret,
    );
    return { ok: true, unsubscribed: true, email: entry.email, domain: entry.domain };
  });

  // GET /unsubscribe — SAFE/read-only confirmation preview for a plain link
  // click. Validates the token and returns the target + a one-click confirm
  // form; it does NOT suppress (mail scanners follow GET links).
  app.get('/unsubscribe', async (req) => {
    const parsed = UnsubscribeInput.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw new ValidationError('invalid unsubscribe request', { issues: parsed.error.issues });
    }
    const secret = ctx.config.unsubscribeTokenSecret;
    const verified = secret ? verifyUnsubscribeToken(parsed.data.token, secret) : null;
    if (!verified || (!verified.email && !verified.domain)) {
      throw new ValidationError('invalid or missing unsubscribe token');
    }
    // Return a minimal confirmation page: confirm via a one-click POST.
    return {
      ok: true,
      unsubscribed: false,
      confirm: {
        method: 'POST',
        action: '/unsubscribe',
        token: parsed.data.token,
      },
      target: { email: verified.email ?? null, domain: verified.domain ?? null },
      message: 'Confirm to unsubscribe. Submit the one-click POST to complete.',
    };
  });
}
