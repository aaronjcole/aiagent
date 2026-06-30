/** System settings routes: list and update one by key (e.g. auto_send_enabled). */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { listSettings, setSetting } from '../services.js';

const PutBody = z.object({ value: z.unknown() });

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings', async () => listSettings(ctx.prisma));

  app.put('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    const { value } = PutBody.parse(req.body);
    return setSetting(ctx.prisma, key, value);
  });
}
