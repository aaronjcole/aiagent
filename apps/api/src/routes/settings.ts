/** System settings routes: list and update one by key (e.g. auto_send_enabled). */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@app/shared';
import type { AppContext } from '../context.js';
import { listSettings, setSetting } from '../services.js';

// Allow-list of writable settings + the value schema each accepts. Keys mirror
// the SystemSettings the seed writes (see src/seed.ts): the `*_enabled` toggles
// are booleans; the caps + max-steps are non-negative integers.
const SettingSchemas = {
  auto_send_enabled: z.boolean(),
  sending_enabled: z.boolean(),
  daily_send_cap: z.number().int().nonnegative(),
  per_inbox_daily_cap: z.number().int().nonnegative(),
  per_domain_daily_cap: z.number().int().nonnegative(),
  sequence_max_steps: z.number().int().nonnegative(),
} as const;

type SettingKey = keyof typeof SettingSchemas;

/** Type guard: is `key` one of the writable, allow-listed setting keys? */
function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SettingSchemas, key);
}

const PutBody = z.object({ value: z.unknown() });

/** Register the settings routes: list all settings and update one by key. */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /settings — list all system settings (sorted by key).
  app.get('/settings', async () => listSettings(ctx.prisma));

  // PUT /settings/:key — validate and upsert one allow-listed setting value.
  app.put('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    if (!isSettingKey(key)) {
      throw new ValidationError(`unknown setting key: ${key}`, { key });
    }
    const { value } = PutBody.parse(req.body);
    const parsed = SettingSchemas[key].safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(`invalid value for setting "${key}"`, {
        key,
        issues: parsed.error.issues,
      });
    }
    return setSetting(ctx.prisma, key, parsed.data);
  });
}
