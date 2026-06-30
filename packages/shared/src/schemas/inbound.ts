import { z } from 'zod';
import { ConfidenceSchema, RiskFlagsSchema } from './common.js';

export const InboundCategoryEnum = z.enum([
  'interested_schedule',
  'question',
  'not_interested',
  'unsubscribe',
  'out_of_office',
  'pricing',
  'legal',
  'security',
  'procurement',
  'angry',
  'referral',
  'other',
]);
export type InboundCategoryEnum = z.infer<typeof InboundCategoryEnum>;

export const InboundClassificationSchema = z
  .object({
    category: InboundCategoryEnum,
    requiresHuman: z.boolean(),
    reasons: z.array(z.string()),
    confidence: ConfidenceSchema,
    riskFlags: RiskFlagsSchema,
  })
  .strict();
export type InboundClassification = z.infer<typeof InboundClassificationSchema>;
