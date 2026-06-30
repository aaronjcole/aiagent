import { describe, expect, it } from 'vitest';
import { EscalationError, OutreachDraftSchema, type OutreachDraft } from '@app/shared';
import { runStructured } from './client.js';
import type { LlmProvider, RawCompleteRequest, RawCompleteResult } from './types.js';

const validDraft: OutreachDraft = {
  subject: 'Hi',
  body: 'Hello there, would you like to chat?',
  personalizationUsed: ['point a'],
  callToAction: 'Reply to book a call',
  unsupportedClaims: [],
  confidence: 0.8,
  riskFlags: [],
};

/** A scripted provider that returns a queued sequence of raw texts. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'scripted';
  calls = 0;
  constructor(private readonly responses: string[]) {}
  rawComplete(_req: RawCompleteRequest): Promise<RawCompleteResult> {
    const idx = Math.min(this.calls, this.responses.length - 1);
    this.calls += 1;
    const text = this.responses[idx] ?? '';
    return Promise.resolve({ text, usage: null });
  }
}

describe('runStructured repair loop', () => {
  it('repairs once: bad JSON then good JSON → repaired=true, attempts=2', async () => {
    const provider = new ScriptedProvider(['not json at all {', JSON.stringify(validDraft)]);
    const res = await runStructured(provider, {
      system: 'draft an email',
      input: { x: 1 },
      schema: OutreachDraftSchema,
    });
    expect(res.attempts).toBe(2);
    expect(res.repaired).toBe(true);
    expect(res.parsed.subject).toBe('Hi');
    expect(provider.calls).toBe(2);
  });

  it('repairs a schema violation (missing field) then succeeds', async () => {
    const partial = { subject: 'Hi', body: 'x' }; // missing required fields
    const provider = new ScriptedProvider([JSON.stringify(partial), JSON.stringify(validDraft)]);
    const res = await runStructured(provider, {
      system: 'draft an email',
      input: { x: 1 },
      schema: OutreachDraftSchema,
    });
    expect(res.attempts).toBe(2);
    expect(res.repaired).toBe(true);
  });

  it('escalates after exhausting repairs when output is always bad', async () => {
    const provider = new ScriptedProvider(['{bad', '{still bad', '{nope']);
    await expect(
      runStructured(provider, {
        system: 'draft an email',
        input: { x: 1 },
        schema: OutreachDraftSchema,
      }),
    ).rejects.toBeInstanceOf(EscalationError);
    // first try + 2 repairs = 3 calls
    expect(provider.calls).toBe(3);
  });

  it('escalation error carries validation errors and is the typed class', async () => {
    const provider = new ScriptedProvider(['{bad']);
    try {
      await runStructured(provider, {
        system: 's',
        input: {},
        schema: OutreachDraftSchema,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EscalationError);
      const e = err as EscalationError;
      const details = e.details as { validationErrors: unknown[]; attempts: number };
      expect(Array.isArray(details.validationErrors)).toBe(true);
      expect(details.attempts).toBeGreaterThanOrEqual(1);
    }
  });

  it('succeeds on first try with attempts=1, repaired=false', async () => {
    const provider = new ScriptedProvider([JSON.stringify(validDraft)]);
    const res = await runStructured(provider, {
      system: 's',
      input: {},
      schema: OutreachDraftSchema,
    });
    expect(res.attempts).toBe(1);
    expect(res.repaired).toBe(false);
  });
});
