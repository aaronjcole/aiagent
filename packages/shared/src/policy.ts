/**
 * Shared `PolicyDecision` shape + tiny combinators used by the deterministic
 * policy layer in `@app/compliance`.
 *
 * A `PolicyDecision` is allow/deny plus the FULL list of reasons (denials
 * accumulate every failing gate, not just the first). These helpers keep the
 * policy services consistent and composable.
 */

/** Allow/deny verdict plus the human-readable reasons behind it. */
export interface PolicyDecision {
  allow: boolean;
  /** When denied: every failing reason. When allowed: usually empty. */
  reasons: string[];
}

/** An allowing decision (optionally annotated, e.g. for auditing). */
export function allowed(...reasons: string[]): PolicyDecision {
  return { allow: true, reasons };
}

/** A denying decision carrying one or more failure reasons. */
export function denied(...reasons: string[]): PolicyDecision {
  return { allow: false, reasons };
}

/**
 * Combine decisions: allow ONLY if every input allows; reasons are concatenated
 * (preserving order). An empty input list is vacuously allowed.
 */
export function combine(...decisions: PolicyDecision[]): PolicyDecision {
  const reasons: string[] = [];
  let allow = true;
  for (const d of decisions) {
    if (!d.allow) allow = false;
    reasons.push(...d.reasons);
  }
  return { allow, reasons };
}
