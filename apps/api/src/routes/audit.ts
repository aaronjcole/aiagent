/** Audit log routes: list (?entityType & ?limit=100, newest first). */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { listAuditLogs } from '../services.js';

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/audit-logs', async (req) => {
    const { entityType, limit } = req.query as { entityType?: string; limit?: string };
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 100;
    return listAuditLogs(
      ctx.prisma,
      entityType,
      Number.isFinite(parsedLimit) ? parsedLimit : 100,
    );
  });
}
