/**
 * HTTP bearer authentication for the API (audit finding SEC-1).
 *
 * A single `onRequest` hook requires `Authorization: Bearer <API_AUTH_TOKEN>` on
 * every route EXCEPT the explicitly public ones (`/health`, and the recipient
 * `GET|POST /unsubscribe` endpoints, which are gated by their own per-recipient
 * SIGNED unsubscribe token rather than the shared API credential).
 *
 * Config behavior:
 *   - `config.apiAuthToken` SET               → enforce the bearer on protected routes.
 *   - UNSET and `NODE_ENV==='production'`     → FAIL CLOSED: reject protected routes
 *     with 503 and log a fatal-config error (never run unauthenticated in prod).
 *   - UNSET and NOT production (dev/demo)     → allow, but log a loud startup WARNING.
 *
 * Token comparison is constant-time (`crypto.timingSafeEqual`). No dependency is
 * added for auth; this is a plain Fastify hook.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';

/**
 * Routes that never require the API bearer token.
 *
 * `/unsubscribe` (GET + POST) are for email recipients and are already gated by
 * the per-recipient signed unsubscribe token verified inside the route handler,
 * so they must not require the shared API credential.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/health', '/unsubscribe']);

/**
 * Normalize a request URL to its path (strip query string and any trailing
 * slash beyond the root) so it can be matched against {@link PUBLIC_ROUTES}.
 */
function routePath(url: string): string {
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return path;
}

/** Constant-time comparison of two strings; false on any length/utf8 mismatch. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on unequal lengths; compare against a fixed-length
  // digest-free guard so the early-return itself is not a timing oracle beyond
  // length (acceptable: token length is not secret).
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Extract the bearer credential from an Authorization header, or null. */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/.exec(header);
  const captured = match?.[1];
  if (!captured) return null;
  const token = captured.trim();
  return token.length > 0 ? token : null;
}

/**
 * Register the bearer-auth `onRequest` hook on the app.
 *
 * Also performs the production fail-closed startup check: if the API is running
 * in production with no configured token, that is a fatal misconfiguration; we
 * log it loudly at registration time (and the hook rejects all protected
 * requests with 503). In dev/local we log a prominent unauthenticated warning.
 */
export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const token = ctx.config.apiAuthToken;
  const isProd = ctx.config.nodeEnv === 'production';

  if (token) {
    ctx.logger.info('API bearer authentication enabled (Authorization: Bearer required)');
  } else if (isProd) {
    ctx.logger.fatal(
      'FATAL CONFIG: API_AUTH_TOKEN is not set but NODE_ENV=production. ' +
        'The API will FAIL CLOSED — all protected routes reject with 503. ' +
        'Set API_AUTH_TOKEN to enable authentication.',
    );
  } else {
    ctx.logger.warn(
      'SECURITY WARNING: API_AUTH_TOKEN is not set — the API is UNAUTHENTICATED. ' +
        'This is allowed only outside production (NODE_ENV=' +
        ctx.config.nodeEnv +
        ') for local demo/seed. Do NOT deploy without API_AUTH_TOKEN.',
    );
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = routePath(req.url);

    // Public routes: never require the API bearer.
    if (PUBLIC_ROUTES.has(path)) return;

    // No configured credential.
    if (!token) {
      if (isProd) {
        // Fail closed in production: refuse rather than silently allowing.
        reply.status(503).send({
          error: 'ServiceUnavailable',
          code: 'AUTH_NOT_CONFIGURED',
          message: 'API authentication is not configured.',
        });
        return reply;
      }
      // Dev/local: allow unauthenticated (startup warning already logged).
      return;
    }

    // Enforce the bearer token. Reply directly (rather than throwing) so the
    // 401 is emitted regardless of the centralized error handler's typed-error
    // mapping, and the request is short-circuited before any route handler runs.
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !safeEqual(presented, token)) {
      reply.status(401).send({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: 'missing or invalid API credential',
      });
      return reply;
    }
  });
}
