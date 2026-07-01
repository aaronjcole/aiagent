import { z } from 'zod';
import { ConfidenceSchema } from './common.js';

/** Overall verdict of an LLM compliance review. */
export const ComplianceDecisionEnum = z.enum(['pass', 'fail', 'needs_review']);
/** Inferred type of {@link ComplianceDecisionEnum}. */
export type ComplianceDecisionEnum = z.infer<typeof ComplianceDecisionEnum>;

/** Severity level of an individual compliance issue. */
export const ComplianceSeverityEnum = z.enum(['low', 'medium', 'high']);
/** Inferred type of {@link ComplianceSeverityEnum}. */
export type ComplianceSeverityEnum = z.infer<typeof ComplianceSeverityEnum>;

/** Validates a single compliance issue (code, severity, detail). */
export const ComplianceIssueSchema = z
  .object({
    code: z.string(),
    severity: ComplianceSeverityEnum,
    detail: z.string(),
  })
  .strict();
/** A single flagged compliance issue. */
export type ComplianceIssue = z.infer<typeof ComplianceIssueSchema>;

/** Validates the full LLM compliance review output (decision, issues, fixes, confidence). */
export const ComplianceReviewSchema = z
  .object({
    decision: ComplianceDecisionEnum,
    issues: z.array(ComplianceIssueSchema),
    hasUnsupportedClaims: z.boolean(),
    suggestedFixes: z.array(z.string()),
    confidence: ConfidenceSchema,
  })
  .strict();
/** Parsed LLM compliance verdict consumed by the outbound gates. */
export type ComplianceReview = z.infer<typeof ComplianceReviewSchema>;
