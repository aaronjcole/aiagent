/**
 * CAN-SPAM footer enforcement: every outbound body must contain a working
 * unsubscribe mechanism (UNSUBSCRIBE_BASE_URL) and a physical postal address
 * (COMPANY_ADDRESS). This appends whatever is missing; it never duplicates.
 */

import type { FooterConfig } from './types.js';

export interface EnsureFooterResult {
  body: string;
  /** True if any footer content was appended. */
  added: boolean;
  /** True if the resulting body contains the unsubscribe URL. */
  hasUnsubscribe: boolean;
}

/**
 * Ensure the unsubscribe URL and company postal address are present in `body`,
 * appending a footer block for whichever is missing.
 *
 * Presence is detected by substring match (case-insensitive for the address,
 * exact for the URL) so an existing, possibly-templated footer is respected.
 */
export function ensureFooter(body: string, config: FooterConfig): EnsureFooterResult {
  const original = typeof body === 'string' ? body : '';
  const unsubscribeUrl = config.unsubscribeBaseUrl;
  const companyAddress = config.companyAddress;

  const hasUnsubscribeAlready = original.includes(unsubscribeUrl);
  const hasAddressAlready =
    companyAddress.trim().length > 0 &&
    original.toLowerCase().includes(companyAddress.trim().toLowerCase());

  const missingPieces: string[] = [];
  if (!hasUnsubscribeAlready) {
    missingPieces.push(`Unsubscribe: ${unsubscribeUrl}`);
  }
  if (!hasAddressAlready && companyAddress.trim().length > 0) {
    missingPieces.push(companyAddress.trim());
  }

  if (missingPieces.length === 0) {
    return { body: original, added: false, hasUnsubscribe: true };
  }

  // Separate the appended footer from the body with a blank line + rule.
  const separator = original.length > 0 ? '\n\n--\n' : '';
  const footer = missingPieces.join('\n');
  const newBody = `${original}${separator}${footer}`;

  return {
    body: newBody,
    added: true,
    hasUnsubscribe: hasUnsubscribeAlready || newBody.includes(unsubscribeUrl),
  };
}
