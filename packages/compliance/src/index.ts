/**
 * @app/compliance — deterministic policy core.
 *
 * SAFETY-CRITICAL. This package is DETERMINISTIC ONLY: it must never import
 * `@app/llm` or `@app/agents`. The LLM compliance review is performed elsewhere;
 * functions that need its verdict accept a parsed `ComplianceReview` as an
 * injected argument. All database access is injectable via the narrow repo
 * interfaces in `./types`, with Prisma-backed implementations in `./repos`.
 */

export * from './types.js';
export * from './email.js';
export * from './unsubscribe.js';
export * from './suppression.js';
export * from './caps.js';
export * from './eligibility.js';
export * from './footer.js';
export * from './audit.js';
export * from './gates.js';
export * from './repos.js';
export * from './fakes.js';
export * from './settings.js';
export * from './business-hours.js';
export * from './unsubscribe-headers.js';
export * from './policy.js';
