/** Audit log routes: list (?entityType & ?limit=100, newest first). */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { listAuditLogs } from '../services.js';

/** Register the audit-log route: list audit logs filtered/limited via query params. */
export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /audit-logs — list audit logs (?entityType filter, ?limit default 100).
  app.get('/audit-logs', async (req) => {
    const { entityType, limit } = req.query as { entityType?: string; limit?: string };
    const parsed = limit ? Number.parseInt(limit, 10) : NaN;
    // Only accept positive integers; clamp to a sane ceiling, else default 100.
    const safeLimit =
      Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 100;
    return listAuditLogs(ctx.prisma, entityType, safeLimit);
  });
}
