/**
 * Suppression list checks. An address is suppressed if its exact email OR its
 * domain appears on the list. All DB access goes through {@link SuppressionRepo}
 * so unit tests use in-memory fakes.
 */

import { ValidationError } from '@app/shared';
import type {
  AddSuppressionInput,
  SuppressionEntryLike,
  SuppressionRepo,
  SuppressionResult,
} from './types.js';
import { extractDomain, normalizeEmail } from './email.js';
// extractDomain is used by checkSuppression (derives recipient domain to test).

/**
 * Check whether an email (or its domain) is suppressed.
 *
 * Email match takes precedence over domain match. If neither `email` nor
 * `domain` is provided, the result is "not suppressed".
 */
export async function checkSuppression(
  repo: SuppressionRepo,
  input: { email?: string; domain?: string },
): Promise<SuppressionResult> {
  const email = input.email ? normalizeEmail(input.email) : undefined;
  // Prefer an explicit domain; otherwise derive it from the email.
  const domain = (input.domain ?? (email ? extractDomain(email) : undefined))?.toLowerCase();

  if (email) {
    const byEmail = await repo.findByEmail(email);
    if (byEmail) {
      return { suppressed: true, entry: byEmail, matchedOn: 'email' };
    }
  }

  if (domain) {
    const byDomain = await repo.findByDomain(domain);
    if (byDomain) {
      return { suppressed: true, entry: byDomain, matchedOn: 'domain' };
    }
  }

  return { suppressed: false };
}

/**
 * Idempotently add a suppression entry. Re-adding the same email/domain returns
 * the existing entry rather than creating a duplicate (delegated to the repo's
 * `upsert`, which is backed by the `@unique` constraints on email/domain).
 */
export async function addSuppression(
  repo: SuppressionRepo,
  input: AddSuppressionInput,
): Promise<SuppressionEntryLike> {
  const email = input.email ? normalizeEmail(input.email) : undefined;
  // Only an explicit `domain` suppresses a whole domain. We never widen an
  // email-only request into a domain block by deriving the domain from it.
  const domain = input.domain?.toLowerCase();

  if (!email && !domain) {
    throw new ValidationError('addSuppression requires at least an email or a domain');
  }

  return repo.upsert({
    ...input,
    email,
    domain,
  });
}
