import { z } from 'zod';
import { ConfidenceSchema, RiskFlagsSchema } from './common.js';

export const ResearchStatusEnum = z.enum([
  'researched',
  'partial',
  'insufficient',
  'needs_review',
]);
export type ResearchStatusEnum = z.infer<typeof ResearchStatusEnum>;

export const PersonalizationPointSchema = z
  .object({
    point: z.string(),
    evidence: z.string(),
    sourceUrl: z.string().url().nullable(),
  })
  .strict();
export type PersonalizationPoint = z.infer<typeof PersonalizationPointSchema>;

export const ResearchSourceSchema = z
  .object({
    title: z.string(),
    url: z.string().url(),
    snippet: z.string(),
  })
  .strict();
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const ResearchOutputSchema = z
  .object({
    status: ResearchStatusEnum,
    summary: z.string(),
    companyInsights: z.string(),
    personalizationPoints: z.array(PersonalizationPointSchema),
    sources: z.array(ResearchSourceSchema),
    dataGaps: z.array(z.string()),
    confidence: ConfidenceSchema,
    riskFlags: RiskFlagsSchema,
  })
  .strict();
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
