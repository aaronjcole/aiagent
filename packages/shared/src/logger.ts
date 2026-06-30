import { pino, type Logger, type LoggerOptions } from 'pino';

/** Keys whose values must never be logged. */
const SECRET_KEY_PATTERN = /key|token|secret|password|authorization|cookie|refresh/i;

const REDACTED = '[REDACTED]';

/**
 * Recursively clone `value`, replacing any value whose key matches the secret
 * pattern with `[REDACTED]`. Safe against cycles. Use before logging arbitrary
 * objects that might contain credentials.
 */
export function redact<T>(value: T): T {
  return redactInternal(value, new WeakSet()) as T;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactInternal(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactInternal(val, seen);
    }
  }
  return out;
}

/**
 * Create a structured pino logger bound to a component `name`. Redaction of
 * common secret keys is configured at the pino level as defense-in-depth; the
 * `redact()` helper above should still be used for ad-hoc objects.
 */
export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  return pino({
    name,
    level,
    redact: {
      paths: [
        'password',
        'token',
        'secret',
        'authorization',
        'cookie',
        'refreshToken',
        '*.password',
        '*.token',
        '*.secret',
        '*.authorization',
        '*.cookie',
        '*.apiKey',
        '*.refreshToken',
      ],
      censor: REDACTED,
    },
    ...options,
  });
}

export type { Logger } from 'pino';
