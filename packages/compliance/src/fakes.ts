/**
 * In-memory fakes implementing the narrow repo interfaces, for unit tests.
 * (Exported from the package so workflow/integration tests can reuse them; they
 * touch NO database.)
 */

import type {
  AddSuppressionInput,
  SendCountRepo,
  SuppressionEntryLike,
  SuppressionRepo,
} from './types.js';
import { extractDomain } from './email.js';

/** In-memory {@link SuppressionRepo} backed by two maps, for unit tests. */
export class FakeSuppressionRepo implements SuppressionRepo {
  private byEmail = new Map<string, SuppressionEntryLike>();
  private byDomain = new Map<string, SuppressionEntryLike>();

  /** Look up a suppression entry by normalized email. */
  async findByEmail(email: string): Promise<SuppressionEntryLike | null> {
    return this.byEmail.get(email.trim().toLowerCase()) ?? null;
  }
  /** Look up a suppression entry by normalized domain. */
  async findByDomain(domain: string): Promise<SuppressionEntryLike | null> {
    return this.byDomain.get(domain.trim().toLowerCase()) ?? null;
  }
  /** Store/replace an entry keyed by its email and/or domain (idempotent). */
  async upsert(input: AddSuppressionInput): Promise<SuppressionEntryLike> {
    const email = input.email?.trim().toLowerCase() ?? null;
    const domain = input.domain?.trim().toLowerCase() ?? null;
    const entry: SuppressionEntryLike = {
      email,
      domain,
      reason: input.reason,
      source: input.source,
      notes: input.notes ?? null,
    };
    if (email) this.byEmail.set(email, entry);
    if (domain) this.byDomain.set(domain, entry);
    return entry;
  }

  /** Total stored unique keys (for idempotency assertions in tests). */
  get size(): number {
    return this.byEmail.size + this.byDomain.size;
  }
}

/** Preset counts the {@link FakeSendCountRepo} returns for each cap query. */
export interface FakeSendCounts {
  global?: number;
  inbox?: Record<string, number>;
  domain?: Record<string, number>;
  sequenceSteps?: Record<string, number>;
  /** All-time sends per prospectId. */
  prospectTotal?: Record<string, number>;
}

/** In-memory {@link SendCountRepo} returning preset counts, for unit tests. */
export class FakeSendCountRepo implements SendCountRepo {
  constructor(private counts: FakeSendCounts = {}) {}

  /** Preset global 24h send count. */
  async countGlobalSentLast24h(): Promise<number> {
    return this.counts.global ?? 0;
  }
  /** Preset 24h send count for a specific inbox. */
  async countByInboxLast24h(fromEmail: string): Promise<number> {
    return this.counts.inbox?.[fromEmail.trim().toLowerCase()] ?? 0;
  }
  /** Preset 24h send count for a specific recipient domain. */
  async countByDomainLast24h(domain: string): Promise<number> {
    const d = domain.trim().toLowerCase();
    return this.counts.domain?.[d] ?? 0;
  }
  /** Preset sequence-step count, keyed by `prospectId:sequenceId` then prospectId. */
  async countSequenceStepsSent(prospectId: string, sequenceId?: string): Promise<number> {
    const key = sequenceId ? `${prospectId}:${sequenceId}` : prospectId;
    return this.counts.sequenceSteps?.[key] ?? this.counts.sequenceSteps?.[prospectId] ?? 0;
  }
  /** Preset all-time send count for a prospect. */
  async countProspectSentTotal(prospectId: string): Promise<number> {
    return this.counts.prospectTotal?.[prospectId] ?? 0;
  }
}

/** Convenience for tests: derive a domain or fail loudly. */
export function domainOf(email: string): string {
  const d = extractDomain(email);
  if (!d) throw new Error(`bad test email: ${email}`);
  return d;
}
