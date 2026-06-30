import { z } from 'zod';
import { ConfidenceSchema, RiskFlagsSchema } from './common.js';

/** Validates a generated outreach draft (subject, body, personalization, CTA, claims). */
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
/** A drafted outreach email produced by the outreach agent. */
export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
