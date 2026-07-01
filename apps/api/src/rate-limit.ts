/**
 * Rate limiting for the API (audit finding SEC-H2).
 *
 * Uses the maintained `@fastify/rate-limit` plugin (the standard Fastify rate
 * limiter) with an in-memory store. A conservative global default applies to
 * every route; a tighter limit applies to the abuse-prone / expensive public
 * endpoints (unsubscribe, inbound simulation, research, outbound send,
 * draft send) via a dynamic per-request `max`.
 *
 * The plugin is registered BEFORE the routes so its `onRequest`/`preHandler`
 * hooks wrap all subsequently-registered handlers.
 */

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';

/** Conservative global default: requests per IP per minute. */
const GLOBAL_MAX = 100;
/** Tighter cap for abuse-prone / expensive endpoints. */
const TIGHT_MAX = 10;
/** Sliding window for both limits. */
const TIME_WINDOW = '1 minute';

/**
 * Method+path patterns that get the tighter limit. Path is matched against the
 * request pathname with `:param` segments treated as wildcards.
 */
const TIGHT_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/unsubscribe$/ },
  { method: 'GET', pattern: /^\/unsubscribe$/ },
  { method: 'POST', pattern: /^\/inbound\/simulate$/ },
  { method: 'POST', pattern: /^\/prospects\/[^/]+\/research$/ },
  { method: 'POST', pattern: /^\/outbound$/ },
  { method: 'POST', pattern: /^\/drafts\/[^/]+\/send$/ },
];

/** Strip query string / trailing slash to get a matchable pathname. */
function pathname(url: string): string {
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return path;
}

/** True if the request targets one of the tighter-limited endpoints. */
function isTightRoute(req: FastifyRequest): boolean {
  const path = pathname(req.url);
  return TIGHT_ROUTES.some((r) => r.method === req.method && r.pattern.test(path));
}

/**
 * Register the rate-limit plugin with a global default and a dynamic tighter
 * cap for abuse-prone routes.
 *
 * Fastify defers plugin registration until `ready()`/`listen()`, so this is
 * queued (not awaited here) and applies to every route regardless of
 * registration order. Because the plugin sets global `onRequest` hooks, it
 * wraps all routes registered on the same instance.
 */
export function registerRateLimit(app: FastifyInstance, _ctx: AppContext): void {
  void app.register(rateLimit, {
    global: true,
    // Dynamic per-request max: tight cap for the abuse-prone routes, otherwise
    // the conservative global default.
    max: (req: FastifyRequest) => (isTightRoute(req) ? TIGHT_MAX : GLOBAL_MAX),
    timeWindow: TIME_WINDOW,
    // Keyed by client IP (default keyGenerator uses req.ip, which respects
    // Fastify's trustProxy config; left default here).
  });
}
