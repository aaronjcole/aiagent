import { z } from 'zod';
import { ConfidenceSchema, RiskFlagsSchema } from './common.js';

/** Categories an inbound reply can be classified into. */
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
/** Inferred type of {@link InboundCategoryEnum}. */
export type InboundCategoryEnum = z.infer<typeof InboundCategoryEnum>;

/** Validates the inbound-classifier output (category, escalation, confidence, risk flags). */
export const InboundClassificationSchema = z
  .object({
    category: InboundCategoryEnum,
    requiresHuman: z.boolean(),
    reasons: z.array(z.string()),
    confidence: ConfidenceSchema,
    riskFlags: RiskFlagsSchema,
  })
  .strict();
/** Classification result for a single inbound reply. */
export type InboundClassification = z.infer<typeof InboundClassificationSchema>;
