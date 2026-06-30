import { z } from 'zod';
import { ConfidenceSchema, RiskFlagsSchema } from './common.js';

export const OutreachDraftSchema = z
  .object({
    subject: z.string(),
    body: z.string(),
    personalizationUsed: z.array(z.string()),
    callToAction: z.string(),
    unsupportedClaims: z.array(z.string()),
    confidence: ConfidenceSchema,
    riskFlags: RiskFlagsSchema,
  })
  .strict();
export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
