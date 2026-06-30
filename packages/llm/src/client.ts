import { ZodError, type SafeParseReturnType } from 'zod';
import { EscalationError, type Logger } from '@app/shared';
import { redactRaw } from './redact.js';
import type {
  LlmProvider,
  LlmResult,
  RawCompleteRequest,
  StructuredRequest,
} from './types.js';

/** Default max repair attempts (in addition to the first try). */
const DEFAULT_MAX_REPAIRS = 2;

/** Strip a leading/trailing markdown code fence if the model wrapped its JSON. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  // Remove the opening fence (optionally ```json) and the trailing fence.
  return trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

/** Outcome of attempting to parse + validate one raw response. */
type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'parse' | 'schema'; errorText: string; repairable: boolean };

function tryParseAndValidate<T>(
  raw: string,
  schema: StructuredRequest<T>['schema'],
): AttemptOutcome<T> {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    return {
      ok: false,
      kind: 'parse',
      errorText: err instanceof Error ? err.message : String(err),
      // Invalid JSON is clearly repairable.
      repairable: true,
    };
  }

  const result: SafeParseReturnType<unknown, T> = schema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  const zerr: ZodError = result.error;
  return {
    ok: false,
    kind: 'schema',
    errorText: JSON.stringify(zerr.issues),
    // Treat field-level violations (missing/invalid fields) as repairable.
    repairable: zerr.issues.length > 0,
  };
}

/** Build a repair instruction appended to the system prompt for a retry. */
function buildRepairSystem(baseSystem: string, kind: 'parse' | 'schema', errorText: string): string {
  const label = kind === 'parse' ? 'JSON parse error' : 'schema validation error';
  return `${baseSystem}

Your previous response could not be used. ${label}:
${errorText}

Return the corrected JSON only — a single valid JSON object that satisfies the schema, with no markdown fences and no commentary.`;
}

/**
 * Provider-agnostic structured-output runner. Calls `provider.rawComplete`,
 * parses JSON, validates against `req.schema`. On parse OR schema failure it
 * retries with a repair prompt carrying the exact error. A second repair is
 * allowed only when the failure looks clearly repairable. After the configured
 * number of failed repairs it throws {@link EscalationError} carrying the
 * collected validation errors. Tracks `attempts` and `repaired`, and logs
 * redacted usage/raw via the supplied logger.
 */
export async function runStructured<T>(
  provider: LlmProvider,
  req: StructuredRequest<T>,
  logger?: Logger,
): Promise<LlmResult<T>> {
  const model = req.model ?? provider.model;
  const maxRepairs = req.retry?.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const start = Date.now();

  let system = req.system;
  let attempts = 0;
  let lastRaw = '';
  const errors: { attempt: number; kind: 'parse' | 'schema'; error: string }[] = [];

  // attempt 0 = first try; subsequent = repairs. Loop runs 1 + maxRepairs times max.
  for (let repair = 0; repair <= maxRepairs; repair += 1) {
    const rawReq: RawCompleteRequest = {
      model,
      system,
      input: req.input,
      timeoutMs: req.timeoutMs,
      agentType: req.agentType,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    };

    const { text, usage } = await provider.rawComplete(rawReq);
    attempts += 1;
    lastRaw = text;

    const outcome = tryParseAndValidate(text, req.schema);
    const rawRedacted = redactRaw(text);

    if (outcome.ok) {
      const latencyMs = Date.now() - start;
      const repaired = repair > 0;
      logger?.info(
        {
          provider: provider.name,
          model,
          agentType: req.agentType,
          attempts,
          repaired,
          latencyMs,
          usage,
          rawRedacted,
        },
        'llm structured completion ok',
      );
      return {
        parsed: outcome.value,
        rawRedacted,
        usage,
        attempts,
        provider: provider.name,
        model,
        latencyMs,
        repaired,
      };
    }

    errors.push({ attempt: attempts, kind: outcome.kind, error: outcome.errorText });
    logger?.warn(
      {
        provider: provider.name,
        model,
        agentType: req.agentType,
        attempt: attempts,
        kind: outcome.kind,
        error: outcome.errorText,
        rawRedacted,
      },
      'llm structured completion invalid; will attempt repair if budget remains',
    );

    // Stop early if this failure is not clearly repairable and we've already
    // burned the first repair (i.e. don't spend the SECOND repair blindly).
    if (!outcome.repairable && repair >= 1) {
      break;
    }

    system = buildRepairSystem(req.system, outcome.kind, outcome.errorText);
  }

  // Exhausted attempts — hand off to a human.
  const latencyMs = Date.now() - start;
  logger?.error(
    {
      provider: provider.name,
      model,
      agentType: req.agentType,
      attempts,
      latencyMs,
      validationErrors: errors,
      rawRedacted: redactRaw(lastRaw),
    },
    'llm structured completion failed after repairs; escalating',
  );
  throw new EscalationError('LLM produced invalid output after repair attempts', {
    provider: provider.name,
    model,
    agentType: req.agentType,
    attempts,
    validationErrors: errors,
    rawRedacted: redactRaw(lastRaw),
  });
}

/**
 * Thin convenience wrapper binding a provider (and optional logger) so callers
 * can repeatedly issue structured requests via `.structured(req)`.
 */
export class LlmClient {
  constructor(
    readonly provider: LlmProvider,
    private readonly logger?: Logger,
  ) {}

  get name(): string {
    return this.provider.name;
  }

  get model(): string {
    return this.provider.model;
  }

  structured<T>(req: StructuredRequest<T>): Promise<LlmResult<T>> {
    return runStructured(this.provider, req, this.logger);
  }
}
