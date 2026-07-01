/**
 * Builds the Fastify application: request logging (pino), a single centralized
 * error handler that maps the typed `@app/shared` errors to HTTP status codes,
 * and all route modules registered as thin handlers.
 *
 * The app is built around an injected {@link AppContext} so tests / the demo can
 * construct it without listening on a port.
 */

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  EscalationError,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  isAppError,
} from '@app/shared';
import type { AppContext } from './context.js';
import { registerAuth } from './auth.js';
import { registerRateLimit } from './rate-limit.js';
import { registerProspectRoutes } from './routes/prospects.js';
import { registerResearchRoutes } from './routes/research.js';
import { registerOutboundRoutes } from './routes/outbound.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerInboundRoutes } from './routes/inbound.js';
import { registerThreadRoutes } from './routes/threads.js';
import { registerSuppressionRoutes } from './routes/suppression.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerUnsubscribeRoutes } from './routes/unsubscribe.js';

export function buildServer(ctx: AppContext): FastifyInstance {
  // Pass the shared pino logger as a `FastifyBaseLogger` so Fastify does not
  // leak the concrete pino `Logger` type into the instance generic (which would
  // make the instance incompatible with the plain `FastifyInstance` the route
  // registrars expect).
  const app: FastifyInstance = Fastify({
    logger: ctx.logger as unknown as FastifyBaseLogger,
    // Body size limit (SEC-H2): reject oversized JSON bodies (default is 1 MiB;
    // set explicitly to 256 KiB — all API payloads are small JSON documents).
    bodyLimit: 256 * 1024,
  });

  // --- Rate limiting (SEC-H2) ---
  // Registered first so its global onRequest hooks wrap all routes. Deferred by
  // Fastify until ready()/listen().
  registerRateLimit(app, ctx);

  // --- Bearer authentication (SEC-1) ---
  // Adds a global onRequest hook enforcing the API bearer token on all routes
  // except the public ones (/health, GET|POST /unsubscribe). Registered before
  // the routes so the hook runs ahead of every handler.
  registerAuth(app, ctx);

  // --- Centralized error handler (typed errors → HTTP status) ---
  app.setErrorHandler((err, _req, reply) => {
    // Zod validation → 400.
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'request validation failed',
        details: err.issues,
      });
      return;
    }

    if (isAppError(err)) {
      let status = err.httpStatus;
      // Explicit mapping per the API contract.
      if (err instanceof NotFoundError) status = 404;
      else if (err instanceof ValidationError) status = 400;
      else if (err instanceof PolicyViolationError) status = 409;
      else if (err instanceof EscalationError) status = 422;
      reply.status(status).send({
        error: err.name,
        code: err.code,
        message: err.message,
        details: err.details,
      });
      return;
    }

    // Fastify's own validation errors carry a statusCode.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({
        error: err.name ?? 'BadRequest',
        code: 'VALIDATION_ERROR',
        message: err.message,
      });
      return;
    }

    ctx.logger.error({ err }, 'unhandled error');
    reply.status(500).send({
      error: 'InternalServerError',
      code: 'APP_ERROR',
      message: 'internal server error',
    });
  });

  // --- Health ---
  app.get('/health', async () => ({ ok: true }));

  // --- Feature routes ---
  registerProspectRoutes(app, ctx);
  registerResearchRoutes(app, ctx);
  registerOutboundRoutes(app, ctx);
  registerDraftRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerInboundRoutes(app, ctx);
  registerThreadRoutes(app, ctx);
  registerSuppressionRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerUnsubscribeRoutes(app, ctx);

  return app;
}
