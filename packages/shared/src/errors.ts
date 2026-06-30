/**
 * Typed error hierarchy. Every error carries a stable machine-readable `code`
 * and an HTTP status, plus optional structured `details`. The `name` field acts
 * as the discriminant for narrowing.
 */

export type ErrorCode =
  | 'APP_ERROR'
  | 'VALIDATION_ERROR'
  | 'POLICY_VIOLATION'
  | 'ESCALATION'
  | 'NOT_FOUND'
  | 'PROVIDER_ERROR'
  | 'IDEMPOTENCY_ERROR';

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    // Restore prototype chain (TS target ES2022 extends built-in Error).
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.details = details;
  }

  toJSON(): { name: string; code: ErrorCode; httpStatus: number; message: string; details?: unknown } {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      message: this.message,
      details: this.details,
    };
  }
}

/** Input/schema validation failed. */
export class ValidationError extends AppError {
  override readonly name = 'ValidationError';
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
}

/** A safety/compliance policy was violated (e.g. suppression, send cap). */
export class PolicyViolationError extends AppError {
  override readonly name = 'PolicyViolationError';
  readonly code = 'POLICY_VIOLATION';
  readonly httpStatus = 422;
}

/** Work must be handed off to a human; not an automated failure. */
export class EscalationError extends AppError {
  override readonly name = 'EscalationError';
  readonly code = 'ESCALATION';
  readonly httpStatus = 409;
}

/** A requested entity does not exist. */
export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
}

/** An upstream provider (LLM, email, calendar, research) failed. */
export class ProviderError extends AppError {
  override readonly name = 'ProviderError';
  readonly code = 'PROVIDER_ERROR';
  readonly httpStatus = 502;
}

/** A duplicate idempotent action was detected. */
export class IdempotencyError extends AppError {
  override readonly name = 'IdempotencyError';
  readonly code = 'IDEMPOTENCY_ERROR';
  readonly httpStatus = 409;
}

/** Type guard: is this value one of our AppError subclasses? */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
