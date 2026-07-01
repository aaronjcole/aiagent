/** Approval routes: list (pending default), approve, reject. State-changing. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalStatus } from '@app/shared';
import type { AppContext } from '../context.js';
import { approveApproval, listApprovals, rejectApproval } from '../services.js';

const StatusQuery = z
  .enum([
    ApprovalStatus.PENDING,
    ApprovalStatus.APPROVED,
    ApprovalStatus.REJECTED,
    ApprovalStatus.EXPIRED,
    ApprovalStatus.AUTO_APPROVED,
  ])
  .optional();

const DecisionBody = z
  .object({ reason: z.string().optional(), actor: z.string().optional() })
  .default({});

/** Register the approval routes: list pending approvals, approve, and reject. */
export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /approvals — list approval items, optionally by ?status (default PENDING).
  app.get('/approvals', async (req) => {
    const { status } = req.query as { status?: string };
    const parsed = StatusQuery.parse(status) ?? ApprovalStatus.PENDING;
    return listApprovals(ctx.prisma, parsed);
  });

  // POST /approvals/:id/approve — approve an approval item (records an audit log).
  app.post('/approvals/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const body = DecisionBody.parse(req.body ?? {});
    return approveApproval(ctx.prisma, id, body);
  });

  // POST /approvals/:id/reject — reject an approval item (records an audit log).
  app.post('/approvals/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const body = DecisionBody.parse(req.body ?? {});
    return rejectApproval(ctx.prisma, id, body);
  });
}
