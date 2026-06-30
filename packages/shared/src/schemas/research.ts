import { z } from 'zod';
import { ConfidenceSchema, RiskFlagsSchema } from './common.js';

/** Research-stage outcome as validated in agent output. */
export const ResearchStatusEnum = z.enum([
  'researched',
  'partial',
  'insufficient',
  'needs_review',
]);
/** Inferred type of {@link ResearchStatusEnum}. */
export type ResearchStatusEnum = z.infer<typeof ResearchStatusEnum>;

/** Validates one evidence-backed personalization point with optional source URL. */
export const PersonalizationPointSchema = z
  .object({
    point: z.string(),
    evidence: z.string(),
    sourceUrl: z.string().url().nullable(),
  })
  .strict();
/** A single evidence-backed personalization angle for outreach. */
export type PersonalizationPoint = z.infer<typeof PersonalizationPointSchema>;

/** Validates a cited research source (title, URL, snippet). */
export const ResearchSourceSchema = z
  .object({
    title: z.string(),
    url: z.string().url(),
    snippet: z.string(),
  })
  .strict();
/** A cited source backing research findings. */
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

/** Validates the full research-agent output (summary, insights, points, sources, gaps). */
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
/** Complete research result for a prospect. */
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
