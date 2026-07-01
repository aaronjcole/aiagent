/**
 * Automation routes: read-only surface over controlled-autonomy cap usage.
 *
 * Thin handler that delegates to the deterministic cap repo in `@app/compliance`
 * (via `getAutomationCounts`). No LLM, no side effects.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getAutomationCounts } from '../services.js';

/** Register the automation routes: current rolling-24h cap counts. */
export function registerAutomationRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /automation/counts — current rolling-24h autonomous-action counts:
  // { globalSentToday, calendarEventsToday }.
  app.get('/automation/counts', async () => getAutomationCounts(ctx.prisma));
}
