import { z } from 'zod';
import { ConfidenceSchema } from './common.js';

export const ComplianceDecisionEnum = z.enum(['pass', 'fail', 'needs_review']);
export type ComplianceDecisionEnum = z.infer<typeof ComplianceDecisionEnum>;

export const ComplianceSeverityEnum = z.enum(['low', 'medium', 'high']);
export type ComplianceSeverityEnum = z.infer<typeof ComplianceSeverityEnum>;

export const ComplianceIssueSchema = z
  .object({
    code: z.string(),
    severity: ComplianceSeverityEnum,
    detail: z.string(),
  })
  .strict();
export type ComplianceIssue = z.infer<typeof ComplianceIssueSchema>;

export const ComplianceReviewSchema = z
  .object({
    decision: ComplianceDecisionEnum,
    issues: z.array(ComplianceIssueSchema),
    hasUnsupportedClaims: z.boolean(),
    suggestedFixes: z.array(z.string()),
    confidence: ConfidenceSchema,
  })
  .strict();
export type ComplianceReview = z.infer<typeof ComplianceReviewSchema>;
