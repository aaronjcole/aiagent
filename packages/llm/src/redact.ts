/** Maximum length of a redacted raw response we keep for logging/persistence. */
export const MAX_RAW_LENGTH = 4096;

/**
 * Patterns for secret-looking substrings in a raw model response. We never
 * persist raw provider output verbatim; we strip obvious credentials and
 * truncate.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI-style keys.
  /sk-[A-Za-z0-9_-]{16,}/g,
  // Anthropic-style keys.
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  // Bearer tokens.
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
  // JSON-ish "apiKey"/"token"/"secret"/"password" values.
  /("?(?:api[_-]?key|token|secret|password|authorization|refresh[_-]?token)"?\s*[:=]\s*")[^"]+(")/gi,
];

const REDACTED = '[REDACTED]';

/**
 * Produce a short, secret-stripped version of a raw model response, safe to log
 * or persist as `AgentRun.rawResponseRedacted`. Strips secret-looking tokens
 * and truncates to {@link MAX_RAW_LENGTH} characters.
 */
export function redactRaw(raw: string): string {
  let out = raw;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, p1?: string, p2?: string) =>
      p1 !== undefined && p2 !== undefined ? `${p1}${REDACTED}${p2}` : REDACTED,
    );
  }
  if (out.length > MAX_RAW_LENGTH) {
    out = `${out.slice(0, MAX_RAW_LENGTH)}…[truncated ${out.length - MAX_RAW_LENGTH} chars]`;
  }
  return out;
}
