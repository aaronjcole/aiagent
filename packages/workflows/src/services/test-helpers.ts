/**
 * In-memory fakes for unit-testing the services with NO Temporal, NO real DB,
 * and NO network. A `FakePrisma` records rows for the handful of delegates the
 * services touch and answers the specific queries they make.
 */

import { createLogger, loadConfig, newId, type Config } from '@app/shared';
import { MockLlmProvider, LlmClient, type LlmProvider } from '@app/llm';
import { MockEmailProvider } from '@app/email';
import { MockCalendarProvider } from '@app/calendar';
import { asPrisma, type Deps } from '../deps.js';
import { MockResearchProvider } from '../providers/research.js';

const silentLogger = createLogger('test', { level: 'silent' });

/** A simple typed table keyed by id with optional secondary lookups. */
class Table<T extends { id: string }> {
  rows: T[] = [];
  insert(row: T): T {
    this.rows.push(row);
    return row;
  }
  find(pred: (r: T) => boolean): T | undefined {
    return this.rows.find(pred);
  }
  filter(pred: (r: T) => boolean): T[] {
    return this.rows.filter(pred);
  }
}

interface Row {
  id: string;
  [k: string]: unknown;
}

/**
 * A minimal in-memory Prisma double. Only implements the delegate methods the
 * services call. Each table is inspectable for assertions.
 */
export class FakePrisma {
  prospect = new Table<Row>();
  company = new Table<Row>();
  researchResult = new Table<Row>();
  emailThread = new Table<Row>();
  emailMessage = new Table<Row>();
  outreachSequence = new Table<Row>();
  draftEmail = new Table<Row>();
  approvalItem = new Table<Row>();
  calendarEvent = new Table<Row>();
  suppressionEntry = new Table<Row>();
  agentRun = new Table<Row>();
  auditLog = new Table<Row>();
  systemSetting = new Table<Row>();

  /** Expose Prisma-delegate-shaped objects. */
  get client(): Record<string, unknown> {
    return {
      prospect: this.delegate(this.prospect, 'prospect'),
      company: this.delegate(this.company, 'company'),
      researchResult: this.delegate(this.researchResult, 'research'),
      emailThread: this.delegate(this.emailThread, 'thread'),
      emailMessage: this.delegate(this.emailMessage, 'msg'),
      outreachSequence: this.delegate(this.outreachSequence, 'seq'),
      draftEmail: this.delegate(this.draftEmail, 'draft'),
      approvalItem: this.delegate(this.approvalItem, 'approval'),
      calendarEvent: this.delegate(this.calendarEvent, 'event'),
      suppressionEntry: this.delegate(this.suppressionEntry, 'sup'),
      agentRun: this.delegate(this.agentRun, 'run'),
      auditLog: this.delegate(this.auditLog, 'audit'),
      systemSetting: this.delegate(this.systemSetting, 'setting'),
    };
  }

  private matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'not' in (v as object)) {
        return row[k] !== (v as { not: unknown }).not;
      }
      return row[k] === v;
    });
  }

  private delegate(table: Table<Row>, prefix: string) {
    const matches = this.matches.bind(this);
    return {
      findUnique: async ({ where, include, select }: { where: Record<string, unknown>; include?: unknown; select?: unknown }) => {
        const found = table.find((r) => matches(r, where));
        return found ? this.withInclude(found, include, select) : null;
      },
      findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }) => {
        let rows = where ? table.filter((r) => matches(r, where)) : [...table.rows];
        if (orderBy) {
          const entry = Object.entries(orderBy)[0];
          const key = entry?.[0] ?? 'createdAt';
          const dir = entry?.[1] ?? 'asc';
          rows = rows.sort((a, b) => {
            const av = Number(a[key] ?? 0);
            const bv = Number(b[key] ?? 0);
            return dir === 'desc' ? bv - av : av - bv;
          });
        }
        return rows[0] ?? null;
      },
      create: async ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
        const row: Row = { id: data.id as string ?? newId(prefix), createdAt: this.now(), ...data };
        table.insert(row);
        return this.project(row, select);
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = table.find((r) => matches(r, where));
        if (!row) throw new Error(`${prefix} update: row not found`);
        Object.assign(row, data);
        return row;
      },
      upsert: async ({ where, create, update, select }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown>; select?: unknown }) => {
        const existing = table.find((r) => matches(r, where));
        if (existing) {
          Object.assign(existing, update);
          return this.project(existing, select);
        }
        const row: Row = { id: (create.id as string) ?? newId(prefix), createdAt: this.now(), ...create };
        table.insert(row);
        return this.project(row, select);
      },
      count: async ({ where }: { where?: Record<string, unknown> }) => {
        return where ? table.filter((r) => matches(r, where)).length : table.rows.length;
      },
    };
  }

  private now(): Date {
    return new Date('2026-06-30T12:00:00.000Z');
  }

  private withInclude(row: Row, include: unknown, select: unknown): Row {
    let out: Row = { ...row };
    if (include && typeof include === 'object' && (include as Record<string, unknown>).company) {
      const companyId = row.companyId as string | undefined;
      out.company = companyId ? this.company.find((c) => c.id === companyId) ?? null : null;
    }
    if (select) out = this.project(out, select) as Row;
    return out;
  }

  private project(row: Row, select: unknown): Row {
    if (!select || typeof select !== 'object') return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select as Record<string, unknown>)) {
      if (v) out[k] = row[k];
    }
    return out as Row;
  }
}

/** Options for {@link makeDeps}. */
export interface MakeDepsOptions {
  config?: Partial<Config>;
  llmProvider?: LlmProvider;
  clockIso?: string;
}

/** Build a {@link Deps} backed by in-memory fakes + the deterministic mocks. */
export function makeDeps(prisma: FakePrisma, options: MakeDepsOptions = {}): Deps {
  const baseConfig = loadConfig({});
  const config: Config = { ...baseConfig, ...options.config };
  const clockDate = new Date(options.clockIso ?? '2026-06-30T12:00:00.000Z');
  const clock = (): Date => clockDate;
  const provider = options.llmProvider ?? new MockLlmProvider();
  return {
    config,
    logger: silentLogger,
    clock,
    prisma: asPrisma(prisma.client),
    llmClient: new LlmClient(provider, silentLogger),
    email: new MockEmailProvider({ logger: silentLogger, clock }),
    calendar: new MockCalendarProvider({}, silentLogger),
    research: new MockResearchProvider(),
  };
}

/** An LLM provider that always throws after exhausting repairs → EscalationError. */
export class FailingLlmProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-fail';
  rawComplete(): Promise<{ text: string; usage: null }> {
    // Always-invalid JSON forces the repair loop to exhaust and escalate.
    return Promise.resolve({ text: 'not json at all', usage: null });
  }
}

/** An LLM provider returning a fixed payload for a given agent type. */
export class FixedLlmProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-fixed';
  constructor(private readonly payloadByAgent: Record<string, unknown>) {}
  rawComplete(req: { agentType?: string }): Promise<{ text: string; usage: null }> {
    const key = req.agentType ?? '';
    const payload = this.payloadByAgent[key];
    return Promise.resolve({ text: JSON.stringify(payload ?? {}), usage: null });
  }
}
